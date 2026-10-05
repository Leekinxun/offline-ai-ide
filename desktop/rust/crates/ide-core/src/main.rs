use crownforge_ide_core::{Core, Request};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    sync::{mpsc, Arc, Mutex},
    thread,
};

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 32 * 1024 * 1024;

struct BoundedBuffer {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for BoundedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other(
                "Encoded RPC response exceeds record limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn encode_record(value: &Value, limit: usize) -> Vec<u8> {
    let mut buffer = BoundedBuffer {
        bytes: Vec::with_capacity(limit.min(4096)),
        limit,
        exceeded: false,
    };
    match serde_json::to_writer(&mut buffer, value) {
        Ok(()) => buffer.bytes,
        Err(error) => {
            // Never send the partial buffer. Preserve the request ID so only this call fails.
            let id = value.get("id").cloned().unwrap_or(Value::Null);
            let failure = if buffer.exceeded {
                json!({ "id": id, "error": { "code": "LIMIT_EXCEEDED", "message": "Encoded RPC response exceeds 32 MiB record limit" } })
            } else {
                json!({ "id": id, "error": { "code": "FAILED", "message": error.to_string() } })
            };
            serde_json::to_vec(&failure).expect("Protocol error response is serializable")
        }
    }
}

fn write_record(output: &Arc<Mutex<io::Stdout>>, value: Value) {
    // Reserve one byte for NDJSON's delimiter before touching stdout.
    let record = encode_record(&value, MAX_RECORD_BYTES - 1);
    let mut output = output.lock().unwrap();
    if let Err(error) = output
        .write_all(&record)
        .and_then(|_| output.write_all(b"\n"))
        .and_then(|_| output.flush())
    {
        eprintln!("Desktop core output failed: {error}");
    }
}

fn main() {
    let output = Arc::new(Mutex::new(io::stdout()));
    let event_output = output.clone();
    let core = Arc::new(Core::new(Arc::new(move |event| {
        write_record(&event_output, event)
    })));
    let (sender, receiver) = mpsc::channel();
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = Vec::new();
    for _ in 0..4 {
        let core = core.clone();
        let receiver = receiver.clone();
        let output = output.clone();
        workers.push(thread::spawn(move || loop {
            let task = match receiver.lock().unwrap().recv() {
                Ok(task) => task,
                Err(_) => break,
            };
            write_record(&output, core.execute_task(task));
        }));
    }
    let input = io::stdin();
    let mut input = input.lock();
    loop {
        let record = match read_record(&mut input) {
            Ok(Some(record)) => record,
            Ok(None) => break,
            Err(error) => {
                eprintln!("Desktop core input failed: {error}");
                break;
            }
        };
        if record.len() > MAX_REQUEST_BYTES {
            write_record(
                &output,
                json!({ "id": null, "error": { "code": "INVALID_REQUEST", "message": "RPC request exceeds 2 MiB" } }),
            );
            continue;
        }
        if record.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let request: Request = match serde_json::from_slice(&record) {
            Ok(request) => request,
            Err(error) => {
                let id = serde_json::from_slice::<Value>(&record)
                    .ok()
                    .and_then(|value| value.get("id").cloned())
                    .unwrap_or(Value::Null);
                write_record(
                    &output,
                    json!({ "id": id, "error": { "code": "INVALID_REQUEST", "message": error.to_string() } }),
                );
                continue;
            }
        };
        // Cancellation bypasses the worker queue, including all-busy scans or Git commands.
        if request.method == "rpc.cancel" {
            write_record(&output, core.execute(request));
            continue;
        }
        let id = request.id;
        match core.prepare(request) {
            Ok(task) => {
                if sender.send(task).is_err() {
                    break;
                }
            }
            Err(error) => write_record(&output, json!({ "id": id, "error": error })),
        }
    }
    // EOF means the trusted desktop parent has gone away. Cancel work and terminate children first.
    core.shutdown();
    drop(sender);
    for worker in workers {
        if worker.join().is_err() {
            eprintln!("Desktop core request worker failed");
        }
    }
    core.finish_shutdown();
}

// Drain overlong records without allocating their full length. A sentinel marks rejection.
fn read_record(input: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut record = Vec::new();
    loop {
        let buffer = input.fill_buf()?;
        if buffer.is_empty() {
            return Ok((!record.is_empty()).then_some(record));
        }
        let count = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(buffer.len());
        let finished = buffer[count - 1] == b'\n';
        let available = (MAX_REQUEST_BYTES + 1).saturating_sub(record.len());
        record.extend_from_slice(&buffer[..count.min(available)]);
        input.consume(count);
        if finished {
            return Ok(Some(record));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_size_limit_replaces_partial_record_with_original_id_error() {
        let value = json!({ "id": 42, "result": { "content": "\u{0001}".repeat(100) } });
        let record = encode_record(&value, 256);
        assert!(record.len() <= 256);
        let response: Value = serde_json::from_slice(&record).unwrap();
        assert_eq!(response["id"], 42);
        assert_eq!(response["error"]["code"], "LIMIT_EXCEEDED");
        assert!(response.get("result").is_none());
    }
}
