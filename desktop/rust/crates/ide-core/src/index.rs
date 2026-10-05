use crate::{
    error::{CoreError, Result},
    file_identity::{directory_identity, FileIdentity},
    workspace::Workspace,
};
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

const MAX_INDEXED_FILES: usize = 250_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_BATCH_CONTENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PAGE_SIZE: usize = 1000;
const MAX_SESSIONS: usize = 32;
const SESSION_LIFETIME: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct Indexes {
    sessions: Mutex<HashMap<String, Arc<ScanSession>>>,
}

struct ScanSession {
    workspace_root: PathBuf,
    workspace_identity: FileIdentity,
    policy_fingerprint: String,
    entries: Vec<IndexEntry>,
    paths: HashMap<String, usize>,
    created: Instant,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    path: String,
    size: u64,
    mtime_ms: f64,
    content_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanParams {
    workspace_dir: String,
    #[serde(default)]
    prefix: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResponse {
    session_id: String,
    workspace_root: String,
    policy_fingerprint: String,
    total: usize,
    truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageParams {
    session_id: String,
    #[serde(default)]
    cursor: usize,
    #[serde(default = "default_page_size")]
    limit: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResponse {
    entries: Vec<IndexEntry>,
    next_cursor: Option<usize>,
    done: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBatchParams {
    session_id: String,
    paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBatchResponse {
    files: Vec<IndexedContent>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedContent {
    path: String,
    size: u64,
    mtime_ms: f64,
    content_hash: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyParams {
    workspace_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyResponse {
    workspace_root: String,
    policy_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseParams {
    session_id: String,
}

fn default_page_size() -> usize {
    MAX_PAGE_SIZE
}

impl Indexes {
    pub fn scan(&self, params: ScanParams, cancelled: Arc<AtomicBool>) -> Result<ScanResponse> {
        let workspace = Workspace::open(&params.workspace_dir)?;
        let workspace_identity = directory_identity(workspace.root())?;
        let scope = if params.prefix.trim().is_empty() {
            workspace.root().to_path_buf()
        } else {
            workspace.resolve(&params.prefix)?
        };
        let policy_fingerprint = policy_fingerprint(&workspace)?;
        let mut entries = Vec::new();
        let mut truncated = false;
        scan_entries(&workspace, &scope, &cancelled, &mut entries, &mut truncated)?;
        if cancelled.load(Ordering::Relaxed) {
            return Err(CoreError::aborted());
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        let session_id = new_session_id(&workspace, &policy_fingerprint, &entries);
        let response = ScanResponse {
            session_id: session_id.clone(),
            workspace_root: workspace.root().to_string_lossy().into_owned(),
            policy_fingerprint: policy_fingerprint.clone(),
            total: entries.len(),
            truncated,
        };
        let paths = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| (entry.path.clone(), index))
            .collect();
        if directory_identity(workspace.root())? != workspace_identity {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Workspace root changed during index scan",
            ));
        }
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, session| session.created.elapsed() < SESSION_LIFETIME);
        if sessions.len() >= MAX_SESSIONS {
            return Err(CoreError::new("BUSY", "Index scan session limit reached"));
        }
        sessions.insert(
            session_id,
            Arc::new(ScanSession {
                workspace_root: workspace.root().to_path_buf(),
                workspace_identity,
                policy_fingerprint,
                entries,
                paths,
                created: Instant::now(),
            }),
        );
        Ok(response)
    }

    pub fn page(&self, params: PageParams) -> Result<PageResponse> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&params.session_id)
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Index scan session is closed"))?;
        validate_session(session)?;
        let limit = params.limit.clamp(1, MAX_PAGE_SIZE);
        let start = params.cursor.min(session.entries.len());
        let end = (start + limit).min(session.entries.len());
        Ok(PageResponse {
            entries: session.entries[start..end].to_vec(),
            next_cursor: (end < session.entries.len()).then_some(end),
            done: end >= session.entries.len(),
        })
    }

    pub fn read_batch(&self, params: ReadBatchParams) -> Result<ReadBatchResponse> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(&params.session_id)
            .cloned()
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Index scan session is closed"))?;
        let workspace = Workspace::open(&session.workspace_root)?;
        validate_session(&session)?;
        if workspace.root() != session.workspace_root {
            return Err(CoreError::new("PATH_ESCAPE", "Index session root changed"));
        }
        if policy_fingerprint(&workspace)? != session.policy_fingerprint {
            return Err(CoreError::new(
                "POLICY_CHANGED",
                "Index ignore policy changed during scan",
            ));
        }
        let mut files = Vec::new();
        let mut used = 0u64;
        let mut truncated = false;
        for path in params.paths {
            if used >= MAX_BATCH_CONTENT_BYTES {
                truncated = true;
                break;
            }
            let Some(index) = session.paths.get(&path) else {
                continue;
            };
            let entry = &session.entries[*index];
            if used.saturating_add(entry.size) > MAX_BATCH_CONTENT_BYTES {
                truncated = true;
                break;
            }
            match read_indexed_content(&workspace, &entry.path) {
                Ok(file) => {
                    used = used.saturating_add(file.size);
                    files.push(file);
                }
                Err(_) => continue,
            }
        }
        Ok(ReadBatchResponse { files, truncated })
    }

    pub fn policy(&self, params: PolicyParams) -> Result<PolicyResponse> {
        let workspace = Workspace::open(&params.workspace_dir)?;
        Ok(PolicyResponse {
            workspace_root: workspace.root().to_string_lossy().into_owned(),
            policy_fingerprint: policy_fingerprint(&workspace)?,
        })
    }

    pub fn close(&self, params: CloseParams) -> Result<()> {
        self.sessions.lock().unwrap().remove(&params.session_id);
        Ok(())
    }

    pub fn shutdown(&self) {
        self.sessions.lock().unwrap().clear();
    }

    pub fn discard(&self, session_id: &str) {
        self.sessions.lock().unwrap().remove(session_id);
    }
}

fn validate_session(session: &ScanSession) -> Result<()> {
    if session.created.elapsed() >= SESSION_LIFETIME {
        return Err(CoreError::new("NOT_FOUND", "Index scan session expired"));
    }
    if directory_identity(&session.workspace_root)? != session.workspace_identity {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Index workspace identity changed",
        ));
    }
    Ok(())
}

fn scan_entries(
    workspace: &Workspace,
    scope: &Path,
    cancelled: &Arc<AtomicBool>,
    entries: &mut Vec<IndexEntry>,
    truncated: &mut bool,
) -> Result<()> {
    let mut builder = WalkBuilder::new(scope);
    builder
        .standard_filters(true)
        .hidden(false)
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_BYTES))
        .current_dir(workspace.root())
        .add_custom_ignore_filename(".rgignore")
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
    let output = Mutex::new(Vec::<IndexEntry>::new());
    let failure = Mutex::new(None::<CoreError>);
    builder.build_parallel().run(|| {
        Box::new(|entry| {
            if cancelled.load(Ordering::Relaxed)
                || output.lock().unwrap().len() >= MAX_INDEXED_FILES
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
            let Some(relative) = workspace.relative(entry.path()) else {
                return WalkState::Continue;
            };
            if !allowed_context_path(&relative) {
                return WalkState::Continue;
            }
            let Ok(content) = read_indexed_content(workspace, &relative) else {
                return WalkState::Continue;
            };
            let mut output = output.lock().unwrap();
            if output.len() >= MAX_INDEXED_FILES {
                return WalkState::Quit;
            }
            output.push(IndexEntry {
                path: content.path,
                size: content.size,
                mtime_ms: content.mtime_ms,
                content_hash: content.content_hash,
            });
            WalkState::Continue
        })
    });
    if cancelled.load(Ordering::Relaxed) {
        return Err(CoreError::aborted());
    }
    if let Some(error) = failure.lock().unwrap().take() {
        return Err(error);
    }
    let mut scanned = output.into_inner().unwrap();
    *truncated = scanned.len() >= MAX_INDEXED_FILES;
    entries.append(&mut scanned);
    Ok(())
}

