//! Trusted desktop service. The Agent command sandbox is deliberately a separate service.

mod change_version;
mod error;
mod file_identity;
mod git;
mod index;
mod mutation;
mod pty;
mod resource_id;
mod search;
mod watch;
mod workspace;

pub use error::{CoreError, Result};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub struct Task {
    request: Request,
    cancelled: Arc<AtomicBool>,
}

pub struct Core {
    emit: EventSink,
    change_versions: change_version::ChangeVersions,
    indexes: index::Indexes,
    mutations: mutation::Mutations,
    terminals: pty::Terminals,
    watches: watch::Watches,
    requests: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    closed: AtomicBool,
}

impl Core {
    pub fn new(emit: EventSink) -> Self {
        Self {
            change_versions: change_version::ChangeVersions::new(emit.clone()),
            indexes: Default::default(),
            mutations: Default::default(),
            emit,
            terminals: Default::default(),
            watches: Default::default(),
            requests: Default::default(),
            closed: AtomicBool::new(false),
        }
    }

    // Register before queueing so a later rpc.cancel also cancels a queued request.
    pub fn prepare(&self, request: Request) -> Result<Task> {
        let mut requests = self.requests.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return Err(CoreError::aborted());
        }
        if requests.contains_key(&request.id) {
            return Err(CoreError::invalid("Duplicate in-flight request id"));
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        requests.insert(request.id, cancelled.clone());
        Ok(Task { request, cancelled })
    }

    pub fn execute_task(&self, task: Task) -> Value {
        let id = task.request.id;
        let method = task.request.method;
        let cancelled = task.cancelled;
        let mut result = if cancelled.load(Ordering::Relaxed) {
            Err(CoreError::aborted())
        } else {
            self.dispatch(&method, task.request.params, cancelled.clone())
        };
        // Cancellation can arrive after spawn/start created a native resource but before its response.
        if cancelled.load(Ordering::Acquire)
            && !matches!(method.as_str(), "transaction.commit" | "fs.mutate")
        {
            if let Ok(resource) = &result {
                if method == "pty.spawn" {
                    if let Ok(params) = parse(resource.clone()) {
                        let _ = self.terminals.kill(params);
                    }
                } else if method == "watch.start" {
                    if let Ok(params) = parse(resource.clone()) {
                        let _ = self.watches.stop(params);
                    }
                } else if method == "index.scan" {
                    if let Some(session_id) = resource.get("sessionId").and_then(Value::as_str) {
                        self.indexes.discard(session_id);
                    }
                }
            }
            result = Err(CoreError::aborted());
        }
        self.requests.lock().unwrap().remove(&id);
        match result {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        }
    }

    pub fn execute(&self, request: Request) -> Value {
        let id = request.id;
        match self.prepare(request) {
            Ok(task) => self.execute_task(task),
            Err(error) => json!({ "id": id, "error": error }),
        }
    }

    fn dispatch(&self, method: &str, params: Value, cancelled: Arc<AtomicBool>) -> Result<Value> {
        match method {
            "ping" => Ok(
                json!({ "protocolVersion": 1, "capabilities": ["fs.entries", "fs.read", "fs.changeVersion", "fs.mutate", "fs.writer.admit", "fs.writer.acquire", "fs.writer.inspect", "fs.writer.release", "fs.transaction.begin", "fs.transaction.chunk", "fs.transaction.commit", "fs.transaction.abort", "fs.transaction.status", "fs.transaction.recover", "search", "index.scan", "index.page", "index.readBatch", "index.policy", "index.close", "git.exec", "watch.start", "watch.stop", "pty.spawn", "pty.write", "pty.resize", "pty.kill", "rpc.cancel"] }),
            ),
            "fs.entries" => serialize(workspace::entries(parse(params)?)?),
            "fs.read" => serialize(workspace::read(parse(params)?)?),
            "fs.changeVersion" => serialize(self.change_versions.query(parse(params)?)?),
            "fs.mutate" => serialize(self.mutations.mutate(parse(params)?)?),
            "fs.writer.admit" => serialize(self.mutations.writer_admit(parse(params)?)?),
            "fs.writer.acquire" => serialize(self.mutations.writer_acquire(parse(params)?)?),
            "fs.writer.inspect" => serialize(self.mutations.writer_inspect(parse(params)?)?),
            "fs.writer.release" => serialize(self.mutations.writer_release(parse(params)?)?),
            "fs.transaction.begin" => serialize(self.mutations.transaction_begin(parse(params)?)?),
            "fs.transaction.chunk" => serialize(self.mutations.transaction_chunk(parse(params)?)?),
            "fs.transaction.commit" => {
                serialize(self.mutations.transaction_commit(parse(params)?)?)
            }
            "fs.transaction.abort" => serialize(self.mutations.transaction_abort(parse(params)?)?),
            "fs.transaction.status" => serialize(self.mutations.status(parse(params)?)?),
            "fs.transaction.recover" => serialize(self.mutations.recover(parse(params)?)?),
            "search" => serialize(search::search(parse(params)?, cancelled)?),
            "index.scan" => serialize(self.indexes.scan(parse(params)?, cancelled)?),
            "index.page" => serialize(self.indexes.page(parse(params)?)?),
            "index.readBatch" => serialize(self.indexes.read_batch(parse(params)?)?),
            "index.policy" => serialize(self.indexes.policy(parse(params)?)?),
            "index.close" => {
                self.indexes.close(parse(params)?)?;
                Ok(Value::Null)
            }
            "git.exec" => serialize(git::execute(parse(params)?, cancelled)?),
            "watch.start" => self.watches.start(parse(params)?, self.emit.clone()),
            "watch.stop" => self.watches.stop(parse(params)?),
            "pty.spawn" => self.terminals.spawn(parse(params)?, self.emit.clone()),
            "pty.write" => self.terminals.write(parse(params)?),
            "pty.resize" => self.terminals.resize(parse(params)?),
            "pty.kill" => self.terminals.kill(parse(params)?),
            "rpc.cancel" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct CancelParams {
                    request_id: u64,
                }
                let params: CancelParams = parse(params)?;
                self.cancel(params.request_id);
                Ok(Value::Null)
            }
            _ => Err(CoreError::invalid(format!("Unknown method: {method}"))),
        }
    }

    pub fn cancel(&self, request_id: u64) {
        if let Some(cancelled) = self.requests.lock().unwrap().get(&request_id) {
            cancelled.store(true, Ordering::Release);
        }
    }

    pub fn shutdown(&self) {
        {
            let requests = self.requests.lock().unwrap();
            self.closed.store(true, Ordering::Release);
            for cancelled in requests.values() {
                cancelled.store(true, Ordering::Release);
            }
        }
        self.watches.shutdown();
        self.change_versions.shutdown();
        self.indexes.shutdown();
        self.terminals.shutdown();
    }
}

impl Drop for Core {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn parse<T: DeserializeOwned>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|error| CoreError::invalid(error.to_string()))
}

fn serialize<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| CoreError::failed(error.to_string()))
}
