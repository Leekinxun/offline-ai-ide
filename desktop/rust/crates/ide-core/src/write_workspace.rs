use crate::{CoreError, Result};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn stage_file(
    root: &Path,
    target_relative: &str,
    bytes: &[u8],
    mode: Option<u32>,
    modified_at_ms: Option<f64>,
) -> Result<PathBuf> {
    #[cfg(unix)]
    {
        unix::stage_file(root, target_relative, bytes, mode, modified_at_ms)
    }
    #[cfg(not(unix))]
    {
        let target = root.join(target_relative.replace('\\', "/"));
        fs::create_dir_all(parent(&target)?)?;
        #[cfg(windows)]
        let _parent_guard = pin_windows_parent(root, &target)?;
        let staged = unique_temp_path(&target);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)?;
        file.write_all(bytes)?;
        #[cfg(windows)]
        if let Some(modified_at_ms) = modified_at_ms {
            set_file_mtime_windows(&file, modified_at_ms)?;
        }
        file.sync_all()?;
        sync_parent(&staged)?;
        let _ = mode;
        #[cfg(not(windows))]
        let _ = modified_at_ms;
        Ok(staged)
    }
}

pub(crate) fn install_file(
    root: &Path,
    target_relative: &str,
    staged: &Path,
    exclusive: bool,
) -> Result<()> {
    #[cfg(unix)]
    {
        unix::install_file(root, target_relative, staged, exclusive)
    }
    #[cfg(windows)]
    {
        let target = root.join(target_relative.replace('\\', "/"));
        let _parent_guard = pin_windows_parent(root, &target)?;
        if exclusive {
            let staged_metadata = fs::metadata(staged)?;
            let staged_modified = staged_metadata.modified().ok();
            let staged_permissions = staged_metadata.permissions();
            let mut source = File::open(staged)?;
            let mut destination = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(existing_is_conflict)?;
            std::io::copy(&mut source, &mut destination)?;
            if let Some(modified) = staged_modified {
                set_file_mtime_windows(&destination, system_time_ms(modified)?)?;
            }
            destination.sync_all()?;
            drop(destination);
            if staged_permissions.readonly() {
                fs::set_permissions(&target, staged_permissions)?;
            }
            fs::remove_file(staged)?;
        } else {
            fs::rename(staged, &target)?;
        }
        File::open(&target)?.sync_all()?;
        sync_parent(&target)?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let target = root.join(target_relative.replace('\\', "/"));
        if exclusive {
            let mut source = File::open(staged)?;
            let mut destination = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(existing_is_conflict)?;
            std::io::copy(&mut source, &mut destination)?;
            destination.sync_all()?;
            fs::remove_file(staged)?;
        } else {
            fs::rename(staged, &target)?;
        }
        File::open(&target)?.sync_all()?;
        sync_parent(&target)?;
        Ok(())
    }
}

