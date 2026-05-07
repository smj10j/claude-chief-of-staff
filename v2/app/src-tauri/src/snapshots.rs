use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::AppResult;

/// Content-addressed blob store for the per-change snapshot layer
/// (PRD-102 §13a). Writes are idempotent: repeating the same content
/// produces the same filename and no-ops on collision.
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn open(root: &Path) -> AppResult<Self> {
        fs::create_dir_all(root)?;
        Ok(Self { root: root.to_path_buf() })
    }

    pub fn hash(content: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(content);
        hex::encode(h.finalize())
    }

    /// Store `content`. Returns the hex-encoded SHA256 digest.
    /// Safe to call repeatedly with the same content.
    pub fn put(&self, content: &[u8]) -> AppResult<String> {
        let digest = Self::hash(content);
        let target = self.path_for(&digest);
        if target.exists() {
            return Ok(digest);
        }
        fs::create_dir_all(target.parent().unwrap())?;
        // Write to a temp file first so partial writes never become visible
        // under the final hash name.
        let tmp = target.with_extension("tmp");
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(content)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &target)?;
        Ok(digest)
    }

    /// Read a blob by digest. Returns None when the blob isn't on
    /// disk — restore-from-audit treats that as "no recoverable
    /// snapshot" (e.g., the file was tracked by git when written, so
    /// we never captured a blob).
    pub fn get(&self, digest: &str) -> AppResult<Option<Vec<u8>>> {
        let path = self.path_for(digest);
        if !path.is_file() {
            return Ok(None);
        }
        let bytes = fs::read(&path)?;
        // Defensive integrity check — the path's name IS the hash,
        // but a corrupted file should fail loudly rather than silently
        // restoring junk.
        let actual = Self::hash(&bytes);
        if actual != digest {
            return Err(crate::error::AppError::InvalidState(format!(
                "blob {} hash mismatch (got {})",
                digest, actual,
            )));
        }
        Ok(Some(bytes))
    }

    fn path_for(&self, digest: &str) -> PathBuf {
        // Fan out 2 chars to avoid a single huge directory.
        let (prefix, rest) = digest.split_at(2);
        self.root.join(prefix).join(rest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn put_then_get_round_trips() {
        let tmp = TempDir::new().unwrap();
        let store = BlobStore::open(tmp.path()).unwrap();
        let digest = store.put(b"hello world").unwrap();
        let got = store.get(&digest).unwrap().unwrap();
        assert_eq!(got, b"hello world");
    }

    #[test]
    fn get_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        let store = BlobStore::open(tmp.path()).unwrap();
        // Made-up digest
        let digest = "0".repeat(64);
        assert!(store.get(&digest).unwrap().is_none());
    }

    #[test]
    fn get_corrupted_blob_returns_error() {
        let tmp = TempDir::new().unwrap();
        let store = BlobStore::open(tmp.path()).unwrap();
        let digest = store.put(b"original").unwrap();
        // Corrupt the on-disk blob.
        let path = store.path_for(&digest);
        fs::write(&path, b"tampered").unwrap();
        let err = store.get(&digest).unwrap_err();
        assert!(format!("{err}").contains("hash mismatch"));
    }
}
