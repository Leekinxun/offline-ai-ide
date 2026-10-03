use crownforge_ide_core::{Core, Request};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn service() -> (Core, mpsc::Receiver<Value>) {
    let (sender, receiver) = mpsc::channel();
    let core = Core::new(Arc::new(move |event| {
        let _ = sender.send(event);
    }));
    (core, receiver)
}

fn request(core: &Core, id: u64, method: &str, params: Value) -> Value {
    core.execute(Request {
        id,
        method: method.to_owned(),
        params,
    })
}

fn result(response: Value) -> Value {
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

#[test]
fn file_reads_and_directory_entries_use_real_workspace() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join("src")).unwrap();
    fs::write(fixture.path().join("中文.txt"), "真实文件😀\n").unwrap();
    let (core, _) = service();
    let entries = result(request(
        &core,
        1,
        "fs.entries",
        json!({ "workspaceDir": fixture.path() }),
    ));
    assert!(entries
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "src" && entry["isDirectory"] == true));
    let file = result(request(
        &core,
        2,
        "fs.read",
        json!({ "workspaceDir": fixture.path(), "path": "中文.txt" }),
    ));
    assert_eq!(file["content"], "真实文件😀\n");
    assert!(file["mtimeMs"].as_f64().unwrap() > 0.0);
    assert_eq!(
        request(
            &core,
            3,
            "fs.read",
            json!({ "workspaceDir": fixture.path(), "path": "../escape" })
        )["error"]["code"],
        "PATH_ESCAPE"
    );
}

#[cfg(unix)]
#[test]
fn symbolic_links_cannot_escape_workspace_reads_or_searches() {
    let fixture = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("private.txt"), "sensitive needle").unwrap();
    std::os::unix::fs::symlink(outside.path(), fixture.path().join("escape")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("private.txt"),
        fixture.path().join("link.txt"),
    )
    .unwrap();
    let (core, _) = service();
    for (id, path) in [(1, "escape/private.txt"), (2, "link.txt")] {
        assert_eq!(
            request(
                &core,
                id,
                "fs.read",
                json!({ "workspaceDir": fixture.path(), "path": path })
            )["error"]["code"],
            "PATH_ESCAPE"
        );
    }
    assert_eq!(
        request(
            &core,
            3,
            "fs.entries",
            json!({ "workspaceDir": fixture.path(), "path": "escape" })
        )["error"]["code"],
        "PATH_ESCAPE"
    );
    let response = result(request(
        &core,
        4,
        "search",
        json!({ "workspaceDir": fixture.path(), "query": "needle", "useIgnoreFiles": false }),
    ));
    assert_eq!(response["results"], json!([]));
}

#[test]
fn embedded_search_preserves_utf16_columns_globs_policy_and_limits() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join(".git")).unwrap();
    fs::create_dir(fixture.path().join(".codex")).unwrap();
    fs::create_dir(fixture.path().join("src")).unwrap();
    fs::write(fixture.path().join(".gitignore"), "ignored.txt\n").unwrap();
    fs::write(fixture.path().join("src/中文.ts"), "😀你好 hello 你好\n").unwrap();
    for path in [
        "ignored.txt",
        ".env",
        "credentials.json",
        ".codex/private.txt",
        "src/test.lock",
    ] {
        fs::write(fixture.path().join(path), "你好\n").unwrap();
    }
    fs::write(fixture.path().join(".hidden.txt"), "hello\n").unwrap();
    fs::write(fixture.path().join("binary.txt"), b"\0hello\0").unwrap();
    let (core, _) = service();
    let response = result(request(
        &core,
        1,
        "search",
        json!({ "workspaceDir": fixture.path(), "query": "你好", "include": "**/*.{ts,tsx},**/*.txt", "exclude": "ignored.txt" }),
    ));
    let matches = response["results"].as_array().unwrap();
    assert_eq!(matches.len(), 2, "{response}");
    assert_eq!(matches[0]["path"], "src/中文.ts");
    assert_eq!(matches[0]["column"], 3);
    assert_eq!(matches[1]["column"], 12);
    assert_eq!(matches[0]["matchLength"], 2);
    assert_eq!(response["truncated"], false);
    let limited = result(request(
        &core,
        2,
        "search",
        json!({ "workspaceDir": fixture.path(), "query": "你好", "maxResults": 1 }),
    ));
    assert_eq!(limited["results"].as_array().unwrap().len(), 1);
    assert_eq!(limited["truncated"], true);
    let hidden = result(request(
        &core,
        3,
        "search",
        json!({ "workspaceDir": fixture.path(), "query": "hello", "scopePath": ".hidden.txt" }),
    ));
    assert_eq!(hidden["results"].as_array().unwrap().len(), 1);
    let no_ignore = result(request(
        &core,
        4,
        "search",
        json!({ "workspaceDir": fixture.path(), "query": "你好", "useIgnoreFiles": false }),
    ));
    assert_eq!(
        no_ignore["results"].as_array().unwrap().len(),
        3,
        "{no_ignore}"
    );
    let whole_word = result(request(
        &core,
        5,
        "search",
        json!({ "workspaceDir": fixture.path(), "query": "hell", "wholeWord": true }),
    ));
    assert_eq!(whole_word["results"], json!([]));
    let invalid_regex = request(
        &core,
        6,
        "search",
        json!({ "workspaceDir": fixture.path(), "query": "[", "isRegex": true }),
    );
    assert_eq!(invalid_regex["error"]["code"], "INVALID_REQUEST");
}

