use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("keychain: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("state lock poisoned")]
    Poisoned,

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid state: {0}")]
    InvalidState(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
