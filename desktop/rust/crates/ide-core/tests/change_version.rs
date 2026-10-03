use crownforge_ide_core::{Core, Request};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn service() -> (Core, mpsc::Receiver<Value>) {
    let (sender, receiver) = mpsc::channel();
    (
        Core::new(Arc::new(move |event| {
            let _ = sender.send(event);
        })),
        receiver,
    )
}

fn response(core: &Core, root: &Path, after: Option<&Value>) -> Value {
    core.execute(Request {
        id: 1,
        method: "fs.changeVersion".to_owned(),
        params: json!({ "workspaceDir": root, "after": after }),
    })
}

fn query(core: &Core, root: &Path, after: Option<&Value>) -> Value {
    let response = response(core, root, after);
    assert!(response.get("error").is_none(), "{response}");
    response["result"].clone()
}

fn changed_after(core: &Core, root: &Path, after: &Value) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let value = query(core, root, Some(after));
        if value["changed"] == true {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "Native watcher did not advance its cursor"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn settled(core: &Core, root: &Path) -> Value {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut current = query(core, root, None);
    loop {
        thread::sleep(Duration::from_millis(180));
        let next = query(core, root, Some(&current["cursor"]));
        if next["changed"] == false {
            return next;
        }
        assert!(Instant::now() < deadline, "Native events did not settle");
        current = next;
    }
}

#[test]
fn real_versions_detect_create_modify_delete_rename_atomic_save_and_same_mtime() {
    let fixture = TempDir::new().unwrap();
    let (core, events) = service();
    let first = query(&core, fixture.path(), None);
    assert_eq!(first["changed"], true);
    assert_eq!(first["rescanRequired"], true);
    assert_eq!(
        query(&core, fixture.path(), Some(&first["cursor"]))["changed"],
        false
    );

    let file = fixture.path().join("中文.txt");
    fs::write(&file, "before\n").unwrap();
    changed_after(&core, fixture.path(), &first["cursor"]);
    let cursor = settled(&core, fixture.path())["cursor"].clone();
    let old_mtime = fs::metadata(&file).unwrap().modified().unwrap();
    fs::write(&file, "after!\n").unwrap();
    fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old_mtime))
        .unwrap();
    assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), old_mtime);
    changed_after(&core, fixture.path(), &cursor);
    let cursor = settled(&core, fixture.path())["cursor"].clone();

    let renamed = fixture.path().join("renamed.txt");
    fs::rename(&file, &renamed).unwrap();
    changed_after(&core, fixture.path(), &cursor);
    let cursor = settled(&core, fixture.path())["cursor"].clone();
    let temporary = fixture.path().join(".atomic-save.tmp");
    fs::write(&temporary, "atomic replacement\n").unwrap();
    fs::rename(&temporary, &renamed).unwrap();
    changed_after(&core, fixture.path(), &cursor);
    let cursor = settled(&core, fixture.path())["cursor"].clone();
    fs::remove_file(&renamed).unwrap();
    changed_after(&core, fixture.path(), &cursor);
    assert!(
        events.recv_timeout(Duration::from_secs(2)).is_ok(),
        "Version changes should also emit a coalesced notification"
    );
}

#[test]
fn hidden_changes_are_ignored_but_generated_visible_directories_are_observed() {
    let fixture = TempDir::new().unwrap();
    fs::create_dir(fixture.path().join(".hidden")).unwrap();
    fs::create_dir(fixture.path().join("node_modules")).unwrap();
    fs::write(fixture.path().join(".hidden/file.txt"), "before").unwrap();
    let (core, _) = service();
    let cursor = settled(&core, fixture.path())["cursor"].clone();
    fs::write(fixture.path().join(".hidden/file.txt"), "after").unwrap();
    thread::sleep(Duration::from_millis(350));
    assert_eq!(
        query(&core, fixture.path(), Some(&cursor))["changed"],
        false
    );
    fs::write(fixture.path().join("node_modules/visible.txt"), "visible").unwrap();
    assert_eq!(
        changed_after(&core, fixture.path(), &cursor)["changed"],
        true
    );
}

#[cfg(unix)]
#[test]
fn outside_symlink_changes_do_not_advance_workspace_version() {
    let fixture = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("outside.txt"), "before").unwrap();
    std::os::unix::fs::symlink(outside.path(), fixture.path().join("link")).unwrap();
    let (core, _) = service();
    let cursor = settled(&core, fixture.path())["cursor"].clone();
    fs::write(outside.path().join("outside.txt"), "after").unwrap();
    thread::sleep(Duration::from_millis(350));
    assert_eq!(
        query(&core, fixture.path(), Some(&cursor))["changed"],
        false
    );
}

#[test]
fn new_service_and_replaced_root_invalidate_old_cursor_and_missing_roots_fail() {
    let fixture = TempDir::new().unwrap();
    let root = fixture.path().join("workspace");
    fs::create_dir(&root).unwrap();
    let (core, _) = service();
    let old = query(&core, &root, None)["cursor"].clone();
    let (new_core, _) = service();
    let new = query(&new_core, &root, Some(&old));
    assert_eq!(new["changed"], true);
    assert_ne!(new["cursor"]["epoch"], old["epoch"]);

    fs::rename(&root, fixture.path().join("old-workspace")).unwrap();
    fs::create_dir(&root).unwrap();
    let replaced = query(&core, &root, Some(&old));
    assert_eq!(replaced["changed"], true);
    assert_ne!(replaced["cursor"]["epoch"], old["epoch"]);
    fs::remove_dir(&root).unwrap();
    assert_eq!(response(&core, &root, None)["error"]["code"], "NOT_FOUND");
}

#[test]
fn invalid_cursors_are_rejected_without_starting_a_watcher() {
    let fixture = TempDir::new().unwrap();
    let (core, _) = service();
    for cursor in [
        json!({ "epoch": "", "revision": 1 }),
        json!({ "epoch": "valid", "revision": 9_007_199_254_740_992_u64 }),
    ] {
        assert_eq!(
            response(&core, fixture.path(), Some(&cursor))["error"]["code"],
            "INVALID_REQUEST"
        );
    }
}
