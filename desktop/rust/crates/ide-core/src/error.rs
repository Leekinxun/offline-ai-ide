use serde::Serialize;
use std::{fmt, io};

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Clone, Serialize)]
pub struct CoreError {
    pub code: &'static str,
    pub message: String,
}

impl CoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_REQUEST", message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new("FAILED", message)
    }

    pub fn aborted() -> Self {
        Self::new("ABORTED", "Request cancelled")
    }
}

impl From<io::Error> for CoreError {
    fn from(error: io::Error) -> Self {
        let code = if error.kind() == io::ErrorKind::NotFound {
            "NOT_FOUND"
        } else {
            "FAILED"
        };
        Self::new(code, error.to_string())
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CoreError {}
