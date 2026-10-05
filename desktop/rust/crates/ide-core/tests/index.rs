use crownforge_ide_core::{Core, Request};
use serde_json::{json, Value};
use std::{fs, sync::Arc, thread, time::Duration};
use tempfile::TempDir;

fn core() -> Core {
    Core::new(Arc::new(|_| {}))
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
fn scan_pages_reads_and_closes_index_sessions() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join("src")).unwrap();
    fs::write(fixture.path().join("src/one.ts"), "export const one = 1;\n").unwrap();
    fs::write(fixture.path().join("src/two.ts"), "export const two = 2;\n").unwrap();
    let core = core();
    let scan = result(request(
        &core,
        1,
        "index.scan",
        json!({ "workspaceDir": fixture.path() }),
    ));
    assert_eq!(scan["total"], 2);
    let session_id = scan["sessionId"].as_str().unwrap();
    let first = result(request(
        &core,
        2,
        "index.page",
        json!({ "sessionId": session_id, "limit": 1 }),
    ));
    assert_eq!(first["entries"].as_array().unwrap().len(), 1);
    assert_eq!(first["done"], false);
    let read = result(request(
        &core,
        3,
        "index.readBatch",
        json!({ "sessionId": session_id, "paths": ["src/one.ts", "src/two.ts"] }),
    ));
    assert_eq!(read["files"].as_array().unwrap().len(), 2);
    assert_eq!(read["files"][0]["contentHash"].as_str().unwrap().len(), 64);
    result(request(
        &core,
        4,
        "index.close",
        json!({ "sessionId": session_id }),
    ));
    assert_eq!(
        request(&core, 5, "index.page", json!({ "sessionId": session_id }))["error"]["code"],
        "NOT_FOUND"
    );
}

#[test]
fn scan_rejects_symlink_malformed_utf8_binary_and_oversized_files() {
    let fixture = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join("src")).unwrap();
    fs::write(
        fixture.path().join("src/ok.ts"),
        "export const ok = true;\n",
    )
    .unwrap();
    fs::write(fixture.path().join("src/bad.ts"), vec![0xff, 0xfe]).unwrap();
    fs::write(fixture.path().join("src/binary.ts"), b"\0secret\0").unwrap();
    fs::write(
        fixture.path().join("src/large.ts"),
        "x".repeat(1024 * 1024 + 1),
    )
    .unwrap();
    fs::write(
        outside.path().join("escape.ts"),
        "export const escape = true;\n",
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        outside.path().join("escape.ts"),
        fixture.path().join("src/link.ts"),
    )
    .unwrap();
    let core = core();
    let scan = result(request(
        &core,
        1,
        "index.scan",
        json!({ "workspaceDir": fixture.path() }),
    ));
    let session_id = scan["sessionId"].as_str().unwrap();
    let page = result(request(
        &core,
        2,
        "index.page",
        json!({ "sessionId": session_id, "limit": 1000 }),
    ));
    let paths: Vec<_> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(paths, vec!["src/ok.ts"]);
}

#[test]
fn policy_fingerprint_tracks_ignore_and_git_info_exclude() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir_all(fixture.path().join(".git/info")).unwrap();
    fs::write(fixture.path().join(".git/info/exclude"), "ignored-a.ts\n").unwrap();
    fs::write(fixture.path().join(".gitignore"), "ignored-b.ts\n").unwrap();
    let core = core();
    let first = result(request(
        &core,
        1,
        "index.policy",
        json!({ "workspaceDir": fixture.path() }),
    ));
    fs::write(
        fixture.path().join(".git/info/exclude"),
        "ignored-a.ts\nignored-c.ts\n",
    )
    .unwrap();
    let second = result(request(
        &core,
        2,
        "index.policy",
        json!({ "workspaceDir": fixture.path() }),
    ));
    assert_ne!(first["policyFingerprint"], second["policyFingerprint"]);
    fs::write(
        fixture.path().join(".gitignore"),
        "ignored-b.ts\nignored-d.ts\n",
    )
    .unwrap();
    let third = result(request(
        &core,
        3,
        "index.policy",
        json!({ "workspaceDir": fixture.path() }),
    ));
    assert_ne!(second["policyFingerprint"], third["policyFingerprint"]);
}

#[test]
fn scan_session_is_bound_to_canonical_root() {
    let fixture = TempDir::new().unwrap();
    let child = fixture.path().join("child");
    fs::create_dir(&child).unwrap();
    fs::write(child.join("file.ts"), "export const rooted = true;\n").unwrap();
    let core = core();
    let scan = result(request(
        &core,
        1,
        "index.scan",
        json!({ "workspaceDir": child.join("..").join("child") }),
    ));
    assert_eq!(
        scan["workspaceRoot"].as_str().unwrap(),
        fs::canonicalize(&child).unwrap().to_string_lossy()
    );
}

#[test]
fn queued_scan_can_be_cancelled_before_start() {
    let fixture = TempDir::new().unwrap();
    let core = core();
    let task = core
        .prepare(Request {
            id: 10,
            method: "index.scan".to_owned(),
            params: json!({ "workspaceDir": fixture.path() }),
        })
        .unwrap();
    result(request(&core, 11, "rpc.cancel", json!({ "requestId": 10 })));
    assert_eq!(core.execute_task(task)["error"]["code"], "ABORTED");
}

#[test]
fn shutdown_drops_scan_sessions() {
    let fixture = TempDir::new().unwrap();
    fs::write(
        fixture.path().join("file.ts"),
        "export const gone = true;\n",
    )
    .unwrap();
    let core = core();
    let scan = result(request(
        &core,
        1,
        "index.scan",
        json!({ "workspaceDir": fixture.path() }),
    ));
    let session_id = scan["sessionId"].as_str().unwrap().to_owned();
    core.shutdown();
    thread::sleep(Duration::from_millis(1));
    assert_eq!(
        request(&core, 2, "index.page", json!({ "sessionId": session_id }))["error"]["code"],
        "ABORTED"
    );
}
