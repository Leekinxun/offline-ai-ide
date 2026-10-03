use crate::{
    error::{CoreError, Result},
    workspace::{Workspace, MAX_FILE_BYTES},
};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use ignore::{overrides::OverrideBuilder, WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub workspace_dir: String,
    pub query: String,
    #[serde(default)]
    pub scope_path: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub include: String,
    #[serde(default)]
    pub exclude: String,
    #[serde(default = "default_ignore")]
    pub use_ignore_files: bool,
    #[serde(default = "default_limit")]
    pub max_results: usize,
}

fn default_ignore() -> bool {
    true
}
fn default_limit() -> usize {
    1000
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub match_length: usize,
    pub preview: String,
}

#[derive(Serialize, Default, Debug)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub truncated: bool,
}

fn split_globs(value: &str) -> Vec<String> {
    let mut patterns = Vec::new();
    let (mut braces, mut brackets) = (0usize, 0usize);
    let mut current = String::new();
    for character in value.chars() {
        match character {
            '{' => braces += 1,
            '}' => braces = braces.saturating_sub(1),
            '[' => brackets += 1,
            ']' => brackets = brackets.saturating_sub(1),
            ',' if braces == 0 && brackets == 0 => {
                if !current.trim().is_empty() {
                    patterns.push(current.trim().to_owned());
                }
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(character);
    }
    if !current.trim().is_empty() {
        patterns.push(current.trim().to_owned());
    }
    patterns
}

// Keep the existing search context-path policy, independent of Agent file-write permissions.
fn allowed_context_path(path: &str) -> bool {
    let protected = [
        ".git",
        ".history",
        ".checkpoints",
        ".team",
        ".tasks",
        ".transcripts",
        ".codex",
        ".omx",
        ".crewforge",
        ".svn",
        ".hg",
    ];
    let generated = [
        "node_modules",
        "dist",
        "build",
        "coverage",
        "out",
        "target",
        "vendor",
        "venv",
        ".venv",
        "__pycache__",
        ".next",
        ".nuxt",
    ];
    if path
        .split('/')
        .any(|segment| protected.contains(&segment) || generated.contains(&segment))
    {
        return false;
    }
    let filename = path.rsplit('/').next().unwrap_or("");
    if ["users.json", "app-settings.json"].contains(&filename) {
        return false;
    }
    let lower = filename.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return false;
    }
    let secret_name = lower.contains("credentials") || lower.contains("secret");
    if secret_name
        && [".json", ".yaml", ".yml", ".toml", ".ini"]
            .iter()
            .any(|extension| lower.ends_with(extension))
    {
        return false;
    }
    ![".min.js", ".min.css", ".map", ".lock"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn utf16_length(bytes: &[u8]) -> usize {
    String::from_utf8_lossy(bytes).encode_utf16().count()
}

fn preview(line: &[u8]) -> String {
    let line = String::from_utf8_lossy(line);
    let line = line.trim_end_matches(['\r', '\n']);
    let mut used = 0;
    line.chars()
        .take_while(|character| {
            used += character.len_utf16();
            used <= 1000
        })
        .collect()
}

pub fn search(params: SearchParams, cancelled: Arc<AtomicBool>) -> Result<SearchResponse> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(CoreError::aborted());
    }
    let workspace = Arc::new(Workspace::open(&params.workspace_dir)?);
    let scope = workspace.resolve(&params.scope_path)?;
    let limit = params.max_results.clamp(1, 5000);
    let matcher = RegexMatcherBuilder::new()
        .fixed_strings(!params.is_regex)
        .case_insensitive(!params.match_case)
        .word(params.whole_word)
        .line_terminator(Some(b'\n'))
        .build(&params.query)
        .map_err(|error| CoreError::invalid(format!("Invalid search pattern: {error}")))?;
    let mut overrides = OverrideBuilder::new(workspace.root());
    for pattern in ["!.git", "!.svn", "!.hg"] {
        overrides
            .add(pattern)
            .map_err(|error| CoreError::invalid(error.to_string()))?;
    }
    for pattern in split_globs(&params.include) {
        overrides
            .add(&pattern)
            .map_err(|error| CoreError::invalid(error.to_string()))?;
    }
    for pattern in split_globs(&params.exclude) {
        overrides
            .add(&format!("!{}", pattern.trim_start_matches('!')))
            .map_err(|error| CoreError::invalid(error.to_string()))?;
    }
    let mut builder = WalkBuilder::new(scope);
    builder
        .standard_filters(params.use_ignore_files)
        .hidden(false)
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_BYTES))
        .current_dir(workspace.root())
        .add_custom_ignore_filename(".rgignore")
        .overrides(
            overrides
                .build()
                .map_err(|error| CoreError::invalid(error.to_string()))?,
        )
        .threads(
            std::thread::available_parallelism()
                .map(|value| value.get().min(4))
                .unwrap_or(2),
        );
    let filtered_workspace = workspace.clone();
    builder.filter_entry(move |entry| {
        entry.depth() == 0
            || filtered_workspace
                .relative(entry.path())
                .map(|path| allowed_context_path(&path))
                .unwrap_or(false)
    });
    let response = Arc::new(Mutex::new(SearchResponse::default()));
    let failure = Arc::new(Mutex::new(None));
    builder.build_parallel().run(|| {
        let matcher = matcher.clone();
        let workspace = workspace.clone();
        let response = response.clone();
        let failure = failure.clone();
        let cancelled = cancelled.clone();
        Box::new(move |entry| {
            if cancelled.load(Ordering::Relaxed)
                || response.lock().unwrap().truncated
                || failure.lock().unwrap().is_some()
            {
                return WalkState::Quit;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    *failure.lock().unwrap() = Some(CoreError::failed(error.to_string()));
                    return WalkState::Quit;
                }
            };
            if !entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
            {
                return WalkState::Continue;
            }
            let relative = match workspace.relative(entry.path()) {
                Some(relative) if allowed_context_path(&relative) => relative,
                _ => return WalkState::Continue,
            };
            // Recheck the canonical scope immediately before opening a traversed file.
            let full_path = match workspace.resolve(&relative) {
                Ok(path) => path,
                Err(_) => return WalkState::Continue,
            };
            let mut file = match workspace.open_file(&full_path) {
                Ok(file) => file,
                Err(_) => return WalkState::Continue,
            };
            if file
                .metadata()
                .map(|metadata| !metadata.is_file() || metadata.len() > MAX_FILE_BYTES)
                .unwrap_or(true)
            {
                return WalkState::Continue;
            }
            let mut bytes = Vec::new();
            if (&mut file)
                .take(MAX_FILE_BYTES + 1)
                .read_to_end(&mut bytes)
                .is_err()
                || bytes.len() as u64 > MAX_FILE_BYTES
                || bytes.contains(&0)
            {
                return WalkState::Continue;
            }
            for (index, line) in bytes.split_inclusive(|byte| *byte == b'\n').enumerate() {
                if cancelled.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let result = matcher.find_iter(line, |matched| {
                    if cancelled.load(Ordering::Relaxed) {
                        return false;
                    }
                    let mut response = response.lock().unwrap();
                    if response.results.len() >= limit {
                        response.truncated = true;
                        return false;
                    }
                    response.results.push(SearchResult {
                        path: relative.clone(),
                        line: index + 1,
                        column: utf16_length(&line[..matched.start()]) + 1,
                        match_length: utf16_length(&line[matched.start()..matched.end()]).max(1),
                        preview: preview(line),
                    });
                    true
                });
                if let Err(error) = result {
                    *failure.lock().unwrap() = Some(CoreError::failed(error.to_string()));
                    return WalkState::Quit;
                }
                if response.lock().unwrap().truncated {
                    return WalkState::Quit;
                }
            }
            WalkState::Continue
        })
    });
    if cancelled.load(Ordering::Relaxed) {
        return Err(CoreError::aborted());
    }
    if let Some(error) = failure.lock().unwrap().take() {
        return Err(error);
    }
    let mut response = std::mem::take(&mut *response.lock().unwrap());
    response.results.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.line.cmp(&right.line))
            .then(left.column.cmp(&right.column))
    });
    Ok(response)
}