pub(crate) fn rename_no_replace(root: &Path, from_relative: &str, to_relative: &str) -> Result<()> {
    #[cfg(unix)]
    {
        unix::rename_no_replace(root, from_relative, to_relative)
    }
    #[cfg(windows)]
    {
        let from = root.join(from_relative.replace('\\', "/"));
        let to = root.join(to_relative.replace('\\', "/"));
        let _from_parent_guard = pin_windows_parent(root, &from)?;
        let _to_parent_guard = pin_windows_parent(root, &to)?;
        if to.exists() {
            return Err(CoreError::new("CONFLICT", "Target already exists"));
        }
        move_file_ex_no_replace(&from, &to)?;
        sync_parent(&from)?;
        sync_parent(&to)?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let from = root.join(from_relative.replace('\\', "/"));
        let to = root.join(to_relative.replace('\\', "/"));
        if to.exists() {
            return Err(CoreError::new("CONFLICT", "Target already exists"));
        }
        fs::rename(&from, &to)?;
        sync_parent(&from)?;
        sync_parent(&to)?;
        Ok(())
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        ffi::{CString, OsString},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::{OsStrExt, OsStringExt},
                fs::{OpenOptionsExt, PermissionsExt},
            },
        },
    };

    pub(super) fn stage_file(
        root: &Path,
        target_relative: &str,
        bytes: &[u8],
        mode: Option<u32>,
        modified_at_ms: Option<f64>,
    ) -> Result<PathBuf> {
        let parent = open_parent(root, target_relative, true)?;
        let effective_mode = mode.or(existing_file_mode(&parent)?).unwrap_or(0o600) & 0o7777;
        let staged_name = OsString::from(format!(
            ".crewforge-tmp-{}-{}",
            std::process::id(),
            now_ms() as u64
        ));
        let staged_c = cstring(staged_name.as_bytes())?;
        let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC;
        // SAFETY: parent.dir is an open directory descriptor and staged_c is a valid C string.
        let fd = unsafe {
            libc::openat(
                parent.dir.as_raw_fd(),
                staged_c.as_ptr(),
                flags,
                effective_mode as libc::c_uint,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        // SAFETY: openat returned a new owned file descriptor.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        fs::set_permissions(
            parent.absolute.join(&staged_name),
            fs::Permissions::from_mode(effective_mode),
        )?;
        if let Some(modified_at_ms) = modified_at_ms {
            set_file_mtime_at(parent.dir.as_raw_fd(), &staged_name, modified_at_ms)?;
        }
        file.sync_all()?;
        parent.dir.sync_all()?;
        Ok(parent.absolute.join(staged_name))
    }

    pub(super) fn install_file(
        root: &Path,
        target_relative: &str,
        staged: &Path,
        exclusive: bool,
    ) -> Result<()> {
        let parent = open_parent(root, target_relative, true)?;
        if exclusive {
            link_absolute_to_parent(staged, parent.dir.as_raw_fd(), &parent.leaf)?;
            fs::remove_file(staged)?;
        } else {
            rename_absolute_to_parent(staged, parent.dir.as_raw_fd(), &parent.leaf)?;
        }
        File::open(parent.absolute.join(&parent.leaf))?.sync_all()?;
        parent.dir.sync_all()?;
        sync_parent(staged)?;
        Ok(())
    }

    pub(super) fn rename_no_replace(
        root: &Path,
        from_relative: &str,
        to_relative: &str,
    ) -> Result<()> {
        let source = open_parent(root, from_relative, false)?;
        let target = open_parent(root, to_relative, true)?;
        let source_path = source.absolute.join(&source.leaf);
        let metadata = fs::symlink_metadata(&source_path)?;
        if metadata.is_file() {
            link_file_then_unlink(&source, &target)?;
        } else if metadata.is_dir() {
            rename_dir_no_replace(&source, &target)?;
        } else {
            return Err(CoreError::new("CONFLICT", "Unsupported entry type"));
        }
        source.dir.sync_all()?;
        target.dir.sync_all()?;
        Ok(())
    }

    fn link_file_then_unlink(source: &AnchoredParent, target: &AnchoredParent) -> Result<()> {
        let source_c = cstring(source.leaf.as_bytes())?;
        let target_c = cstring(target.leaf.as_bytes())?;
        // SAFETY: both descriptors are checked directory handles and names are valid C strings.
        if unsafe {
            libc::linkat(
                source.dir.as_raw_fd(),
                source_c.as_ptr(),
                target.dir.as_raw_fd(),
                target_c.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(existing_errno_is_conflict());
        }
        // SAFETY: source descriptor and leaf name are valid and refer to the original parent.
        if unsafe { libc::unlinkat(source.dir.as_raw_fd(), source_c.as_ptr(), 0) } != 0 {
            let _ = unsafe { libc::unlinkat(target.dir.as_raw_fd(), target_c.as_ptr(), 0) };
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn rename_dir_no_replace(source: &AnchoredParent, target: &AnchoredParent) -> Result<()> {
        const RENAME_NOREPLACE: u32 = 1;
        let source_c = cstring(source.leaf.as_bytes())?;
        let target_c = cstring(target.leaf.as_bytes())?;
        // SAFETY: syscall is invoked with valid directory descriptors and C strings.
        let rc = unsafe {
            libc::syscall(
                libc::SYS_renameat2,
                source.dir.as_raw_fd(),
                source_c.as_ptr(),
                target.dir.as_raw_fd(),
                target_c.as_ptr(),
                RENAME_NOREPLACE,
            )
        };
        if rc != 0 {
            return Err(existing_errno_is_conflict());
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn rename_dir_no_replace(source: &AnchoredParent, target: &AnchoredParent) -> Result<()> {
        const RENAME_EXCL: u32 = 0x0000_0004;
        extern "C" {
            fn renameatx_np(
                fromfd: libc::c_int,
                from: *const libc::c_char,
                tofd: libc::c_int,
                to: *const libc::c_char,
                flags: u32,
            ) -> libc::c_int;
        }
        let source_c = cstring(source.leaf.as_bytes())?;
        let target_c = cstring(target.leaf.as_bytes())?;
        // SAFETY: renameatx_np receives checked directory descriptors and valid C strings.
        if unsafe {
            renameatx_np(
                source.dir.as_raw_fd(),
                source_c.as_ptr(),
                target.dir.as_raw_fd(),
                target_c.as_ptr(),
                RENAME_EXCL,
            )
        } != 0
        {
            return Err(existing_errno_is_conflict());
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn rename_dir_no_replace(source: &AnchoredParent, target: &AnchoredParent) -> Result<()> {
        let target_path = target.absolute.join(&target.leaf);
        if target_path.exists() {
            return Err(CoreError::new("CONFLICT", "Target already exists"));
        }
        fs::rename(source.absolute.join(&source.leaf), target_path)?;
        Ok(())
    }

    fn link_absolute_to_parent(
        staged: &Path,
        target_parent_fd: libc::c_int,
        target_leaf: &OsString,
    ) -> Result<()> {
        let staged_c = cstring(staged.as_os_str().as_bytes())?;
        let target_c = cstring(target_leaf.as_bytes())?;
        // SAFETY: staged path and target leaf are valid C strings; target fd is a checked directory.
        if unsafe {
            libc::linkat(
                libc::AT_FDCWD,
                staged_c.as_ptr(),
                target_parent_fd,
                target_c.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(existing_errno_is_conflict());
        }
        Ok(())
    }

    fn rename_absolute_to_parent(
        staged: &Path,
        target_parent_fd: libc::c_int,
        target_leaf: &OsString,
    ) -> Result<()> {
        let staged_c = cstring(staged.as_os_str().as_bytes())?;
        let target_c = cstring(target_leaf.as_bytes())?;
        // SAFETY: staged path and target leaf are valid C strings; target fd is a checked directory.
        if unsafe {
            libc::renameat(
                libc::AT_FDCWD,
                staged_c.as_ptr(),
                target_parent_fd,
                target_c.as_ptr(),
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    struct AnchoredParent {
        dir: File,
        absolute: PathBuf,
        leaf: OsString,
    }

    fn existing_file_mode(parent: &AnchoredParent) -> Result<Option<u32>> {
        let leaf = cstring(parent.leaf.as_bytes())?;
        // SAFETY: zeroed stat is immediately initialized by fstatat on success.
        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        // SAFETY: parent dir and leaf are valid; AT_SYMLINK_NOFOLLOW inspects the leaf itself.
        if unsafe {
            libc::fstatat(
                parent.dir.as_raw_fd(),
                leaf.as_ptr(),
                &mut metadata,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(error.into());
        }
        let kind = metadata.st_mode & libc::S_IFMT;
        if kind == libc::S_IFLNK {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Mutation refuses symbolic links",
            ));
        }
        if kind == libc::S_IFREG {
            Ok(Some((metadata.st_mode & 0o7777).into()))
        } else {
            Ok(None)
        }
    }

    fn open_parent(root: &Path, relative: &str, create_dirs: bool) -> Result<AnchoredParent> {
        let parts = normalized_parts(relative)?;
        if parts.is_empty() {
            return Err(CoreError::new("PATH_ESCAPE", "Path has no parent"));
        }
        let leaf = parts.last().cloned().unwrap();
        let mut dir = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(root)?;
        let mut absolute = root.to_path_buf();
        for part in &parts[..parts.len() - 1] {
            let name = cstring(part.as_bytes())?;
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
            // SAFETY: dir is an open directory descriptor and name is a valid C string.
            let mut fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 && create_dirs {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::NotFound {
                    // SAFETY: mkdirat uses a valid parent descriptor and name.
                    if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    dir.sync_all()?;
                    // SAFETY: retry after mkdirat with the same valid arguments.
                    fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
                }
            }
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
            // SAFETY: openat returned an owned descriptor.
            dir = unsafe { File::from_raw_fd(fd) };
            absolute.push(part);
        }
        Ok(AnchoredParent {
            dir,
            absolute,
            leaf,
        })
    }

    fn normalized_parts(relative: &str) -> Result<Vec<OsString>> {
        let normalized = relative.replace('\\', "/");
        let path = Path::new(&normalized);
        if normalized.contains('\0')
            || path.is_absolute()
            || normalized.as_bytes().get(1) == Some(&b':')
        {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Path must stay inside the workspace",
            ));
        }
        let mut parts = Vec::new();
        for component in path.components() {
            let Component::Normal(name) = component else {
                return Err(CoreError::new(
                    "PATH_ESCAPE",
                    "Path must stay inside the workspace",
                ));
            };
            parts.push(OsString::from_vec(name.as_bytes().to_vec()));
        }
        if parts.is_empty() {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Path must stay inside the workspace",
            ));
        }
        Ok(parts)
    }

    fn set_file_mtime_at(
        parent_fd: libc::c_int,
        leaf: &OsString,
        modified_at_ms: f64,
    ) -> Result<()> {
        if !modified_at_ms.is_finite() || modified_at_ms < 0.0 {
            return Err(CoreError::invalid("Invalid modifiedAtMs"));
        }
        let seconds = (modified_at_ms / 1000.0).floor();
        let mut nanos = ((modified_at_ms - seconds * 1000.0) * 1_000_000.0).round();
        if nanos >= 1_000_000_000.0 {
            nanos = 999_999_999.0;
        }
        let times = [
            libc::timespec {
                tv_sec: 0,
                tv_nsec: libc::UTIME_OMIT,
            },
            libc::timespec {
                tv_sec: seconds as libc::time_t,
                tv_nsec: nanos as libc::c_long,
            },
        ];
        let leaf = cstring(leaf.as_bytes())?;
        // SAFETY: parent_fd is an open directory descriptor and the leaf/times pointers are valid.
        if unsafe { libc::utimensat(parent_fd, leaf.as_ptr(), times.as_ptr(), 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }

    fn cstring(bytes: &[u8]) -> Result<CString> {
        CString::new(bytes).map_err(|_| CoreError::invalid("File path contains NUL"))
    }

    fn existing_errno_is_conflict() -> CoreError {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CoreError::new("CONFLICT", "Target already exists")
        } else {
            CoreError::from(error)
        }
    }
}

#[cfg(windows)]
fn system_time_ms(time: SystemTime) -> Result<f64> {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .map_err(|_| CoreError::invalid("Invalid file modified time"))
}

fn sync_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(windows)]
fn pin_windows_parent(root: &Path, target: &Path) -> Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    revalidate_windows_parent(root, target)?;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .custom_flags(0x02000000 | 0x00200000)
        .open(parent(target)?)
        .map_err(CoreError::from)
}

#[cfg(windows)]
fn revalidate_windows_parent(root: &Path, target: &Path) -> Result<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

    let canonical_root = fs::canonicalize(root)?;
    let parent = parent(target)?;
    let canonical_parent = fs::canonicalize(parent)?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Path must stay inside the workspace",
        ));
    }
    let relative = canonical_parent
        .strip_prefix(&canonical_root)
        .map_err(|_| CoreError::new("PATH_ESCAPE", "Path must stay inside the workspace"))?;
    let root_meta = fs::symlink_metadata(&canonical_root)?;
    if root_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(CoreError::new(
            "PATH_ESCAPE",
            "Workspace root is a reparse point",
        ));
    }
    let mut cursor = canonical_root;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Path must stay inside the workspace",
            ));
        };
        cursor.push(name);
        let metadata = fs::symlink_metadata(&cursor)?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Workspace path was replaced by a reparse point",
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn move_file_ex_no_replace(from: &Path, to: &Path) -> Result<()> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let wide = |path: &Path| -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let from = wide(from);
    let to = wide(to);
    // SAFETY: both wide strings are NUL-terminated and valid for the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        return Err(existing_is_conflict(std::io::Error::last_os_error()));
    }
    let _ = ptr::null::<u16>();
    Ok(())
}

