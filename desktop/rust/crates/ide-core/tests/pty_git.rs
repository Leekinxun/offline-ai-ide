#![cfg(unix)]

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

struct Harness {
    child: Child,
    input: Option<ChildStdin>,
    messages: mpsc::Receiver<Value>,
    output: String,
}

impl Harness {
    fn start(git: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_crownforge-ide-core"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("TMPDIR", std::env::temp_dir())
            .env("CROWNFORGE_GIT_EXECUTABLE", git)
            .env("CROWNFORGE_BUNDLED_TOOLS_REQUIRED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let output = BufReader::new(child.stdout.take().unwrap());
        let (sender, messages) = mpsc::channel();
        thread::spawn(move || {
            for record in output.lines().map_while(Result::ok) {
                let _ = sender.send(serde_json::from_str(&record).unwrap());
            }
        });
        Self {
            child,
            input,
            messages,
            output: String::new(),
        }
    }

    fn send(&mut self, id: u64, method: &str, params: Value) {
        let input = self.input.as_mut().unwrap();
        serde_json::to_writer(
            &mut *input,
            &json!({"id":id,"method":method,"params":params}),
        )
        .unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
    }

    fn wait(&mut self, predicate: impl Fn(&Value, &str) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            assert!(
                Instant::now() < deadline,
                "PTY evidence timed out: {}",
                self.output
            );
            if let Ok(frame) = self.messages.recv_timeout(Duration::from_millis(100)) {
                if frame["event"] == "pty.output" {
                    let bytes = STANDARD
                        .decode(frame["params"]["data"].as_str().unwrap())
                        .unwrap();
                    self.output.push_str(&String::from_utf8_lossy(&bytes));
                }
                if predicate(&frame, &self.output) {
                    return frame;
                }
            }
        }
    }

    fn terminal(
        &mut self,
        workspace: &Path,
        home: &Path,
        shell: &str,
        args: &[&str],
        dotdir: Option<&Path>,
    ) -> String {
        let mut env =
            json!({"PATH":"/usr/bin:/bin","HOME":home,"TERM":"dumb","LANG":"en_US.UTF-8"});
        if let Some(dotdir) = dotdir {
            env["ZDOTDIR"] = json!(dotdir);
        }
        self.send(
            1,
            "pty.spawn",
            json!({"workspaceDir":workspace,"executable":shell,"args":args,"env":env}),
        );
        let response = self.wait(|frame, _| frame["id"] == 1);
        assert!(response.get("error").is_none(), "{response}");
        let session = response["result"]["sessionId"].as_str().unwrap().to_owned();
        if !self.output.contains("CROWN_READY>") {
            self.wait(|_, output| output.contains("CROWN_READY>"));
        }
        session
    }

    fn finish(&mut self, session: &str) {
        self.send(2, "pty.write", json!({"sessionId":session,"data":STANDARD.encode(
            "printf 'CROWN_PATH:%s\\n' \"$(command -v git)\"\ngit --version\ncrown_alias\ncrown_function\nprintf 'CROWN_DOT:%s\\n' \"${ZDOTDIR-unset}\"\nexit\n"
        )}));
        let exit = self.wait(|frame, _| frame["event"] == "pty.exit");
        assert_eq!(exit["params"]["exitCode"], 0, "{}", self.output);
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        drop(self.input.take());
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    let fixture = tempfile::tempdir().unwrap();
    let git = fixture.path().join("Git 中文 ' owner/bin/git");
    fs::create_dir_all(git.parent().unwrap()).unwrap();
    fs::write(&git, "#!/bin/sh\nprintf 'BUNDLED_GIT_EXECUTED\\n'\n").unwrap();
    fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).unwrap();
    let home = fixture.path().join("home");
    let workspace = fixture.path().join("workspace");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&workspace).unwrap();
    (fixture, git.canonicalize().unwrap(), home, workspace)
}

fn assert_shell_state(harness: &Harness, git: &Path) {
    assert!(
        harness
            .output
            .contains(&format!("CROWN_PATH:{}", git.display())),
        "{}",
        harness.output
    );
    for value in [
        "BUNDLED_GIT_EXECUTED",
        "PRESERVED_ALIAS",
        "PRESERVED_FUNCTION",
    ] {
        assert!(harness.output.contains(value), "{}", harness.output);
    }
}

