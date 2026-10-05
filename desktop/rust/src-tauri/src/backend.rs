use crate::{policy, DesktopState};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::Ordering,
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use url::Url;

pub struct DesktopData {
    pub directory: PathBuf,
    pub workspace: PathBuf,
    pub plugins: PathBuf,
    pub users: PathBuf,
    pub initial_password: Option<String>,
}

fn runtime_root(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .canonicalize()?)
    } else {
        Ok(app.path().resource_dir()?.join("runtime"))
    }
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("Desktop project directory")
}

/// Rust's Windows canonical paths use the extended namespace. Keep those paths
/// for Rust filesystem checks, but do not expose that namespace to Node's CLI
/// module resolver or path-valued environment/IPC fields.
#[cfg(any(windows, test))]
fn windows_node_path(value: &str) -> io::Result<String> {
    fn invalid() -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows path cannot be represented safely at the Node boundary",
        )
    }
    fn component(value: &str) -> bool {
        if value.is_empty()
            || value == "."
            || value == ".."
            || value.ends_with([' ', '.'])
            || value
                .chars()
                .any(|character| character <= '\u{1f}' || "<>:\"/|?*".contains(character))
        {
            return false;
        }
        let base = value.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&base.as_str()) {
            return false;
        }
        if let Some(suffix) = base
            .strip_prefix("COM")
            .or_else(|| base.strip_prefix("LPT"))
        {
            if suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_digit()
                || ["¹", "²", "³"].contains(&suffix)
            {
                return false;
            }
        }
        true
    }
    fn tail(value: &str) -> bool {
        if value.is_empty() {
            return true;
        }
        let values = value.split('\\').collect::<Vec<_>>();
        values
            .iter()
            .enumerate()
            .all(|(index, value)| value.is_empty() && index == values.len() - 1 || component(value))
    }
    if value.contains('\0') {
        return Err(invalid());
    }
    let Some(body) = value.strip_prefix(r"\\?\") else {
        if value.starts_with(r"\\.\") || value.starts_with(r"\??\") || value.starts_with(r"\\??\") {
            return Err(invalid());
        }
        return Ok(value.to_owned());
    };
    if body.len() >= 3
        && body.as_bytes()[0].is_ascii_alphabetic()
        && body.as_bytes()[1] == b':'
        && body.as_bytes()[2] == b'\\'
    {
        return if tail(&body[3..]) {
            Ok(body.to_owned())
        } else {
            Err(invalid())
        };
    }
    if body
        .get(..4)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC\\"))
    {
        let unc = &body[4..];
        let mut values = unc.split('\\');
        let server = values.next().unwrap_or("");
        let share = values.next().unwrap_or("");
        if component(server) && component(share) && tail(unc) {
            return Ok(format!(r"\\{unc}"));
        }
    }
    Err(invalid())
}

fn node_path(path: &Path) -> io::Result<PathBuf> {
    #[cfg(windows)]
    {
        let value = path.to_str().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Node paths must be valid Unicode",
            )
        })?;
        windows_node_path(value).map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        Ok(path.to_owned())
    }
}

fn copy_directory(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            copy_directory(&entry.path(), &destination.join(entry.file_name()))?;
        } else if entry.file_type()?.is_file() {
            fs::copy(entry.path(), destination.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn create_initial_users(file: &Path, value: &Value) -> io::Result<bool> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = match options.open(file) {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error),
    };
    output.write_all(&serde_json::to_vec_pretty(value)?)?;
    output.write_all(b"\n")?;
    output.sync_all()?;
    Ok(true)
}

