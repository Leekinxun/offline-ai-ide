use crate::error::{CoreError, Result};
use std::sync::atomic::{AtomicU64, Ordering};

pub fn allocate(provided: Option<String>, counter: &AtomicU64, kind: &str) -> Result<String> {
    if let Some(id) = provided {
        if id.len() != 36
            || !id.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
        {
            return Err(CoreError::invalid(format!("{kind}Id must be a UUID")));
        }
        return Ok(id);
    }
    Ok(format!(
        "{kind}-{}",
        counter.fetch_add(1, Ordering::Relaxed) + 1
    ))
}