fn read_indexed_content(workspace: &Workspace, relative: &str) -> Result<IndexedContent> {
    if !allowed_context_path(relative) {
        return Err(CoreError::new("PATH_ESCAPE", "Path is not indexable"));
    }
    if has_symlink_component(workspace.root(), Path::new(relative)) {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Index reads cannot follow symbolic links",
        ));
    }
    let resolved = workspace.root().join(relative);
    let mut file = workspace.open_file(&resolved)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err(CoreError::failed("File is not indexable"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
        return Err(CoreError::failed("File is not indexable"));
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| CoreError::failed("File is not strict UTF-8"))?;
    let content_hash = hex_sha256(&bytes);
    let mtime_ms = file
        .metadata()?
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(IndexedContent {
        path: relative.to_owned(),
        size: metadata.len(),
        mtime_ms,
        content_hash,
        content,
    })
}

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
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
        || normalized.split('/').any(|segment| {
            segment.is_empty()
                || segment == "."
                || segment == ".."
                || protected.contains(&segment)
                || generated.contains(&segment)
        })
    {
        return false;
    }
    let filename = normalized.rsplit('/').next().unwrap_or("");
    let lower = filename.to_lowercase();
    if ["users.json", "app-settings.json"].contains(&filename)
        || lower == ".env"
        || lower.starts_with(".env.")
    {
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

fn policy_fingerprint(workspace: &Workspace) -> Result<String> {
    let mut files = Vec::new();
    let mut builder = WalkBuilder::new(workspace.root());
    builder
        .standard_filters(false)
        .hidden(false)
        .follow_links(false)
        .current_dir(workspace.root())
        .threads(1);
    builder.filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        let name = entry.file_name().to_string_lossy();
        !matches!(
            name.as_ref(),
            ".git"
                | ".history"
                | ".checkpoints"
                | ".team"
                | ".codex"
                | ".omx"
                | ".crewforge"
                | "node_modules"
                | "dist"
                | "build"
                | "coverage"
                | "target"
                | "vendor"
        )
    });
    for entry in builder.build() {
        let entry = entry.map_err(|error| CoreError::failed(error.to_string()))?;
        if !entry
            .file_type()
            .map(|kind| kind.is_file() || kind.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        let Some(relative) = workspace.relative(entry.path()) else {
            continue;
        };
        let name = relative.rsplit('/').next().unwrap_or("");
        if matches!(name, ".gitignore" | ".ignore" | ".rgignore") {
            files.push((relative, entry.path().to_path_buf()));
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hash = Sha256::new();
    for (relative, path) in files {
        hash.update(relative.as_bytes());
        hash.update(b"\0");
        hash_policy_file(&mut hash, &path);
        hash.update(b"\0");
    }
    hash.update(b"git-info-exclude\0");
    if let Some(exclude) = git_info_exclude_path(workspace.root()) {
        hash.update(exclude.to_string_lossy().as_bytes());
        hash.update(b"\0");
        hash_policy_file(&mut hash, &exclude);
    } else {
        hash.update(b"unavailable");
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn hash_policy_file(hash: &mut Sha256, path: &Path) {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            hash.update(b"unsafe")
        }
        Ok(metadata) if metadata.len() <= MAX_FILE_BYTES => match fs::read(path) {
            Ok(bytes) => hash.update(bytes),
            Err(_) => hash.update(b"unreadable"),
        },
        Ok(metadata) => {
            hash.update(format!("{}:", metadata.len()).as_bytes());
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                    hash.update(duration.as_millis().to_string().as_bytes());
                }
            }
        }
        Err(_) => hash.update(b"missing"),
    }
}

