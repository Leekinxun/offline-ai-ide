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
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
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
    #[cfg(unix)]
    system_session_id: Option<i32>,
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
        let session_id = resource_id::allocate(params.session_id, &self.next_id, "session")?;
        if self.sessions.lock().unwrap().contains_key(&session_id) {
            return Err(CoreError::invalid("sessionId is already active"));
        }
        if params.executable.is_empty() || params.executable.contains('\0') {
            return Err(CoreError::invalid("executable is required"));
        }
        if params.args.iter().any(|value| value.contains('\0')) {
            return Err(CoreError::invalid("PTY arguments contain NUL"));
        }
        let workspace = Workspace::open(params.workspace_dir)?;
        let pair = native_pty_system()
            .openpty(size(params.cols, params.rows))
            .map_err(|error| CoreError::failed(error.to_string()))?;
        let mut command = CommandBuilder::new(&params.executable);
        command.cwd(workspace.root());
        command.args(&params.args);
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