#[test]
fn bash_login_preserves_profiles_and_prefixes_git_after_path_reset() {
    let (_fixture, git, home, workspace) = fixture();
    fs::write(home.join(".bash_profile"), "printf 'profile\\n' >> \"$HOME/profile-events\"\nprintf '%s' \"${BASH_SOURCE[1]}\" > \"$HOME/startup-path\"\nbuiltin source \"$HOME/.bashrc\"\nexport PATH=/usr/bin:/bin\n").unwrap();
    fs::write(home.join(".bashrc"), "printf 'rc\\n' >> \"$HOME/profile-events\"\nalias crown_alias='printf PRESERVED_ALIAS\\\\n'\ncrown_function() { printf 'PRESERVED_FUNCTION\\n'; }\nPS1='CROWN_READY> '\n").unwrap();
    let mut harness = Harness::start(&git);
    let session = harness.terminal(&workspace, &home, "/bin/bash", &["--login"], None);
    harness.finish(&session);
    assert_shell_state(&harness, &git);
    assert_eq!(
        fs::read_to_string(home.join("profile-events")).unwrap(),
        "profile\nrc\n"
    );
    let startup = fs::read_to_string(home.join("startup-path")).unwrap();
    assert!(
        !Path::new(&startup).exists(),
        "Startup file survived the terminal session"
    );
}

#[test]
fn bash_nonlogin_loads_bashrc_without_login_profile() {
    let (_fixture, git, home, workspace) = fixture();
    fs::write(home.join(".bash_profile"), "exit 91\n").unwrap();
    fs::write(home.join(".bashrc"), "printf 'rc\\n' >> \"$HOME/profile-events\"\nexport PATH=/usr/bin:/bin\nalias crown_alias='printf PRESERVED_ALIAS\\\\n'\ncrown_function() { printf 'PRESERVED_FUNCTION\\n'; }\nPS1='CROWN_READY> '\n").unwrap();
    let mut harness = Harness::start(&git);
    let session = harness.terminal(&workspace, &home, "/bin/bash", &[], None);
    harness.finish(&session);
    assert_shell_state(&harness, &git);
    assert_eq!(
        fs::read_to_string(home.join("profile-events")).unwrap(),
        "rc\n"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn zsh_login_preserves_dynamic_zdotdir_and_prefixes_after_zlogin() {
    let (_fixture, git, home, workspace) = fixture();
    let original = home.join("original-dot");
    let changed = home.join("changed-dot");
    fs::create_dir(&original).unwrap();
    fs::create_dir(&changed).unwrap();
    let literal = format!(
        "'{}'",
        changed.display().to_string().replace('\'', "'\"'\"'")
    );
    fs::write(
        original.join(".zshenv"),
        format!("printf 'env\\n' >> \"$HOME/profile-events\"\nexport ZDOTDIR={literal}\n"),
    )
    .unwrap();
    fs::write(
        changed.join(".zprofile"),
        "printf 'profile\\n' >> \"$HOME/profile-events\"\n",
    )
    .unwrap();
    fs::write(changed.join(".zshrc"), "printf 'rc\\n' >> \"$HOME/profile-events\"\nalias crown_alias='printf PRESERVED_ALIAS\\\\n'\ncrown_function() { printf 'PRESERVED_FUNCTION\\n'; }\nPS1='CROWN_READY> '\n").unwrap();
    fs::write(changed.join(".zlogin"), "printf 'login\\n' >> \"$HOME/profile-events\"\n[[ -o login ]] || exit 92\nexport PATH=/usr/bin:/bin\n").unwrap();
    let mut harness = Harness::start(&git);
    let session = harness.terminal(&workspace, &home, "/bin/zsh", &["--login"], Some(&original));
    harness.finish(&session);
    assert_shell_state(&harness, &git);
    assert!(
        harness
            .output
            .contains(&format!("CROWN_DOT:{}", changed.display())),
        "{}",
        harness.output
    );
    assert_eq!(
        fs::read_to_string(home.join("profile-events")).unwrap(),
        "env\nprofile\nrc\nlogin\n"
    );
}
