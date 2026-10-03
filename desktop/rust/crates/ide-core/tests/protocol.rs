use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn send(input: &mut impl Write, message: Value) {
    serde_json::to_writer(&mut *input, &message).unwrap();
    input.write_all(b"\n").unwrap();
    input.flush().unwrap();
}

#[test]
fn binary_serves_ndjson_errors_and_concurrent_requests() {
    let fixture = TempDir::new().unwrap();
    std::fs::write(fixture.path().join("fixture.txt"), "protocol fixture").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_crownforge-ide-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    for id in 1..=4 {
        send(
            &mut input,
            json!({ "id": id, "method": "fs.read", "params": { "workspaceDir": fixture.path(), "path": "fixture.txt" } }),
        );
    }
    let mut ids = Vec::new();
    for _ in 1..=4 {
        let mut record = String::new();
        output.read_line(&mut record).unwrap();
        let response: Value = serde_json::from_str(&record).unwrap();
        assert_eq!(response["result"]["content"], "protocol fixture");
        ids.push(response["id"].as_u64().unwrap());
    }
    ids.sort_unstable();
    assert_eq!(ids, vec![1, 2, 3, 4]);
    send(&mut input, json!({ "id": 5, "method": "unknown" }));
    let mut record = String::new();
    output.read_line(&mut record).unwrap();
    let response: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(response["error"]["code"], "INVALID_REQUEST");
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[test]
fn oversized_encoded_file_response_does_not_corrupt_protocol_or_stop_service() {
    let fixture = TempDir::new().unwrap();
    // The raw file fits the 10 MiB read limit, while each control byte becomes six JSON bytes.
    std::fs::write(
        fixture.path().join("escaped.txt"),
        vec![1u8; 6 * 1024 * 1024],
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_crownforge-ide-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    send(
        &mut input,
        json!({ "id": 41, "method": "fs.read", "params": { "workspaceDir": fixture.path(), "path": "escaped.txt" } }),
    );
    let mut record = String::new();
    output.read_line(&mut record).unwrap();
    assert!(
        record.len() < 1024,
        "Oversized result leaked a partial JSON record"
    );
    let response: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(response["id"], 41);
    assert_eq!(response["error"]["code"], "LIMIT_EXCEEDED");
    send(&mut input, json!({ "id": 42, "method": "ping" }));
    record.clear();
    output.read_line(&mut record).unwrap();
    let response: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(response["id"], 42);
    assert_eq!(response["result"]["protocolVersion"], 1);
    drop(input);
    assert!(child.wait().unwrap().success());
}

#[cfg(unix)]
#[test]
fn eof_terminates_terminal_child_tree_before_binary_exit() {
    let fixture = TempDir::new().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_crownforge-ide-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let (sender, receiver) = mpsc::channel();
    let output_reader = thread::spawn(move || {
        for record in output.lines().map_while(Result::ok) {
            let value: Value = serde_json::from_str(&record).unwrap();
            let _ = sender.send(value);
        }
    });
    send(
        &mut input,
        json!({ "id": 1, "method": "pty.spawn", "params": { "workspaceDir": fixture.path(), "sessionId": "12345678-1234-1234-1234-123456789abc", "executable": "/bin/sh", "args": ["-c", "sleep 120 & printf 'CHILD:%s\\n' \"$!\"; wait"], "env": { "PATH": "/usr/bin:/bin" } } }),
    );
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut output = String::new();
    let mut shell_pid = None;
    let mut descendant_pid = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    while shell_pid.is_none() || descendant_pid.is_none() {
        assert!(
            Instant::now() < deadline,
            "Terminal startup timed out: {output}"
        );
        if let Ok(record) = receiver.recv_timeout(Duration::from_millis(200)) {
            if record["id"] == 1 {
                shell_pid = record["result"]["pid"].as_u64();
            }
            if record["event"] == "pty.output" {
                output.push_str(&String::from_utf8_lossy(
                    &STANDARD
                        .decode(record["params"]["data"].as_str().unwrap())
                        .unwrap(),
                ));
                if let Some(rest) = output.split("CHILD:").nth(1) {
                    if let Some((pid, _)) = rest.split_once('\n') {
                        descendant_pid = pid.trim().parse::<u32>().ok();
                    }
                }
            }
        }
    }
    let started = Instant::now();
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(2);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("EOF did not terminate service promptly");
        }
        thread::sleep(Duration::from_millis(20));
    }
    assert!(started.elapsed() < Duration::from_secs(2));
    output_reader.join().unwrap();
    for pid in [shell_pid.unwrap() as u32, descendant_pid.unwrap()] {
        let status = Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let status = String::from_utf8_lossy(&status.stdout);
        assert!(
            status.trim().is_empty() || status.trim().starts_with('Z'),
            "EOF left running terminal process {pid}: {status}"
        );
    }
}
