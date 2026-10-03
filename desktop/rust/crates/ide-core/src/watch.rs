use crate::{
    error::{CoreError, Result},
    resource_id,
    workspace::Workspace,
    EventSink,
};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub workspace_dir: String,
    #[serde(default)]
    pub watch_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopParams {
    pub watch_id: String,
}

struct ActiveWatch {
    _watcher: RecommendedWatcher,
    stopped: Arc<AtomicBool>,
}

impl Drop for ActiveWatch {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

#[derive(Default)]
pub struct Watches {
    watches: Mutex<HashMap<String, ActiveWatch>>,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl Watches {
    pub fn start(&self, params: StartParams, emit: EventSink) -> Result<Value> {
        let workspace = Workspace::open(params.workspace_dir)?;
        let watch_id = resource_id::allocate(params.watch_id, &self.next_id, "watch")?;
        let stopped = Arc::new(AtomicBool::new(false));
        let overflow = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel::<notify::Result<Event>>(1024);
        let callback_overflow = overflow.clone();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                if sender.try_send(event).is_err() {
                    callback_overflow.store(true, Ordering::Release);
                }
            },
            Config::default().with_follow_symlinks(false),
        )
        .map_err(|error| CoreError::failed(error.to_string()))?;
        watcher
            .watch(workspace.root(), RecursiveMode::Recursive)
            .map_err(|error| CoreError::failed(error.to_string()))?;
        let mut watches = self.watches.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return Err(CoreError::aborted());
        }
        if watches.contains_key(&watch_id) {
            return Err(CoreError::invalid("watchId is already active"));
        }
        watches.insert(
            watch_id.clone(),
            ActiveWatch {
                _watcher: watcher,
                stopped: stopped.clone(),
            },
        );
        drop(watches);
        let event_watch_id = watch_id.clone();
        thread::spawn(move || {
            let mut paths = BTreeSet::new();
            let mut rescan = false;
            let mut pending_since = None;
            while !stopped.load(Ordering::Acquire) {
                match receiver.recv_timeout(Duration::from_millis(40)) {
                    Ok(Ok(event)) => {
                        // Read-only activity is irrelevant and would cause diagnostic feedback loops.
                        if event.kind.is_access() {
                            continue;
                        }
                        rescan |= event.need_rescan();
                        for path in event.paths {
                            if let Some(path) = workspace.relative(&path) {
                                if !path.is_empty() {
                                    paths.insert(path);
                                }
                            }
                        }
                        pending_since.get_or_insert_with(Instant::now);
                    }
                    Ok(Err(_)) => {
                        rescan = true;
                        pending_since.get_or_insert_with(Instant::now);
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                }
                if overflow.swap(false, Ordering::AcqRel) {
                    rescan = true;
                    pending_since.get_or_insert_with(Instant::now);
                }
                if pending_since
                    .map(|started| started.elapsed() >= Duration::from_millis(75))
                    .unwrap_or(false)
                {
                    if !stopped.load(Ordering::Acquire) {
                        emit(
                            json!({ "event": "fs.changed", "params": { "watchId": event_watch_id, "paths": paths, "overflow": rescan } }),
                        );
                    }
                    paths.clear();
                    rescan = false;
                    pending_since = None;
                }
            }
        });
        Ok(json!({ "watchId": watch_id }))
    }

    pub fn stop(&self, params: StopParams) -> Result<Value> {
        self.watches.lock().unwrap().remove(&params.watch_id);
        Ok(Value::Null)
    }

    pub fn shutdown(&self) {
        let mut watches = self.watches.lock().unwrap();
        self.closed.store(true, Ordering::Release);
        watches.clear();
    }
}