#[test]
fn queued_search_is_cancellable_before_work_starts() {
    let fixture = TempDir::new().unwrap();
    let (core, _) = service();
    let task = core
        .prepare(Request {
            id: 42,
            method: "search".to_owned(),
            params: json!({ "workspaceDir": fixture.path(), "query": "needle" }),
        })
        .unwrap();
    result(request(&core, 43, "rpc.cancel", json!({ "requestId": 42 })));
    assert_eq!(core.execute_task(task)["error"]["code"], "ABORTED");
}

#[test]
fn cancellation_prevents_queued_terminal_and_watcher_creation() {
    let fixture = TempDir::new().unwrap();
    let (core, events) = service();
    for (id, method, params) in [
        (
            11,
            "watch.start",
            json!({ "workspaceDir": fixture.path(), "watchId": "12345678-1234-1234-1234-123456789abc" }),
        ),
        (
            12,
            "pty.spawn",
            json!({ "workspaceDir": fixture.path(), "executable": "invalid-executable", "sessionId": "12345678-1234-1234-1234-123456789abd" }),
        ),
    ] {
        let task = core
            .prepare(Request {
                id,
                method: method.to_owned(),
                params,
            })
            .unwrap();
        result(request(
            &core,
            id + 100,
            "rpc.cancel",
            json!({ "requestId": id }),
        ));
        assert_eq!(core.execute_task(task)["error"]["code"], "ABORTED");
    }
    fs::write(fixture.path().join("after-cancel.txt"), "fixture").unwrap();
    assert!(events.recv_timeout(Duration::from_millis(200)).is_err());
}

#[test]
fn caller_watcher_uuid_is_preserved_and_duplicates_are_rejected() {
    let fixture = TempDir::new().unwrap();
    let (core, _) = service();
    let id = "12345678-1234-1234-1234-123456789abc";
    let params = json!({ "workspaceDir": fixture.path(), "watchId": id });
    assert_eq!(
        result(request(&core, 1, "watch.start", params.clone()))["watchId"],
        id
    );
    assert_eq!(
        request(&core, 2, "watch.start", params)["error"]["code"],
        "INVALID_REQUEST"
    );
    assert_eq!(
        request(
            &core,
            3,
            "watch.start",
            json!({ "workspaceDir": fixture.path(), "watchId": "not-a-uuid" })
        )["error"]["code"],
        "INVALID_REQUEST"
    );
    result(request(&core, 4, "watch.stop", json!({ "watchId": id })));
}

#[test]
fn git_status_runs_in_disposable_repo_without_mutating_index() {
    let fixture = TempDir::new().unwrap();
    let status = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(fixture.path())
        .status()
        .unwrap();
    assert!(status.success());
    fs::write(fixture.path().join("file.txt"), "fixture\n").unwrap();
    let (core, _) = service();
    let response = result(request(
        &core,
        1,
        "git.exec",
        json!({ "workspaceDir": fixture.path(), "args": ["-c", "core.quotepath=false", "status", "--porcelain=v2", "--branch", "-z", "-uall"] }),
    ));
    assert_eq!(response["exitCode"], 0);
    assert!(response["stdout"].as_str().unwrap().contains("? file.txt"));
    assert!(!fixture.path().join(".git/index").exists());
    assert_eq!(
        request(
            &core,
            2,
            "git.exec",
            json!({ "workspaceDir": fixture.path(), "args": ["add", "."] })
        )["error"]["code"],
        "INVALID_REQUEST"
    );
}