fn git_info_exclude_path(workspace_root: &Path) -> Option<PathBuf> {
    let workspace_root = fs::canonicalize(workspace_root).ok()?;
    let dot_git = workspace_root.join(".git");
    let dot_git_meta = fs::symlink_metadata(&dot_git).ok()?;
    let (git_dir, common_root) = if dot_git_meta.is_dir() && !dot_git_meta.file_type().is_symlink()
    {
        let git_dir = fs::canonicalize(&dot_git).ok()?;
        (git_dir.clone(), git_dir)
    } else if dot_git_meta.is_file() && !dot_git_meta.file_type().is_symlink() {
        let pointer = read_git_pointer(&dot_git)?;
        let target = pointer.strip_prefix("gitdir:")?.trim();
        if target.is_empty() {
            return None;
        }
        let git_dir = fs::canonicalize(dot_git.parent()?.join(target)).ok()?;
        let common_pointer = read_git_pointer(&git_dir.join("commondir"))?;
        let common_root = fs::canonicalize(git_dir.join(common_pointer.trim())).ok()?;
        if !is_within(&workspace_root, &common_root)
            && !is_canonical_linked_worktree(&workspace_root, &common_root, &git_dir)
        {
            return None;
        }
        (git_dir, common_root)
    } else {
        return None;
    };
    let _ = git_dir;
    let exclude = common_root.join("info").join("exclude");
    if !is_within(&common_root, &exclude)
        || has_symlink_component(&common_root, Path::new("info/exclude"))
    {
        return None;
    }
    Some(exclude)
}

