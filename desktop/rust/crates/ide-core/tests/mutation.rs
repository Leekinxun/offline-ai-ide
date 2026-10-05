use crownforge_ide_core::{Core, Request};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, sync::Arc};
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

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes.as_ref());
    format!("{:x}", hasher.finalize())
}

#[test]
fn write_file_commits_with_expected_hash_receipt_and_status() {
    let fixture = TempDir::new().unwrap();
    fs::write(fixture.path().join("file.txt"), "before").unwrap();
    let core = core();
    let response = result(request(
        &core,
        1,
        "fs.mutate",
        json!({
            "workspaceDir": fixture.path(),
            "transactionId": "save-1",
            "operations": [{
                "type": "writeFile",
                "path": "file.txt",
                "content": "after",
                "expected": { "exists": true, "file": true, "sha256": sha256("before") }
            }]
        }),
    ));
    assert_eq!(response["status"], "committed");
    assert_eq!(
        fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
        "after"
    );
    assert_eq!(response["entries"][0]["operation"], "writeFile");
    assert_eq!(response["entries"][0]["sha256"], sha256("after"));
    assert!(response["entries"][0]["mtimeMs"].as_f64().unwrap() > 0.0);
    let status = result(request(
        &core,
        2,
        "fs.transaction.status",
        json!({ "workspaceDir": fixture.path(), "transactionId": "save-1" }),
    ));
    assert_eq!(status["status"], "committed");
}

#[test]
fn expected_hash_conflict_prevents_publish() {
    let fixture = TempDir::new().unwrap();
    fs::write(fixture.path().join("file.txt"), "before").unwrap();
    let core = core();
    let response = request(
        &core,
        1,
        "fs.mutate",
        json!({
            "workspaceDir": fixture.path(),
            "transactionId": "save-conflict",
            "operations": [{
                "type": "writeFile",
                "path": "file.txt",
                "content": "after",
                "expected": { "exists": true, "sha256": sha256("different") }
            }]
        }),
    );
    assert_eq!(response["error"]["code"], "CONFLICT");
    assert_eq!(
        fs::read_to_string(fixture.path().join("file.txt")).unwrap(),
        "before"
    );
}

#[test]
fn entry_crud_operations_are_committed_as_one_transaction() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join("src")).unwrap();
    fs::write(fixture.path().join("src/a.txt"), "A").unwrap();
    fs::write(fixture.path().join("src/delete-me.txt"), "delete").unwrap();
    let core = core();
    let response = result(request(
        &core,
        1,
        "fs.mutate",
        json!({
            "workspaceDir": fixture.path(),
            "transactionId": "crud-1",
            "operations": [
                { "type": "mkdir", "path": "dst", "recursive": false },
                { "type": "copy", "path": "src/a.txt", "newPath": "dst/a-copy.txt" },
                { "type": "rename", "path": "src/a.txt", "newPath": "dst/a-moved.txt" },
                { "type": "delete", "path": "src/delete-me.txt", "recursive": false }
            ]
        }),
    ));
    assert_eq!(response["status"], "committed");
    assert!(fixture.path().join("dst").is_dir());
    assert_eq!(
        fs::read_to_string(fixture.path().join("dst/a-moved.txt")).unwrap(),
        "A"
    );
    assert_eq!(
        fs::read_to_string(fixture.path().join("dst/a-copy.txt")).unwrap(),
        "A"
    );
    assert!(!fixture.path().join("src/a.txt").exists());
    assert!(!fixture.path().join("src/delete-me.txt").exists());
    let operations: Vec<_> = response["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["operation"].as_str().unwrap())
        .collect();
    assert_eq!(operations, vec!["mkdir", "copy", "rename", "delete"]);
}

#[test]
fn rejects_control_paths_and_symbolic_links() {
    let fixture = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("secret.txt"), "secret").unwrap();
    let core = core();
    assert_eq!(
        request(
            &core,
            1,
            "fs.mutate",
            json!({ "workspaceDir": fixture.path(), "operations": [{ "type": "writeFile", "path": ".history/a", "content": "x" }] })
        )["error"]["code"],
        "PATH_ESCAPE"
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            fixture.path().join("link.txt"),
        )
        .unwrap();
        assert_eq!(
            request(
                &core,
                2,
                "fs.mutate",
                json!({ "workspaceDir": fixture.path(), "operations": [{ "type": "writeFile", "path": "link.txt", "content": "x", "overwrite": true }] })
            )["error"]["code"],
            "PATH_ESCAPE"
        );
    }
}

#[test]
fn writer_lock_reports_busy_without_waiting() {
    let fixture = TempDir::new().unwrap();
    let lock_dir = fixture.path().join(".crewforge/desktop-transactions");
    fs::create_dir_all(&lock_dir).unwrap();
    fs::write(lock_dir.join("workspace.lock"), "{}").unwrap();
    let core = core();
    assert_eq!(
        request(
            &core,
            1,
            "fs.mutate",
            json!({ "workspaceDir": fixture.path(), "operations": [{ "type": "writeFile", "path": "a.txt", "content": "x" }] })
        )["error"]["code"],
        "BUSY"
    );
}

#[test]
fn recover_reports_existing_phase_without_replaying_content() {
    let fixture = TempDir::new().unwrap();
    let tx_dir = fixture.path().join(".crewforge/desktop-transactions");
    fs::create_dir_all(&tx_dir).unwrap();
    fs::write(
        tx_dir.join("pending.json"),
        r#"{"schemaVersion":1,"transactionId":"pending","phase":"applying"}"#,
    )
    .unwrap();
    let core = core();
    let response = result(request(
        &core,
        1,
        "fs.transaction.recover",
        json!({ "workspaceDir": fixture.path(), "transactionId": "pending" }),
    ));
    assert_eq!(response["status"], "applying");
}

#[cfg(unix)]
#[test]
fn recovery_admission_rejects_symlinked_transaction_directory() {
    use std::os::unix::fs::symlink;
    let fixture = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(
        outside.path().join("transaction.json"),
        "private outside record",
    )
    .unwrap();
    let directory = fixture.path().join(".crewforge/desktop-transactions");
    fs::create_dir_all(&directory).unwrap();
    symlink(outside.path(), directory.join("foreign-transaction")).unwrap();
    let core = core();
    let admission = request(
        &core,
        1,
        "fs.writer.admit",
        json!({ "workspaceDir": fixture.path(), "owner": { "kind": "agent", "id": "test-owner" }, "intent": "agent-edit" }),
    );
    assert!(admission.get("error").is_none(), "{admission}");
    let acquire = request(
        &core,
        2,
        "fs.writer.acquire",
        json!({ "admissionToken": admission["result"]["admissionToken"] }),
    );
    assert_eq!(acquire["error"]["code"], "PATH_ESCAPE");
    assert_eq!(
        fs::read_to_string(outside.path().join("transaction.json")).unwrap(),
        "private outside record"
    );
}