impl DesktopData {
    pub fn ensure(app: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        // Reuse the released Electron application's data, never a fresh Tauri
        // bundle-identifier directory. The explicit override remains supported.
        let directory = if let Some(value) = env::var_os("CREWFORGE_DESKTOP_DATA_DIR") {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                env::current_dir()?.join(path)
            }
        } else {
            dirs::config_dir()
                .ok_or("User configuration directory unavailable")?
                .join("CrownForge")
        };
        let workspace = directory.join("workspace");
        let plugins = directory.join("plugins");
        let users = directory.join("users.json");
        fs::create_dir_all(&workspace)?;
        if !plugins.exists() {
            let bundled = if cfg!(debug_assertions) {
                project_root().join("plugins")
            } else {
                runtime_root(app)?.join("plugins")
            };
            if bundled.is_dir() {
                copy_directory(&bundled, &plugins)?;
            } else {
                fs::create_dir_all(&plugins)?;
            }
        }
        let mut initial_password = None;
        if !users.exists() {
            let password = uuid::Uuid::new_v4().simple().to_string();
            let home = dirs::home_dir().ok_or("Home directory unavailable")?;
            // Preserve exclusive creation even if a legacy host races the new
            // host. Existing accounts must never be replaced at first startup.
            let created = create_initial_users(
                &users,
                &json!({
                    "allowedRoots": [node_path(&home)?, node_path(&workspace)?], "pendingRegistrations": [],
                    "users": [{"username":"admin", "password":password, "defaultWorkspace":node_path(&workspace)?, "isAdmin":true}]
                }),
            )?;
            if created {
                initial_password = Some(password);
            }
        }
        Ok(Self {
            directory,
            workspace,
            plugins,
            users,
            initial_password,
        })
    }
}

pub struct Backend {
    process: Mutex<Child>,
    input: Mutex<ChildStdin>,
}

pub struct BackendStartup {
    pub backend: Backend,
    pub messages: Receiver<Value>,
    pub url: Url,
    pub bootstrap_token: String,
}

fn create_bootstrap_token() -> io::Result<String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| io::Error::other("Desktop authentication initialization failed"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn node_executable(root: &Path) -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("CROWNFORGE_NODE_EXECUTABLE") {
        let path = PathBuf::from(value);
        if !path.is_absolute() || !path.is_file() {
            return Err(
                "CROWNFORGE_NODE_EXECUTABLE must name an existing absolute Node executable".into(),
            );
        }
        return Ok(path);
    }
    let bundled = root
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.is_file() {
        return Ok(bundled);
    }
    if cfg!(debug_assertions) {
        if let Some(path) = env::var_os("PATH").and_then(|paths| {
            env::split_paths(&paths)
                .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
                .find(|path| path.is_file())
        }) {
            return path.canonicalize().map_err(|error| error.to_string());
        }
    }
    Err(
        "Bundled Node runtime is missing. Prepare the Rust desktop resources before packaging."
            .into(),
    )
}

type BundledGitPaths = (PathBuf, PathBuf, Vec<PathBuf>);

fn bundled_git(root: &Path) -> Result<Option<BundledGitPaths>, Box<dyn std::error::Error>> {
    let directory = root.join(if cfg!(debug_assertions) {
        "resources/git"
    } else {
        "git"
    });
    let receipt = directory.join("crownforge-git-runtime.json");
    if cfg!(debug_assertions) && !receipt.is_file() {
        return Ok(None);
    }
    let manifest: Value = serde_json::from_slice(&fs::read(receipt)?)?;
    let platform = if cfg!(windows) { "win32" } else { "darwin" };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    if manifest["schemaVersion"] != 1
        || manifest["platform"] != platform
        || manifest["arch"] != arch
    {
        return Err("Bundled Git runtime identity is invalid".into());
    }
    let expected = if cfg!(windows) {
        "cmd/git.exe"
    } else {
        "bin/git"
    };
    let bin = if cfg!(windows) { "cmd" } else { "bin" };
    if manifest["executable"] != expected || manifest["binDirectories"] != json!([bin]) {
        return Err("Bundled Git paths are invalid".into());
    }
    let directory = directory.canonicalize()?;
    let executable = directory.join(expected);
    if !fs::symlink_metadata(&executable)?.file_type().is_file() {
        return Err("Bundled Git executable is missing".into());
    }
    Ok(Some((
        directory.clone(),
        executable.canonicalize()?,
        vec![directory.join(bin)],
    )))
}