fn read_git_pointer(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 16 * 1024 {
        return None;
    }
    let value = fs::read_to_string(path).ok()?.trim().to_owned();
    if value.is_empty() || value.contains('\0') || value.contains('\r') || value.contains('\n') {
        None
    } else {
        Some(value)
    }
}

fn is_canonical_linked_worktree(workspace_root: &Path, common_root: &Path, git_dir: &Path) -> bool {
    let relative = match git_dir.strip_prefix(common_root) {
        Ok(relative) => relative,
        Err(_) => return false,
    };
    let parts: Vec<_> = relative.components().collect();
    if parts.len() != 2 || parts[0].as_os_str() != "worktrees" {
        return false;
    }
    let worktrees_dir = common_root.join("worktrees");
    let workspace_git_file = workspace_root.join(".git");
    if fs::symlink_metadata(&worktrees_dir)
        .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
        .unwrap_or(true)
        || fs::symlink_metadata(git_dir)
            .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_dir())
            .unwrap_or(true)
        || fs::symlink_metadata(&workspace_git_file)
            .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
            .unwrap_or(true)
    {
        return false;
    }
    let workspace_pointer = match read_git_pointer(&workspace_git_file) {
        Some(value) => value,
        None => return false,
    };
    let Some(target) = workspace_pointer.strip_prefix("gitdir:") else {
        return false;
    };
    if fs::canonicalize(workspace_git_file.parent().unwrap().join(target.trim())).ok()
        != Some(git_dir.to_path_buf())
    {
        return false;
    }
    let back_pointer_file = git_dir.join("gitdir");
    let back_pointer = match read_git_pointer(&back_pointer_file) {
        Some(value) => value,
        None => return false,
    };
    if fs::canonicalize(back_pointer_file.parent().unwrap().join(back_pointer)).ok()
        != fs::canonicalize(&workspace_git_file).ok()
    {
        return false;
    }
    let common_pointer_file = git_dir.join("commondir");
    let common_pointer = match read_git_pointer(&common_pointer_file) {
        Some(value) => value,
        None => return false,
    };
    fs::canonicalize(common_pointer_file.parent().unwrap().join(common_pointer)).ok()
        == Some(common_root.to_path_buf())
}

fn has_symlink_component(root: &Path, relative: &Path) -> bool {
    let mut cursor = root.to_path_buf();
    for segment in relative.components() {
        cursor.push(segment);
        if !cursor.exists() {
            break;
        }
        if fs::symlink_metadata(&cursor)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true)
        {
            return true;
        }
    }
    false
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn new_session_id(
    workspace: &Workspace,
    policy_fingerprint: &str,
    entries: &[IndexEntry],
) -> String {
    let mut hash = Sha256::new();
    hash.update(workspace.root().to_string_lossy().as_bytes());
    hash.update(policy_fingerprint.as_bytes());
    hash.update((entries.len() as u64).to_le_bytes());
    hash.update(
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
            .to_le_bytes(),
    );
    format!("{:x}", hash.finalize())
}