#[cfg(windows)]
fn set_file_mtime_windows(file: &File, modified_at_ms: f64) -> Result<()> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};

    if !modified_at_ms.is_finite() || modified_at_ms < 0.0 {
        return Err(CoreError::invalid("Invalid modifiedAtMs"));
    }
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileTime(
            handle: *mut c_void,
            creation: *const FileTime,
            access: *const FileTime,
            write: *const FileTime,
        ) -> i32;
    }
    let intervals = (modified_at_ms * 10_000.0).round() as u64 + 116_444_736_000_000_000;
    let write = FileTime {
        low: intervals as u32,
        high: (intervals >> 32) as u32,
    };
    // SAFETY: file handle is valid and FILETIME pointer is valid for this call.
    if unsafe {
        SetFileTime(
            file.as_raw_handle(),
            std::ptr::null(),
            std::ptr::null(),
            &write,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

fn existing_is_conflict(error: std::io::Error) -> CoreError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        CoreError::new("CONFLICT", "Target already exists")
    } else {
        CoreError::from(error)
    }
}

fn parent(path: &Path) -> Result<&Path> {
    path.parent()
        .ok_or_else(|| CoreError::new("PATH_ESCAPE", "Path has no parent"))
}

fn unique_temp_path(target: &Path) -> PathBuf {
    target.with_extension(format!(
        "crewforge-tmp-{}-{}",
        std::process::id(),
        now_ms() as u64
    ))
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}