impl Backend {
    pub fn start(
        app: &tauri::AppHandle,
        data: &DesktopData,
    ) -> Result<BackendStartup, Box<dyn std::error::Error>> {
        let root = runtime_root(app)?;
        let project = if cfg!(debug_assertions) {
            project_root()
        } else {
            root.clone()
        };
        let bootstrap = project.join("backend/bootstrap.cjs");
        let bridge = root.join(if cfg!(debug_assertions) {
            "runtime/bootstrap.cjs"
        } else {
            "bootstrap.cjs"
        });
        let frontend = project.join(if cfg!(debug_assertions) {
            "frontend/dist"
        } else {
            "frontend"
        });
        let binary_name = if cfg!(windows) {
            "crownforge-ide-core.exe"
        } else {
            "crownforge-ide-core"
        };
        let ide_core = env::var_os("CROWNFORGE_IDE_CORE_EXECUTABLE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                root.join(if cfg!(debug_assertions) {
                    "target/debug"
                } else {
                    "binaries"
                })
                .join(binary_name)
            });
        for (path, description) in [
            (&bootstrap, "Backend bootstrap"),
            (&bridge, "Desktop IPC bootstrap"),
            (&frontend.join("index.html"), "Frontend build"),
            (&ide_core, "Rust IDE service"),
        ] {
            if !path.is_file() {
                return Err(format!("{description} is missing: {}", path.display()).into());
            }
        }
        let node = node_executable(&root)?;
        let git = bundled_git(&root)?;
        let bootstrap_token = create_bootstrap_token()?;
        let mut command = Command::new(node_path(&node)?);
        command
            .arg(node_path(&bridge)?)
            // Keep the daemon cwd inside the packaged runtime. LaunchServices
            // GUI children can stall in Node's getcwd() when cwd is a user
            // document location gated by macOS privacy checks. User data still
            // flows through explicit path-valued environment variables below.
            .current_dir(node_path(&root)?)
            .env("CREWFORGE_DESKTOP", "1")
            .env("CROWNFORGE_DESKTOP_RUNTIME", "tauri")
            .env("CROWNFORGE_DESKTOP_BOOTSTRAP_TOKEN", &bootstrap_token)
            .env("CROWNFORGE_BACKEND_BOOTSTRAP", node_path(&bootstrap)?)
            .env("CROWNFORGE_IDE_CORE_EXECUTABLE", node_path(&ide_core)?)
            .env("NODE_ENV", "production")
            .env("HOST", "127.0.0.1")
            .env("PORT", "0")
            .env("WORKSPACE_DIR", node_path(&data.workspace)?)
            .env("USERS_CONFIG", node_path(&data.users)?)
            .env(
                "APP_SETTINGS_CONFIG",
                node_path(&data.directory.join("app-settings.json"))?,
            )
            .env("TEAM_STORE_ROOT", node_path(&data.directory)?)
            .env("PLUGINS_DIR", node_path(&data.plugins)?)
            .env("STATIC_DIR", node_path(&frontend)?)
            .env(
                "VLLM_API_URL",
                env::var("VLLM_API_URL").unwrap_or_else(|_| "http://127.0.0.1:8000/v1".into()),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        if let Some((directory, executable, bins)) = git {
            let paths = bins
                .into_iter()
                .chain(
                    env::var_os("PATH")
                        .into_iter()
                        .flat_map(|value| env::split_paths(&value).collect::<Vec<_>>()),
                )
                .map(|path| node_path(&path))
                .collect::<io::Result<Vec<_>>>()?;
            command
                .env("CROWNFORGE_GIT_EXECUTABLE", node_path(&executable)?)
                .env("CROWNFORGE_GIT_RUNTIME_ROOT", node_path(&directory)?)
                .env("PATH", env::join_paths(paths)?);
        }
        #[cfg(windows)]
        if command.get_envs().all(|(key, _)| {
            !key.to_str()
                .is_some_and(|value| value.eq_ignore_ascii_case("PATH"))
        }) {
            if let Some(value) = env::var_os("PATH") {
                let paths = env::split_paths(&value)
                    .map(|path| node_path(&path))
                    .collect::<io::Result<Vec<_>>>()?;
                command.env("PATH", env::join_paths(paths)?);
            }
        }
        if !cfg!(debug_assertions) {
            command.env("CROWNFORGE_BUNDLED_TOOLS_REQUIRED", "1");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW for the daemon.
        }
        let mut child = command.spawn()?;
        let input = child.stdin.take().ok_or("Backend stdin unavailable")?;
        let output = child.stdout.take().ok_or("Backend stdout unavailable")?;
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut frame = String::new();
                match reader.read_line(&mut frame) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if frame.len() <= 65536 => {
                        if let Ok(value) = serde_json::from_str::<Value>(&frame) {
                            if sender.send(value).is_err() {
                                break;
                            }
                        }
                    }
                    Ok(_) => {
                        eprintln!("Discarded oversized desktop IPC frame");
                    }
                }
            }
        });
        let backend = Self {
            process: Mutex::new(child),
            input: Mutex::new(input),
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() >= deadline {
                backend.stop();
                return Err("Local desktop service startup timed out".into());
            }
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(message) if message["type"] == "ready" => {
                    if let Some(url) = message["url"].as_str().and_then(policy::ready_url) {
                        return Ok(BackendStartup {
                            backend,
                            messages: receiver,
                            url,
                            bootstrap_token,
                        });
                    }
                    backend.stop();
                    return Err("Backend sent an invalid loopback URL".into());
                }
                Ok(message) if message["type"] == "error" => {
                    backend.stop();
                    return Err(format!(
                        "Local service startup failed: {} ({})",
                        message["code"], message["phase"]
                    )
                    .into());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    backend.stop();
                    return Err("Local service exited before startup completed".into());
                }
                _ => {}
            }
            if backend.exited() {
                return Err("Local service exited before startup completed".into());
            }
        }
    }

    pub fn send(&self, value: &Value) -> io::Result<()> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| io::Error::other("Backend IPC unavailable"))?;
        input.write_all(&serde_json::to_vec(value)?)?;
        input.write_all(b"\n")?;
        input.flush()
    }

    fn exited(&self) -> bool {
        self.process.lock().map_or(true, |mut child| {
            child.try_wait().is_ok_and(|status| status.is_some())
        })
    }

    pub fn stop(&self) {
        let _ = self.send(&json!({"type":"shutdown"}));
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if self.exited() {
                return;
            }
            thread::sleep(Duration::from_millis(40));
        }
        if let Ok(mut child) = self.process.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        if !self.exited() {
            self.stop();
        }
    }
}

