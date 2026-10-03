use crate::{
    error::{CoreError, Result},
    workspace::Workspace,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitParams {
    pub workspace_dir: String,
    pub args: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

fn validate_args(args: &[String]) -> Result<&[String]> {
    let args = if args.first().map(String::as_str) == Some("-c")
        && args
            .get(1)
            .map(|arg| arg.eq_ignore_ascii_case("core.quotepath=false"))
            .unwrap_or(false)
    {
        &args[2..]
    } else {
        args
    };
    let command = args.first().map(String::as_str).unwrap_or("");
    if ![
        "status",
        "diff",
        "log",
        "show",
        "rev-parse",
        "check-ignore",
        "ls-files",
    ]
    .contains(&command)
    {
        return Err(CoreError::invalid(
            "Only read-only Git commands are available through the desktop core",
        ));
    }
    let forbidden = [
        "--output",
        "--ext-diff",
        "--textconv",
        "--no-index",
        "--git-dir",
        "--work-tree",
        "--exec-path",
        "--resolve-git-dir",
        "--config-env",
    ];
    for arg in &args[1..] {
        if arg.contains('\0')
            || arg == "-c"
            || arg.starts_with("-C")
            || arg.starts_with("-c")
            || forbidden
                .iter()
                .any(|option| arg == option || arg.starts_with(&format!("{option}=")))
        {
            return Err(CoreError::invalid(
                "Git option can change scope, execute external code or write files",
            ));
        }
        let normalized = arg.replace('\\', "/");
        if normalized.starts_with('/')
            || normalized.as_bytes().get(1) == Some(&b':')
            || normalized.split('/').any(|part| part == "..")
        {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Git arguments must stay inside the workspace",
            ));
        }
    }
    Ok(args)
}

fn read_capped(
    mut stream: impl Read,
    max: usize,
    overflow: Arc<AtomicBool>,
) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let available = max.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..count.min(available)]);
        if count > available {
            overflow.store(true, Ordering::Relaxed);
        }
    }
    Ok(bytes)
}

pub fn execute(params: GitParams, cancelled: Arc<AtomicBool>) -> Result<GitOutput> {
    let workspace = Workspace::open(&params.workspace_dir)?;
    let args = validate_args(&params.args)?;
    if cancelled.load(Ordering::Relaxed) {
        return Err(CoreError::aborted());
    }
    let mut command = Command::new("git");
    command
        .current_dir(workspace.root())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A dedicated group lets cancellation also clean up Git's nested subprocesses.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    }
    // Prevent inherited Git overrides from changing the repository or invoking config helpers.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .args([
            "--no-pager",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.quotepath=false",
            "-c",
            "diff.external=",
        ])
        .arg(&args[0]);
    if ["diff", "log", "show"].contains(&args[0].as_str()) {
        command.args(["--no-ext-diff", "--no-textconv"]);
    }
    command.args(&args[1..]);
    let mut child = command.spawn()?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::failed("Git stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CoreError::failed("Git stderr unavailable"))?;
    let stdout_overflow = overflow.clone();
    let stderr_overflow = overflow.clone();
    let stdout_reader =
        thread::spawn(move || read_capped(stdout, 32 * 1024 * 1024, stdout_overflow));
    let stderr_reader = thread::spawn(move || read_capped(stderr, 64 * 1024, stderr_overflow));
    let started = Instant::now();
    let mut interrupted = None;
    let status = loop {
        if cancelled.load(Ordering::Relaxed)
            || overflow.load(Ordering::Relaxed)
            || started.elapsed() > Duration::from_secs(30)
        {
            interrupted = Some(if cancelled.load(Ordering::Relaxed) {
                CoreError::aborted()
            } else if overflow.load(Ordering::Relaxed) {
                CoreError::failed("Git output exceeds desktop service limit")
            } else {
                CoreError::failed("Git command exceeded 30-second timeout")
            });
            terminate_git_tree(&mut child);
            break child.wait()?;
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| CoreError::failed("Git output reader failed"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| CoreError::failed("Git error reader failed"))??;
    if let Some(error) = interrupted {
        return Err(error);
    }
    if overflow.load(Ordering::Relaxed) {
        return Err(CoreError::failed(
            "Git output exceeds desktop service limit",
        ));
    }
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: status.code().unwrap_or(-1),
    })
}

fn terminate_git_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        // SAFETY: this process was spawned into a fresh group with its PID as group ID.
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill.exe")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_writes_external_programs_and_scope_overrides() {
        for args in [
            vec!["checkout", "main"],
            vec!["diff", "--output=/tmp/change.patch"],
            vec!["log", "--ext-diff"],
            vec!["diff", "--no-index", "a", "b"],
            vec!["-c", "diff.external=echo", "diff"],
            vec!["ls-files", "--", "../outside"],
        ] {
            assert!(
                validate_args(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_err()
            );
        }
        assert!(validate_args(
            &[
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v2",
                "-z"
            ]
            .map(String::from)
        )
        .is_ok());
    }
}