#[test]
fn native_watcher_reports_real_file_changes_and_stops() {
    let fixture = TempDir::new().unwrap();
    let (core, events) = service();
    let watch = result(request(
        &core,
        1,
        "watch.start",
        json!({ "workspaceDir": fixture.path() }),
    ));
    fs::write(fixture.path().join("changed.txt"), "changed\n").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut observed = false;
    while Instant::now() < deadline {
        if let Ok(event) = events.recv_timeout(Duration::from_millis(200)) {
            if event["event"] == "fs.changed"
                && event["params"]["watchId"] == watch["watchId"]
                && event["params"]["paths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|path| path == "changed.txt")
            {
                observed = true;
                break;
            }
        }
    }
    assert!(observed, "Native watcher did not report changed.txt");
    result(request(
        &core,
        2,
        "watch.stop",
        json!({ "watchId": watch["watchId"] }),
    ));
    while events.try_recv().is_ok() {}
    fs::write(fixture.path().join("after-stop.txt"), "stopped\n").unwrap();
    assert!(events.recv_timeout(Duration::from_millis(250)).is_err());
}

#[cfg(unix)]
fn terminal_output(event: &Value) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    String::from_utf8_lossy(
        &STANDARD
            .decode(event["params"]["data"].as_str().unwrap())
            .unwrap(),
    )
    .into_owned()
}

#[cfg(unix)]
#[test]
fn real_pty_emits_output_exit_and_sanitized_environment() {
    let fixture = TempDir::new().unwrap();
    let (core, events) = service();
    let spawn = result(request(
        &core,
        1,
        "pty.spawn",
        json!({ "workspaceDir": fixture.path(), "sessionId": "12345678-1234-1234-1234-123456789abc", "executable": "/bin/sh", "args": ["-c", "printf '终端😀:%s:%s\\n' \"$ALLOWED\" \"${HOME-unset}\"; exit 7"], "env": { "PATH": "/usr/bin:/bin", "ALLOWED": "provided" } }),
    ));
    assert_eq!(spawn["sessionId"], "12345678-1234-1234-1234-123456789abc");
    let mut output = String::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut exit_code = None;
    while Instant::now() < deadline {
        let event = events.recv_timeout(Duration::from_millis(250)).unwrap();
        assert_eq!(event["params"]["sessionId"], spawn["sessionId"]);
        match event["event"].as_str().unwrap() {
            "pty.output" => output.push_str(&terminal_output(&event)),
            "pty.exit" => {
                exit_code = event["params"]["exitCode"].as_i64();
                break;
            }
            _ => {}
        }
    }
    assert!(output.contains("终端😀:provided:unset"), "{output}");
    assert_eq!(exit_code, Some(7));
}

#[cfg(unix)]
#[test]
fn real_pty_supports_write_resize_and_kills_child_tree() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture = TempDir::new().unwrap();
    let (core, events) = service();
    let spawn = result(request(
        &core,
        1,
        "pty.spawn",
        json!({ "workspaceDir": fixture.path(), "executable": "/bin/sh", "args": ["-c", "read value; printf 'INPUT:%s\\n' \"$value\"; sleep 120 & printf 'CHILD:%s\\n' \"$!\"; wait"], "env": { "PATH": "/usr/bin:/bin" } }),
    ));
    let session = spawn["sessionId"].clone();
    result(request(
        &core,
        2,
        "pty.resize",
        json!({ "sessionId": session, "cols": 120, "rows": 40 }),
    ));
    result(request(
        &core,
        3,
        "pty.write",
        json!({ "sessionId": session, "data": STANDARD.encode(b"payload\n") }),
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = String::new();
    let child_pid = loop {
        assert!(
            Instant::now() < deadline,
            "PTY did not start child: {output}"
        );
        if let Ok(event) = events.recv_timeout(Duration::from_millis(200)) {
            if event["event"] == "pty.output" {
                output.push_str(&terminal_output(&event));
            }
            if let Some(rest) = output.split("CHILD:").nth(1) {
                if let Some((pid, _)) = rest.split_once('\n') {
                    break pid.trim().parse::<u32>().unwrap();
                }
            }
        }
    };
    assert!(output.contains("INPUT:payload"), "{output}");
    result(request(
        &core,
        4,
        "pty.kill",
        json!({ "sessionId": session }),
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut exited = false;
    while Instant::now() < deadline {
        if let Ok(event) = events.recv_timeout(Duration::from_millis(200)) {
            if event["event"] == "pty.exit" {
                exited = true;
                break;
            }
        }
    }
    assert!(exited, "PTY did not exit after kill");
    // A killed child may briefly remain a zombie until the OS reaps it; it cannot keep running.
    let status = std::process::Command::new("/bin/ps")
        .args(["-p", &child_pid.to_string(), "-o", "stat="])
        .output()
        .unwrap();
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(
        status.trim().is_empty() || status.trim().starts_with('Z'),
        "Terminal descendant still runs: {status}"
    );
}
