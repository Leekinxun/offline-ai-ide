use crate::{
    error::{CoreError, Result},
    workspace::Workspace,
    EventSink,
};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Cursor {
    pub epoch: String,
    pub revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub workspace_dir: String,
    #[serde(default)]
    pub after: Option<Cursor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeVersion {
    pub cursor: Cursor,
    pub changed: bool,
    pub rescan_required: bool,
}

#[derive(PartialEq, Eq)]
struct RootIdentity {
    volume: u64,
    file: u64,
}

impl RootIdentity {
    fn read(path: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::symlink_metadata(path)?;
            if !metadata.is_dir() || metadata.is_symlink() {
                return Err(CoreError::new("PATH_ESCAPE", "Workspace root was replaced"));
            }
            Ok(Self {
                volume: metadata.dev(),
                file: metadata.ino(),
            })
        }
        #[cfg(windows)]
        {
            use std::{
                ffi::c_void,
                os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
            };
            #[repr(C)]
            #[derive(Default)]
            struct FileInformation {
                attributes: u32,
                creation_time: [u32; 2],
                access_time: [u32; 2],
                write_time: [u32; 2],
                volume_serial: u32,
                size_high: u32,
                size_low: u32,
                links: u32,
                index_high: u32,
                index_low: u32,
            }
            #[link(name = "kernel32")]
            extern "system" {
                fn GetFileInformationByHandle(
                    handle: *mut c_void,
                    information: *mut FileInformation,
                ) -> i32;
            }
            // FILE_FLAG_BACKUP_SEMANTICS permits opening a directory for identity inspection.
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(0x0200_0000)
                .open(path)?;
            if !file.metadata()?.is_dir() {
                return Err(CoreError::invalid("Workspace root must remain a directory"));
            }
            let mut information = FileInformation::default();
            // SAFETY: File owns the valid handle and information uses the documented C layout.
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            Ok(Self {
                volume: u64::from(information.volume_serial),
                file: u64::from(information.index_high) << 32 | u64::from(information.index_low),
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = path;
            Err(CoreError::failed(
                "Workspace identity inspection is unsupported on this platform",
            ))
        }
    }
}

struct State {
    epoch_seed: String,
    epoch_generation: u64,
    cursor: Cursor,
    last_rescan_revision: u64,
    last_notified_revision: u64,
    last_used: Instant,
    active: bool,
    error: Option<CoreError>,
}

impl State {
    fn advance(&mut self, rescan: bool) {
        if self.cursor.revision == MAX_SAFE_REVISION {
            self.epoch_generation += 1;
            self.cursor.epoch = format!("{}-{}", self.epoch_seed, self.epoch_generation);
            self.cursor.revision = 1;
            self.last_rescan_revision = 1;
            self.last_notified_revision = 0;
        } else {
            self.cursor.revision += 1;
            if rescan {
                self.last_rescan_revision = self.cursor.revision;
            }
        }
    }

    fn result(&self, after: Option<&Cursor>) -> Result<ChangeVersion> {
        if let Some(error) = &self.error {
            return Err(error.clone());
        }
        let same_epoch = after
            .map(|after| after.epoch == self.cursor.epoch)
            .unwrap_or(false);
        let covered = same_epoch
            && after
                .map(|after| after.revision <= self.cursor.revision)
                .unwrap_or(false);
        Ok(ChangeVersion {
            cursor: self.cursor.clone(),
            changed: after != Some(&self.cursor),
            rescan_required: !covered
                || after
                    .map(|after| after.revision < self.last_rescan_revision)
                    .unwrap_or(true),
        })
    }
}

struct Cache {
    state: Arc<Mutex<State>>,
    identity: RootIdentity,
    _watcher: RecommendedWatcher,
    _updates: SyncSender<()>,
}
impl Drop for Cache {
    fn drop(&mut self) {
        self.state.lock().unwrap().active = false;
    }
}

#[derive(Default)]
struct Registry {
    caches: HashMap<PathBuf, Cache>,
    next_cache: u64,
    closed: bool,
}

pub struct ChangeVersions {
    registry: Arc<Mutex<Registry>>,
    instance: String,
    emit: EventSink,
    max_caches: usize,
    idle_ttl: Duration,
    stop_reaper: Mutex<Option<mpsc::Sender<()>>>,
}

impl ChangeVersions {
    pub fn new(emit: EventSink) -> Self {
        Self::with_limits(emit, 32, Duration::from_secs(5 * 60))
    }

    fn with_limits(emit: EventSink, max_caches: usize, idle_ttl: Duration) -> Self {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let weak_registry = Arc::downgrade(&registry);
        let (stop_sender, stop_receiver) = mpsc::channel();
        let interval = (idle_ttl / 2).clamp(Duration::from_millis(10), Duration::from_secs(30));
        thread::spawn(move || loop {
            match stop_receiver.recv_timeout(interval) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {
                    let Some(registry) = weak_registry.upgrade() else {
                        break;
                    };
                    prune_idle(&mut registry.lock().unwrap(), idle_ttl);
                }
            }
        });
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let instance = format!(
            "{:x}-{:x}-{:x}",
            std::process::id(),
            now,
            NEXT_INSTANCE.fetch_add(1, Ordering::Relaxed)
        );
        Self {
            registry,
            instance,
            emit,
            max_caches,
            idle_ttl,
            stop_reaper: Mutex::new(Some(stop_sender)),
        }
    }

    pub fn query(&self, params: Params) -> Result<ChangeVersion> {
        if let Some(after) = &params.after {
            if after.epoch.is_empty()
                || after.epoch.len() > 128
                || after.revision > MAX_SAFE_REVISION
            {
                return Err(CoreError::invalid("Invalid workspace change cursor"));
            }
        }
        let workspace = Workspace::open(&params.workspace_dir)?;
        let root = workspace.root().to_owned();
        let identity = RootIdentity::read(&root)?;
        let mut registry = self.registry.lock().unwrap();
        if registry.closed {
            return Err(CoreError::aborted());
        }
        prune_idle(&mut registry, self.idle_ttl);
        if registry
            .caches
            .get(&root)
            .map(|cache| cache.identity != identity)
            .unwrap_or(false)
        {
            registry.caches.remove(&root);
        }
        if !registry.caches.contains_key(&root) {
            if registry.caches.len() >= self.max_caches {
                return Err(CoreError::new(
                    "BUSY",
                    "Workspace change watcher limit reached",
                ));
            }
            registry.next_cache += 1;
            let epoch = format!("{}-{:x}", self.instance, registry.next_cache);
            registry.caches.insert(
                root.clone(),
                self.create_cache(root.clone(), identity, epoch)?,
            );
        }
        let result = {
            let cache = registry.caches.get(&root).unwrap();
            let mut state = cache.state.lock().unwrap();
            let result = state.result(params.after.as_ref());
            if result.is_ok() {
                state.last_used = Instant::now();
            }
            result
        };
        if result.is_err() {
            // Drop the state guard before dropping the watcher: its callbacks also lock state.
            // Report this failure; a later query can recreate the cache with a fresh epoch.
            registry.caches.remove(&root);
        }
        result
    }

    fn create_cache(&self, root: PathBuf, identity: RootIdentity, epoch: String) -> Result<Cache> {
        let state = Arc::new(Mutex::new(State {
            epoch_seed: epoch.clone(),
            epoch_generation: 0,
            cursor: Cursor { epoch, revision: 1 },
            last_rescan_revision: 1,
            last_notified_revision: 0,
            last_used: Instant::now(),
            active: true,
            error: None,
        }));
        let (sender, receiver) = mpsc::sync_channel(1);
        let callback_state = state.clone();
        let callback_sender = sender.clone();
        let callback_root = root.clone();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                apply_event(&callback_root, &callback_state, &callback_sender, event);
            },
            Config::default().with_follow_symlinks(false),
        )
        .map_err(watch_error)?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(watch_error)?;
        if RootIdentity::read(&root)? != identity {
            return Err(CoreError::new(
                "PATH_ESCAPE",
                "Workspace root changed while starting watcher",
            ));
        }
        let worker_state = state.clone();
        let emit = self.emit.clone();
        thread::spawn(move || {
            while receiver.recv().is_ok() {
                let deadline = Instant::now() + Duration::from_millis(75);
                while Instant::now() < deadline {
                    match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    {
                        Ok(()) => {}
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                let event = {
                    let mut state = worker_state.lock().unwrap();
                    if !state.active {
                        break;
                    }
                    let event = json!({ "event": "fs.changeVersion", "params": { "workspaceDir": root, "cursor": state.cursor,
                        "rescanRequired": state.last_rescan_revision > state.last_notified_revision, "error": state.error } });
                    state.last_notified_revision = state.cursor.revision;
                    event
                };
                emit(event);
            }
        });
        Ok(Cache {
            state,
            identity,
            _watcher: watcher,
            _updates: sender,
        })
    }

    pub fn shutdown(&self) {
        if let Some(sender) = self.stop_reaper.lock().unwrap().take() {
            let _ = sender.send(());
        }
        let mut registry = self.registry.lock().unwrap();
        registry.closed = true;
        registry.caches.clear();
    }
}

impl Drop for ChangeVersions {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn prune_idle(registry: &mut Registry, idle_ttl: Duration) {
    registry
        .caches
        .retain(|_, cache| cache.state.lock().unwrap().last_used.elapsed() < idle_ttl);
}

fn watch_error(error: notify::Error) -> CoreError {
    CoreError::new(
        "WATCH_UNAVAILABLE",
        format!("Native workspace change watcher failed: {error}"),
    )
}

fn apply_event(
    root: &Path,
    state: &Mutex<State>,
    updates: &SyncSender<()>,
    event: notify::Result<Event>,
) {
    // Path inspection can touch the filesystem; keep it outside the version state lock.
    let (rescan, error) = match event {
        Ok(event) => {
            if event.kind.is_access() {
                return;
            }
            let rescan = event.need_rescan() || event.paths.is_empty();
            if !rescan && !event.paths.iter().any(|path| visible_path(root, path)) {
                return;
            }
            (rescan, None)
        }
        Err(error) => (true, Some(watch_error(error))),
    };
    let mut state = state.lock().unwrap();
    if !state.active {
        return;
    }
    if let Some(error) = error {
        state.error = Some(error);
    }
    state.advance(rescan);
    // Coalescing a full notification queue cannot lose the latest state or overflow revision.
    let _ = updates.try_send(());
}

fn visible_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut cursor = root.to_owned();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return false;
        };
        if name.to_string_lossy().starts_with('.') {
            return false;
        }
        cursor.push(name);
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) if metadata.is_symlink() => return false,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return true,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{
        event::{Flag, ModifyKind},
        EventKind,
    };
    use tempfile::TempDir;

    #[test]
    fn overflow_is_required_for_every_cursor_before_its_revision() {
        let fixture = TempDir::new().unwrap();
        let versions = ChangeVersions::new(Arc::new(|_| {}));
        let initial = versions
            .query(Params {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                after: None,
            })
            .unwrap();
        let registry = versions.registry.lock().unwrap();
        let cache = registry.caches.values().next().unwrap();
        let mut event = Event::new(EventKind::Other);
        event.attrs.set_flag(Flag::Rescan);
        apply_event(fixture.path(), &cache.state, &cache._updates, Ok(event));
        let forced = cache
            .state
            .lock()
            .unwrap()
            .result(Some(&initial.cursor))
            .unwrap();
        assert!(forced.changed && forced.rescan_required);
        let acknowledged = cache
            .state
            .lock()
            .unwrap()
            .result(Some(&forced.cursor))
            .unwrap();
        assert!(!acknowledged.changed && !acknowledged.rescan_required);
    }

    #[test]
    fn watcher_errors_fail_queries_and_shutdown_stops_cached_queries() {
        let fixture = TempDir::new().unwrap();
        let versions = ChangeVersions::new(Arc::new(|_| {}));
        let params = || Params {
            workspace_dir: fixture.path().to_string_lossy().into_owned(),
            after: None,
        };
        versions.query(params()).unwrap();
        {
            let registry = versions.registry.lock().unwrap();
            let cache = registry.caches.values().next().unwrap();
            apply_event(
                fixture.path(),
                &cache.state,
                &cache._updates,
                Err(notify::Error::generic("watcher disconnected")),
            );
        }
        assert_eq!(
            versions.query(params()).unwrap_err().code,
            "WATCH_UNAVAILABLE"
        );
        versions.shutdown();
        assert_eq!(versions.query(params()).unwrap_err().code, "ABORTED");
    }

    #[test]
    fn watcher_error_is_reported_before_retry_creates_a_fresh_epoch() {
        let fixture = TempDir::new().unwrap();
        let versions = ChangeVersions::new(Arc::new(|_| {}));
        let params = |after| Params {
            workspace_dir: fixture.path().to_string_lossy().into_owned(),
            after,
        };
        let initial = versions.query(params(None)).unwrap();
        {
            let registry = versions.registry.lock().unwrap();
            let cache = registry.caches.values().next().unwrap();
            apply_event(
                fixture.path(),
                &cache.state,
                &cache._updates,
                Err(notify::Error::generic("watcher disconnected")),
            );
        }
        assert_eq!(
            versions
                .query(params(Some(initial.cursor.clone())))
                .unwrap_err()
                .code,
            "WATCH_UNAVAILABLE"
        );
        assert!(versions.registry.lock().unwrap().caches.is_empty());
        let retry = versions
            .query(params(Some(initial.cursor.clone())))
            .unwrap();
        assert!(retry.changed && retry.rescan_required);
        assert_ne!(retry.cursor.epoch, initial.cursor.epoch);
        let acknowledged = versions.query(params(Some(retry.cursor))).unwrap();
        assert!(!acknowledged.changed && !acknowledged.rescan_required);
    }

    #[test]
    fn watcher_limit_and_idle_expiration_create_a_new_epoch() {
        let first = TempDir::new().unwrap();
        let second = TempDir::new().unwrap();
        let versions = ChangeVersions::with_limits(Arc::new(|_| {}), 1, Duration::from_millis(80));
        let params = |root: &Path| Params {
            workspace_dir: root.to_string_lossy().into_owned(),
            after: None,
        };
        let old = versions.query(params(first.path())).unwrap();
        assert_eq!(
            versions.query(params(second.path())).unwrap_err().code,
            "BUSY"
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while !versions.registry.lock().unwrap().caches.is_empty() {
            assert!(Instant::now() < deadline, "Idle watcher was not reclaimed");
            thread::sleep(Duration::from_millis(10));
        }
        let fresh = versions.query(params(first.path())).unwrap();
        assert_ne!(fresh.cursor.epoch, old.cursor.epoch);
    }

    #[test]
    fn coalesced_notification_preserves_overflow_after_a_later_regular_event() {
        let fixture = TempDir::new().unwrap();
        let (sender, receiver) = mpsc::channel();
        let versions = ChangeVersions::new(Arc::new(move |event| {
            let _ = sender.send(event);
        }));
        versions
            .query(Params {
                workspace_dir: fixture.path().to_string_lossy().into_owned(),
                after: None,
            })
            .unwrap();
        {
            let registry = versions.registry.lock().unwrap();
            let (root, cache) = registry.caches.iter().next().unwrap();
            let mut overflow = Event::new(EventKind::Other);
            overflow.attrs.set_flag(Flag::Rescan);
            apply_event(root, &cache.state, &cache._updates, Ok(overflow));
            let regular =
                Event::new(EventKind::Modify(ModifyKind::Any)).add_path(root.join("visible.txt"));
            apply_event(root, &cache.state, &cache._updates, Ok(regular));
        }
        let notification = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(notification["event"], "fs.changeVersion");
        assert_eq!(notification["params"]["rescanRequired"], true);
    }

    #[test]
    fn a_blocked_event_sink_does_not_hold_the_version_state_lock() {
        let fixture = TempDir::new().unwrap();
        let (entered_sender, entered_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let release_receiver = Mutex::new(release_receiver);
        let versions = Arc::new(ChangeVersions::new(Arc::new(move |_| {
            let _ = entered_sender.send(());
            let _ = release_receiver
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3));
        })));
        let root = fixture.path().to_string_lossy().into_owned();
        let initial = versions
            .query(Params {
                workspace_dir: root.clone(),
                after: None,
            })
            .unwrap();
        {
            let registry = versions.registry.lock().unwrap();
            let (path, cache) = registry.caches.iter().next().unwrap();
            let event =
                Event::new(EventKind::Modify(ModifyKind::Any)).add_path(path.join("visible.txt"));
            apply_event(path, &cache.state, &cache._updates, Ok(event));
        }
        entered_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        let (query_sender, query_receiver) = mpsc::channel();
        let query_versions = versions.clone();
        let query_thread = thread::spawn(move || {
            let _ = query_sender.send(query_versions.query(Params {
                workspace_dir: root,
                after: Some(initial.cursor),
            }));
        });
        let query = query_receiver.recv_timeout(Duration::from_millis(500));
        let _ = release_sender.send(());
        query_thread.join().unwrap();
        assert!(query.unwrap().unwrap().changed);
    }

    #[test]
    fn revision_rollover_and_future_cursors_force_full_refresh() {
        let mut state = State {
            epoch_seed: "test".to_owned(),
            epoch_generation: 0,
            cursor: Cursor {
                epoch: "test".to_owned(),
                revision: MAX_SAFE_REVISION,
            },
            last_rescan_revision: 1,
            last_notified_revision: 0,
            last_used: Instant::now(),
            active: true,
            error: None,
        };
        let old = state.cursor.clone();
        state.advance(false);
        assert_eq!(state.cursor.revision, 1);
        assert!(state.result(Some(&old)).unwrap().rescan_required);
        let future = Cursor {
            epoch: state.cursor.epoch.clone(),
            revision: 100,
        };
        assert!(state.result(Some(&future)).unwrap().rescan_required);
        let event = Event::new(EventKind::Modify(ModifyKind::Any))
            .add_path(PathBuf::from("/not/workspace"));
        let (updates, _) = mpsc::sync_channel(1);
        let state = Mutex::new(state);
        apply_event(Path::new("/workspace"), &state, &updates, Ok(event));
        assert_eq!(state.lock().unwrap().cursor.revision, 1);
    }
}
