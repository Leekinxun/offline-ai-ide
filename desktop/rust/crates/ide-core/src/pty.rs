use crate::{
    error::{CoreError, Result},
    resource_id,
    workspace::Workspace,
    EventSink,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};
#[cfg(unix)]
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnParams {
    #[serde(default)]
    pub session_id: Option<String>,
    pub workspace_dir: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParams {
    pub session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteParams {
    pub session_id: String,
    pub data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeParams {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    _startup: Option<ShellStartup>,
    #[cfg(unix)]
    system_session_id: Option<i32>,
}

/// Private startup files live for exactly the owning terminal session. The
/// Agent sandbox never enters this interactive, user-controlled PTY path.
struct ShellStartup {
    directory: PathBuf,
}

impl Drop for ShellStartup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[cfg(unix)]
fn shell_literal(path: &Path) -> Result<String> {
    let value = path
        .to_str()
        .ok_or_else(|| CoreError::failed("Terminal startup paths must be UTF-8"))?;
    Ok(format!("'{}'", value.replace('\'', "'\"'\"'")))
}

#[cfg(unix)]
fn owner_git_directory(workspace: &Workspace) -> Result<Option<PathBuf>> {
    let Some(executable) = std::env::var_os("CROWNFORGE_GIT_EXECUTABLE") else {
        return if std::env::var("CROWNFORGE_BUNDLED_TOOLS_REQUIRED").as_deref() == Ok("1") {
            Err(CoreError::failed("Bundled Git runtime is missing"))
        } else {
            Ok(None)
        };
    };
    let executable = PathBuf::from(executable);
    if !executable.is_absolute() || !fs::symlink_metadata(&executable)?.file_type().is_file() {
        return Err(CoreError::failed(
            "Terminal Git must be an owner-provided absolute regular file",
        ));
    }
    let executable = executable.canonicalize()?;
    let directory = executable
        .parent()
        .ok_or_else(|| CoreError::failed("Terminal Git directory is unavailable"))?;
    if directory.starts_with(workspace.root()) || workspace.root().starts_with(directory) {
        return Err(CoreError::failed(
            "Terminal Git runtime must stay outside the workspace",
        ));
    }
    Ok(Some(directory.to_owned()))
}

#[cfg(unix)]
impl ShellStartup {
    fn create(workspace: &Workspace) -> Result<Self> {
        use std::os::unix::fs::DirBuilderExt;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let directory = std::env::temp_dir().canonicalize()?.join(format!(
            "crownforge-terminal-{}-{timestamp}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        if directory.starts_with(workspace.root()) {
            return Err(CoreError::failed(
                "Terminal startup files must stay outside the workspace",
            ));
        }
        fs::DirBuilder::new().mode(0o700).create(&directory)?;
        Ok(Self { directory })
    }

    fn write(&self, name: &str, content: &str) -> Result<PathBuf> {
        use std::os::unix::fs::OpenOptionsExt;
        let path = self.directory.join(name);
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(content.as_bytes())?;
        Ok(path)
    }

    fn configure(
        command: &mut CommandBuilder,
        params: &SpawnParams,
        workspace: &Workspace,
        git_directory: &Path,
    ) -> Result<Option<Self>> {
        let shell = Path::new(&params.executable)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        // Explicit command/script launches keep their argv semantics. Startup
        // integration applies only to ordinary interactive shell launches.
        if params.args.iter().any(|arg| {
            !arg.starts_with('-')
                || arg == "-c"
                || arg.starts_with("--command")
                || arg == "--norc"
                || arg == "-f"
                || arg == "--rcfile"
                || arg == "--init-file"
        }) {
            command.args(&params.args);
            return Ok(None);
        }
        let prefix = format!("export PATH={}:\"$PATH\"\n", shell_literal(git_directory)?);
        match shell {
            "bash" => {
                let startup = Self::create(workspace)?;
                let login = params.args.iter().any(|arg| {
                    arg == "--login"
                        || arg == "-l"
                        || arg.starts_with('-') && !arg.starts_with("--") && arg.contains('l')
                });
                let no_profile = params.args.iter().any(|arg| arg == "--noprofile");
                // Bash ignores --init-file in true login mode. As VS Code does,
                // load the normal login files once inside the same interactive
                // shell, preserving their aliases/functions before the prefix.
                let profiles = if login && !no_profile {
                    "if [[ -r /etc/profile ]]; then builtin source /etc/profile; fi\nif [[ -r \"$HOME/.bash_profile\" ]]; then builtin source \"$HOME/.bash_profile\"; elif [[ -r \"$HOME/.bash_login\" ]]; then builtin source \"$HOME/.bash_login\"; elif [[ -r \"$HOME/.profile\" ]]; then builtin source \"$HOME/.profile\"; fi\n"
                } else if !login {
                    "if [[ -r \"$HOME/.bashrc\" ]]; then builtin source \"$HOME/.bashrc\"; fi\n"
                } else {
                    ""
                };
                let file = startup.write("bash-init", &format!("{profiles}{prefix}"))?;
                command.args(["--init-file"]);
                command.arg(file);
                for arg in &params.args {
                    if arg == "--login" || arg == "-l" {
                        continue;
                    }
                    if arg.starts_with('-') && !arg.starts_with("--") && arg.contains('l') {
                        let remaining = arg.replace('l', "");
                        if remaining != "-" {
                            command.arg(remaining);
                        }
                    } else {
                        command.arg(arg);
                    }
                }
                Ok(Some(startup))
            }
            "zsh" => {
                let startup = Self::create(workspace)?;
                let bootstrap = shell_literal(&startup.directory)?;
                let original = params
                    .env
                    .get("ZDOTDIR")
                    .map(|value| shell_literal(Path::new(value)))
                    .transpose()?;
                let restore = "if (( __crownforge_zdot_set )); then export ZDOTDIR=\"$__crownforge_zdot\"; else unset ZDOTDIR; fi\n";
                let capture = "typeset -g __crownforge_zdot_set=${+ZDOTDIR}\ntypeset -g __crownforge_zdot=${ZDOTDIR-}\n";
                let initial = original
                    .map(|value| format!("export ZDOTDIR={value}\n"))
                    .unwrap_or_else(|| "unset ZDOTDIR\n".into());
                startup.write(".zshenv", &format!("{initial}if [[ -r \"${{ZDOTDIR-$HOME}}/.zshenv\" ]]; then builtin source \"${{ZDOTDIR-$HOME}}/.zshenv\"; fi\n{prefix}{capture}export ZDOTDIR={bootstrap}\n"))?;
                startup.write(".zprofile", &format!("{restore}if [[ -r \"${{ZDOTDIR-$HOME}}/.zprofile\" ]]; then builtin source \"${{ZDOTDIR-$HOME}}/.zprofile\"; fi\n{capture}export ZDOTDIR={bootstrap}\n"))?;
                startup.write(".zshrc", &format!("{restore}if [[ -r \"${{ZDOTDIR-$HOME}}/.zshrc\" ]]; then builtin source \"${{ZDOTDIR-$HOME}}/.zshrc\"; fi\nif [[ -o login ]]; then\n{capture}export ZDOTDIR={bootstrap}\nelse\n{prefix}unset __crownforge_zdot_set __crownforge_zdot\nfi\n"))?;
                startup.write(".zlogin", &format!("{restore}if [[ -r \"${{ZDOTDIR-$HOME}}/.zlogin\" ]]; then builtin source \"${{ZDOTDIR-$HOME}}/.zlogin\"; fi\n{prefix}unset __crownforge_zdot_set __crownforge_zdot\n"))?;
                command.env("ZDOTDIR", startup.directory.as_os_str());
                command.args(&params.args);
                Ok(Some(startup))
            }
            _ => {
                command.args(&params.args);
                Ok(None)
            }
        }
    }
}

impl Session {
    fn terminate(&mut self) -> Result<()> {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // Interactive shells may assign foreground/background jobs separate process groups.
            // Terminate descendants before the shell and then the PTY-owned process groups.
            terminate_descendants(pid);
            for group in [self.master.process_group_leader(), Some(pid as i32)]
                .into_iter()
                .flatten()
            {
                if group > 1 && self.system_session_id == system_session_id(group) {
                    // SAFETY: group is a positive PTY-owned process group; negative pid addresses it.
                    unsafe {
                        libc::kill(-group, libc::SIGKILL);
                    }
                }
            }
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            // This PID comes exclusively from the spawned native child, never from RPC input.
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        match self.killer.kill() {
            Ok(()) => Ok(()),
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    || error.raw_os_error() == Some(3) =>
            {
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }
}

#[cfg(unix)]
fn system_session_id(pid: i32) -> Option<i32> {
    // SAFETY: getsid does not mutate state and accepts the trusted child PID.
    let session = unsafe { libc::getsid(pid) };
    (session >= 0).then_some(session)
}

#[cfg(unix)]
fn terminate_descendants(root: u32) {
    let output = match std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid="])
        .stdin(std::process::Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return,
    };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut columns = line.split_whitespace();
        if let (Some(pid), Some(parent)) = (
            columns.next().and_then(|value| value.parse::<u32>().ok()),
            columns.next().and_then(|value| value.parse::<u32>().ok()),
        ) {
            children.entry(parent).or_default().push(pid);
        }
    }
    let mut descendants = Vec::new();
    let mut pending = vec![root];
    while let Some(parent) = pending.pop() {
        if let Some(next) = children.get(&parent) {
            for &pid in next {
                if pid > 1 && pid != root && !descendants.contains(&pid) {
                    descendants.push(pid);
                    pending.push(pid);
                }
            }
        }
    }
    for pid in descendants.into_iter().rev() {
        // SAFETY: pid belongs to the currently spawned terminal's descendant tree.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}

#[derive(Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl Terminals {
    pub fn spawn(&self, params: SpawnParams, emit: EventSink) -> Result<Value> {
        if self.closed.load(Ordering::Acquire) {
            return Err(CoreError::aborted());
        }
        let session_id =
            resource_id::allocate(params.session_id.clone(), &self.next_id, "session")?;
        if self.sessions.lock().unwrap().contains_key(&session_id) {
            return Err(CoreError::invalid("sessionId is already active"));
        }
        if params.executable.is_empty() || params.executable.contains('\0') {
            return Err(CoreError::invalid("executable is required"));
        }
        if params.args.iter().any(|value| value.contains('\0')) {
            return Err(CoreError::invalid("PTY arguments contain NUL"));
        }
        let workspace = Workspace::open(&params.workspace_dir)?;
        let pair = native_pty_system()
            .openpty(size(params.cols, params.rows))
            .map_err(|error| CoreError::failed(error.to_string()))?;
        let mut command = CommandBuilder::new(&params.executable);
        command.cwd(workspace.root());
        // Node supplies a sanitized terminal environment. Do not inherit API keys or Agent state.
        command.env_clear();
        for (key, value) in &params.env {
            if key.contains(['\0', '=']) || value.contains('\0') {
                return Err(CoreError::invalid("Invalid PTY environment"));
            }
            command.env(key, value);
        }
        if !params.env.contains_key("TERM") {
            command.env("TERM", "xterm-256color");
        }
        #[cfg(unix)]
        let startup = if let Some(git_directory) = owner_git_directory(&workspace)? {
            let mut paths = vec![git_directory.clone()];
            if let Some(value) = params.env.get("PATH") {
                paths.extend(std::env::split_paths(value));
            }
            command.env(
                "PATH",
                std::env::join_paths(paths)
                    .map_err(|error| CoreError::failed(error.to_string()))?,
            );
            ShellStartup::configure(&mut command, &params, &workspace, &git_directory)?
        } else {
            command.args(&params.args);
            None
        };
        #[cfg(not(unix))]
        let startup = {
            command.args(&params.args);
            None
        };
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| CoreError::failed(error.to_string()))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);
        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::failed(error.to_string()));
            }
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::failed(error.to_string()));
            }
        };
        let mut session = Session {
            master: pair.master,
            writer,
            killer,
            pid,
            _startup: startup,
            #[cfg(unix)]
            system_session_id: pid.and_then(|pid| system_session_id(pid as i32)),
        };
        let mut sessions = self.sessions.lock().unwrap();
        if self.closed.load(Ordering::Acquire) || sessions.contains_key(&session_id) {
            let _ = session.terminate();
            let _ = child.wait();
            return Err(CoreError::invalid(
                "Desktop core is closing or sessionId is already active",
            ));
        }
        sessions.insert(session_id.clone(), Arc::new(Mutex::new(session)));
        drop(sessions);
        let reader_emit = emit.clone();
        let reader_session_id = session_id.clone();
        let reader_thread = thread::spawn(move || {
            let mut bytes = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(length) => reader_emit(
                        json!({ "event": "pty.output", "params": { "sessionId": reader_session_id, "data": STANDARD.encode(&bytes[..length]) } }),
                    ),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        let sessions = self.sessions.clone();
        let exit_session_id = session_id.clone();
        thread::spawn(move || {
            let exit_code = child
                .wait()
                .map(|status| status.exit_code() as i64)
                .unwrap_or(-1);
            // Closing the writer/master also lets the read worker finish after the final output.
            sessions.lock().unwrap().remove(&exit_session_id);
            let _ = reader_thread.join();
            emit(
                json!({ "event": "pty.exit", "params": { "sessionId": exit_session_id, "exitCode": exit_code } }),
            );
        });
        Ok(json!({ "sessionId": session_id, "pid": pid }))
    }

    fn get(&self, session_id: &str) -> Result<Arc<Mutex<Session>>> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| CoreError::new("NOT_FOUND", "Terminal session is unavailable"))
    }

    pub fn write(&self, params: WriteParams) -> Result<Value> {
        let bytes = STANDARD
            .decode(params.data)
            .map_err(|_| CoreError::invalid("PTY data must be base64"))?;
        if bytes.len() > 1024 * 1024 {
            return Err(CoreError::invalid("PTY write exceeds 1 MiB"));
        }
        let session = self.get(&params.session_id)?;
        let mut session = session.lock().unwrap();
        session.writer.write_all(&bytes)?;
        session.writer.flush()?;
        Ok(Value::Null)
    }

    pub fn resize(&self, params: ResizeParams) -> Result<Value> {
        self.get(&params.session_id)?
            .lock()
            .unwrap()
            .master
            .resize(size(params.cols, params.rows))
            .map_err(|error| CoreError::failed(error.to_string()))?;
        Ok(Value::Null)
    }

    pub fn kill(&self, params: SessionParams) -> Result<Value> {
        // Idempotent cleanup, including a terminal that just exited naturally.
        if let Ok(session) = self.get(&params.session_id) {
            session.lock().unwrap().terminate()?;
        }
        Ok(Value::Null)
    }

    pub fn shutdown(&self) {
        let sessions = {
            let mut sessions = self.sessions.lock().unwrap();
            self.closed.store(true, Ordering::Release);
            std::mem::take(&mut *sessions)
        };
        for (_, session) in sessions {
            let _ = session.lock().unwrap().terminate();
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(1, 1000),
        rows: rows.clamp(1, 1000),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(all(test, unix))]
mod startup_tests {
    use super::*;

    #[test]
    fn private_startup_files_are_removed_with_their_owner() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let startup = ShellStartup::create(&workspace).unwrap();
        let directory = startup.directory.clone();
        let file = startup.write("fixture", "owned startup\n").unwrap();
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!directory.starts_with(workspace.root()));
        drop(startup);
        assert!(!directory.exists());
    }

    #[test]
    fn explicit_command_argv_does_not_run_interactive_startup() {
        let fixture = tempfile::tempdir().unwrap();
        let workspace = Workspace::open(fixture.path()).unwrap();
        let params = SpawnParams {
            session_id: None,
            workspace_dir: fixture.path().to_string_lossy().into_owned(),
            executable: "/bin/bash".into(),
            args: vec!["--login".into(), "-c".into(), "printf fixture".into()],
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };
        let mut command = CommandBuilder::new(&params.executable);
        assert!(ShellStartup::configure(
            &mut command,
            &params,
            &workspace,
            Path::new("/owned/git/bin")
        )
        .unwrap()
        .is_none());
        assert_eq!(
            command.get_argv()[1..],
            params
                .args
                .iter()
                .map(std::ffi::OsString::from)
                .collect::<Vec<_>>()
        );
    }
}