fn folder_picker(app: &tauri::AppHandle, backend: Arc<Backend>, message: Value) {
    let Some(request_id) = message["requestId"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_owned)
    else {
        return;
    };
    let state = app.state::<DesktopState>();
    let error = if app.get_webview_window("main").is_none() {
        Some("MAIN_WINDOW_UNAVAILABLE")
    } else if state.folder_picker_open.swap(true, Ordering::SeqCst) {
        Some("FOLDER_PICKER_BUSY")
    } else {
        None
    };
    if let Some(error) = error {
        let _ = backend.send(&json!({"type":"desktop-pick-folder-result", "requestId":request_id, "path":null, "error":error}));
        return;
    }
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    if let Some(path) = message["defaultPath"]
        .as_str()
        .filter(|path| !path.trim().is_empty())
    {
        dialog = dialog.set_directory(path);
    }
    let app = app.clone();
    dialog.pick_folder(move |folder| {
        let selected = folder.and_then(|folder| folder.into_path().ok());
        let normalized = selected.as_deref().map(node_path).transpose();
        let error = normalized.as_ref().err().map(|_| "INVALID_FOLDER_PATH");
        let path = normalized
            .ok()
            .flatten()
            .map(|path| path.to_string_lossy().into_owned());
        let mut response =
            json!({"type":"desktop-pick-folder-result", "requestId":request_id, "path":path});
        if let Some(error) = error {
            response["error"] = json!(error);
        }
        let _ = backend.send(&response);
        app.state::<DesktopState>()
            .folder_picker_open
            .store(false, Ordering::SeqCst);
    });
}

