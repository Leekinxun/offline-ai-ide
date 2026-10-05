use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(CoreError::invalid("workspaceDir must be a directory"));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn resolve(&self, relative: &str) -> Result<PathBuf> {
        let normalized = relative.replace('\\', "/");
        let path = Path::new(&normalized);
        // Also reject Windows drive paths when this service runs on Unix.
        if path.is_absolute()
            || normalized.as_bytes().get(1) == Some(&b':')
            || path.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Path must stay inside the workspace",
            ));
        }
        let candidate = fs::canonicalize(self.root.join(path))?;
        if !candidate.starts_with(&self.root) {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Symbolic link escapes the workspace",
            ));
        }
        Ok(candidate)
    }

    pub fn relative(&self, full_path: &Path) -> Option<String> {
        full_path
            .strip_prefix(&self.root)
            .ok()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
    }

    pub fn open_file(&self, path: &Path) -> Result<fs::File> {
        let relative = path
            .strip_prefix(&self.root)
            .map_err(|_| CoreError::new("PATH_ESCAPE", "File escapes the workspace"))?;
        #[cfg(unix)]
        {
            use std::{
                ffi::CString,
                os::{
                    fd::{AsRawFd, FromRawFd},
                    unix::{ffi::OsStrExt, fs::OpenOptionsExt},
                },
            };
            // Anchor traversal to an open workspace descriptor and reject links introduced after
            // canonicalization. Internal symlinks already resolved to a physical in-scope path.
            let mut descriptor = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
                .open(&self.root)?;
            let mut components = relative.components().peekable();
            while let Some(component) = components.next() {
                let Component::Normal(name) = component else {
                    return Err(CoreError::new("PATH_ESCAPE", "Invalid file path"));
                };
                let name = CString::new(name.as_bytes())
                    .map_err(|_| CoreError::invalid("File path contains NUL"))?;
                let flags = libc::O_RDONLY
                    | libc::O_CLOEXEC
                    | libc::O_NOFOLLOW
                    | if components.peek().is_some() {
                        libc::O_DIRECTORY
                    } else {
                        libc::O_NONBLOCK
                    };
                // SAFETY: the parent descriptor is open and the CString is valid for this call.
                let fd = unsafe { libc::openat(descriptor.as_raw_fd(), name.as_ptr(), flags) };
                if fd < 0 {
                    let error = std::io::Error::last_os_error();
                    if [Some(libc::ELOOP), Some(libc::ENOTDIR)].contains(&error.raw_os_error()) {
                        return Err(CoreError::new(
                            "PATH_ESCAPE",
                            "Workspace path was replaced by a symbolic link",
                        ));
                    }
                    return Err(error.into());
                }
                // SAFETY: openat returned a new owned descriptor, transferred to File exactly once.
                descriptor = unsafe { fs::File::from_raw_fd(fd) };
            }
            Ok(descriptor)
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
            // Denying delete sharing pins every ancestor while the final handle opens.
            // OPEN_REPARSE_POINT lets us reject a junction/link rather than following it.
            let open = |candidate: &Path, directory: bool| -> Result<fs::File> {
                let file = fs::OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .custom_flags(0x00200000 | if directory { 0x02000000 } else { 0 })
                    .open(candidate)?;
                let metadata = file.metadata()?;
                if metadata.file_attributes() & 0x400 != 0 || (directory && !metadata.is_dir()) {
                    return Err(CoreError::new(
                        "PATH_ESCAPE",
                        "Workspace read refuses reparse points",
                    ));
                }
                Ok(file)
            };
            let mut handles = vec![open(&self.root, true)?];
            let mut current = self.root.clone();
            let mut components = relative.components().peekable();
            while let Some(component) = components.next() {
                let Component::Normal(name) = component else {
                    return Err(CoreError::new("PATH_ESCAPE", "Invalid file path"));
                };
                current.push(name);
                let file = open(&current, components.peek().is_some())?;
                if components.peek().is_none() {
                    return Ok(file);
                }
                handles.push(file);
            }
            Err(CoreError::invalid("File path is empty"))
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = relative;
            fs::File::open(path).map_err(CoreError::from)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileParams {
    pub workspace_dir: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub is_directory: bool,
    pub is_file: bool,
    pub is_symbolic_link: bool,
}

pub fn entries(params: FileParams) -> Result<Vec<Entry>> {
    let workspace = Workspace::open(params.workspace_dir)?;
    let path = workspace.resolve(&params.path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_directory: kind.is_dir(),
            is_file: kind.is_file(),
            is_symbolic_link: kind.is_symlink(),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub mtime_ms: f64,
}

pub fn read(params: FileParams) -> Result<FileContent> {
    let workspace = Workspace::open(params.workspace_dir)?;
    let mut file = workspace.open_file(&workspace.resolve(&params.path)?)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(CoreError::invalid("Path must be a regular file"));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(CoreError::failed(
            "File exceeds the desktop service 10 MiB read limit",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(CoreError::failed(
            "File exceeds the desktop service 10 MiB read limit",
        ));
    }
    // Match Node fs.readFile(..., 'utf8'), including replacement for malformed UTF-8.
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let mtime_ms = file
        .metadata()?
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(FileContent { content, mtime_ms })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn rejects_symbolic_link_replacement_after_canonicalization() {
        let fixture = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        fs::write(fixture.path().join("file.txt"), "inside").unwrap();
        fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let resolved = workspace.resolve("file.txt").unwrap();
        fs::remove_file(&resolved).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), &resolved).unwrap();
        assert_eq!(
            workspace.open_file(&resolved).unwrap_err().code,
            "PATH_ESCAPE"
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindPathsParams {
    pub workspace_dir: String,
    #[serde(default)]
    pub query: String,
    #[serde(default = "default_path_limit")]
    pub limit: usize,
}
fn default_path_limit() -> usize {
    80
}
#[derive(Serialize)]
pub struct FoundPaths {
    paths: Vec<String>,
    truncated: bool,
}

/// File-name lookup remains independent of explorer expansion state.
pub fn find_paths(
    params: FindPathsParams,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<FoundPaths> {
    use std::sync::atomic::Ordering;
    if params.query.len() > 1024 {
        return Err(CoreError::invalid("File-name query is too long"));
    }
    let workspace = Workspace::open(params.workspace_dir)?;
    let query = params.query.trim().replace('\\', "/").to_lowercase();
    let limit = params.limit.clamp(1, 1000);
    let mut builder = ignore::WalkBuilder::new(workspace.root());
    builder
        .standard_filters(true)
        .hidden(true)
        .follow_links(false)
        .max_depth(Some(64))
        .add_custom_ignore_filename(".rgignore")
        .sort_by_file_name(|a, b| a.cmp(b));
    builder.filter_entry(|entry| {
        entry.depth() == 0
            || ![
                "node_modules",
                "target",
                "dist",
                "build",
                "coverage",
                "vendor",
                "__pycache__",
                "venv",
            ]
            .iter()
            .any(|name| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(name)
            })
    });
    let mut paths = Vec::new();
    let mut visited = 0;
    for entry in builder.build() {
        if cancelled.load(Ordering::Relaxed) {
            return Err(CoreError::aborted());
        }
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        visited += 1;
        if visited > 250_000 {
            return Ok(FoundPaths {
                paths,
                truncated: true,
            });
        }
        let Some(relative) = workspace.relative(entry.path()) else {
            continue;
        };
        if relative.to_lowercase().contains(&query) {
            paths.push(relative);
            if paths.len() >= limit {
                return Ok(FoundPaths {
                    paths,
                    truncated: true,
                });
            }
        }
    }
    Ok(FoundPaths {
        paths,
        truncated: false,
    })
}