pub fn listen(app: tauri::AppHandle, backend: Arc<Backend>, messages: Receiver<Value>) {
    thread::spawn(move || loop {
        if app.state::<DesktopState>().quitting.load(Ordering::SeqCst) {
            break;
        }
        match messages.recv_timeout(Duration::from_millis(250)) {
            Ok(message) if message["type"] == "desktop-pick-folder" => {
                folder_picker(&app, backend.clone(), message)
            }
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) if !backend.exited() => continue,
            Err(_) => {
                if !app.state::<DesktopState>().quitting.load(Ordering::SeqCst) {
                    crate::show_failure(&app, "本地服务已停止，请重新启动应用。".into());
                }
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_node_boundary_removes_only_disk_and_unc_verbatim_prefixes() {
        for (source, expected) in [
            (
                r"\\?\D:\CrownForge 安装\runtime\bootstrap.cjs",
                r"D:\CrownForge 安装\runtime\bootstrap.cjs",
            ),
            (
                r"\\?\c:\User's App\runtime\node\node.exe",
                r"c:\User's App\runtime\node\node.exe",
            ),
            (r"\\?\C:\", r"C:\"),
            (
                r"\\?\UNC\server\share\runtime\frontend",
                r"\\server\share\runtime\frontend",
            ),
            (r"\\?\unc\Server\Share\", r"\\Server\Share\"),
        ] {
            let rust_path = source.to_owned();
            assert_eq!(windows_node_path(&rust_path).unwrap(), expected);
            assert_eq!(
                rust_path, source,
                "Rust filesystem path must remain unchanged"
            );
        }
    }

    #[test]
    fn normal_node_paths_and_existing_path_entries_are_not_rewritten() {
        for value in [
            r"D:\Apps\runtime\bootstrap.cjs",
            r"D:/Apps/runtime",
            r"\\server\share\runtime",
            "tools",
            "",
            r"D:tools",
        ] {
            assert_eq!(windows_node_path(value).unwrap(), value);
        }
    }

    #[test]
    fn node_boundary_refuses_devices_and_semantically_ambiguous_names() {
        for value in [
            r"\\.\pipe\service",
            r"\??\D:\runtime",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\runtime",
            r"\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\runtime",
            r"\\?\D:",
            r"\\?\D:relative",
            r"\\?\D:/runtime",
            r"\\?\UNC\server",
            r"\\?\UNC\\share\runtime",
            r"\\?\UNC\server\\runtime",
            r"\\?\C:\a\..\bootstrap.cjs",
            r"\\?\C:\a\.\bootstrap.cjs",
            r"\\?\C:\a\\bootstrap.cjs",
            r"\\?\C:\a.\bootstrap.cjs",
            r"\\?\C:\a \bootstrap.cjs",
            r"\\?\C:\NUL\bootstrap.cjs",
            r"\\?\C:\COM1.txt",
            r"\\?\C:\LPT²",
            r"\\?\C:\bootstrap.cjs:stream",
            "\\\\?\\C:\\a\0b",
        ] {
            assert!(
                windows_node_path(value).is_err(),
                "Unsafe conversion accepted: {value:?}"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_node_boundary_preserves_literal_windows_looking_names() {
        for value in [
            "/Applications/CrownForge.app/runtime/bootstrap.cjs",
            r"/tmp/\\?\D:\literal-name",
            "relative/path",
        ] {
            assert_eq!(node_path(Path::new(value)).unwrap(), PathBuf::from(value));
        }
    }

    #[test]
    fn bootstrap_tokens_are_private_random_256_bit_values() {
        let first = create_bootstrap_token().unwrap();
        let second = create_bootstrap_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn initial_account_creation_never_overwrites_an_existing_configuration() {
        let directory = env::temp_dir().join(format!("crownforge-users-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("users.json");
        assert!(create_initial_users(&file, &json!({"users":[{"username":"original"}]})).unwrap());
        assert!(
            !create_initial_users(&file, &json!({"users":[{"username":"replacement"}]})).unwrap()
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(file).unwrap()).unwrap(),
            json!({"users":[{"username":"original"}]})
        );
        fs::remove_dir_all(directory).unwrap();
    }
}
