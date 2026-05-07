use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

pub struct Db {
    pub path: PathBuf,
    pub conn: Connection,
}

impl Db {
    /// Open the v2 app DB at `<dir>/cos.db`, applying the SQLCipher key
    /// from Keychain. If the file exists but is plaintext (older
    /// install before M8 landed), it is migrated to an encrypted form
    /// in-place and the original is rotated to `cos.db.preencrypt-bak`
    /// so the user can recover if the migration goes wrong.
    pub fn open(dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("cos.db");
        let key = crate::secrets::ensure_db_encryption_key()?;
        open_with_key(&path, &key)
    }

    pub fn ping(&self) -> AppResult<PingResult> {
        self.conn.execute(
            "INSERT INTO _ping (at) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            [],
        )?;
        let rows: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM _ping", [], |r| r.get(0))?;
        let last: String = self
            .conn
            .query_row("SELECT at FROM _ping ORDER BY id DESC LIMIT 1", [], |r| {
                r.get(0)
            })?;
        Ok(PingResult {
            rows,
            last_write: last,
        })
    }
}

#[cfg(test)]
impl Db {
    /// Exposes the schema bootstrap to unit tests that build an in-memory db.
    pub fn init_schema_for_test(conn: &Connection) -> AppResult<()> {
        init_schema(conn)
    }

    /// Open with an explicit key, bypassing Keychain. Tests use this
    /// to exercise the encrypt + migrate paths without touching the
    /// system keychain.
    pub fn open_with_key_for_test(dir: &Path, key: &str) -> AppResult<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("cos.db");
        open_with_key(&path, key)
    }
}

/// Open `path` with `key` applied. If the file exists but is
/// plaintext, migrate it before returning. New files are created
/// encrypted.
fn open_with_key(path: &Path, key: &str) -> AppResult<Db> {
    if path.exists() && is_plaintext_sqlite(path)? {
        migrate_plaintext_to_encrypted(path, key)?;
    }
    let conn = Connection::open(path)?;
    apply_key(&conn, key)?;
    // Touch the schema so a wrong key fails fast, and a fresh
    // encrypted DB gets its tables on first open.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    init_schema(&conn)?;
    Ok(Db {
        path: path.to_path_buf(),
        conn,
    })
}

/// Apply the SQLCipher key. PRAGMAs don't accept bound parameters, so
/// we interpolate the hex key directly. `ensure_db_encryption_key`
/// guarantees the value is 64 lowercase hex chars; there's nothing to
/// inject. The `x'...'` form tells SQLCipher the value is raw bytes,
/// not a passphrase to PBKDF2 — skipping the KDF saves ~100ms per
/// open.
fn apply_key(conn: &Connection, key: &str) -> AppResult<()> {
    if !is_hex_key(key) {
        return Err(AppError::InvalidState(format!(
            "encryption key is not 64 hex chars (got {} chars)",
            key.len()
        )));
    }
    conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", key))?;
    Ok(())
}

fn is_hex_key(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Detect whether a file is a plaintext SQLite DB. Reads the 16-byte
/// magic header. Encrypted SQLCipher files have random-looking bytes
/// at offset 0; plaintext SQLite always starts with "SQLite format 3\0".
fn is_plaintext_sqlite(path: &Path) -> AppResult<bool> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut header = [0u8; 16];
    match f.read_exact(&mut header) {
        Ok(()) => Ok(&header == b"SQLite format 3\0"),
        // Empty / truncated file — treat as not plaintext (open will create fresh).
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Plaintext → encrypted migration via SQLCipher's `sqlcipher_export`.
/// Writes a sibling encrypted file, then atomically renames over the
/// original. Keeps a `.preencrypt-bak` copy on the side so a botched
/// migration is recoverable from disk.
fn migrate_plaintext_to_encrypted(path: &Path, key: &str) -> AppResult<()> {
    if !is_hex_key(key) {
        return Err(AppError::InvalidState("invalid encryption key for migration".into()));
    }
    let encrypted_tmp = path.with_extension("db.encrypted-tmp");
    if encrypted_tmp.exists() {
        // Leftover from a previous failed migration — nuke it.
        std::fs::remove_file(&encrypted_tmp)?;
    }
    let plain = Connection::open(path)?;
    plain.execute_batch(&format!(
        "ATTACH DATABASE '{}' AS encrypted KEY \"x'{}'\";
         SELECT sqlcipher_export('encrypted');
         DETACH DATABASE encrypted;",
        // The path is a system temp / app-data path under our
        // control, never user-supplied; quoting it cheaply is fine.
        encrypted_tmp.display().to_string().replace('\'', "''"),
        key
    ))?;
    drop(plain);

    let backup = path.with_extension("db.preencrypt-bak");
    if backup.exists() {
        std::fs::remove_file(&backup)?;
    }
    std::fs::rename(path, &backup)?;
    std::fs::rename(&encrypted_tmp, path)?;
    Ok(())
}

fn init_schema(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS _ping (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL
        );

        -- Per-change snapshot refs (PRD-102 §13a).
        -- Blobs live on disk, content-addressed by SHA256.
        -- This table indexes which blob is the before/after for each write.
        CREATE TABLE IF NOT EXISTS snapshot_refs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            target_kind TEXT NOT NULL,
            target_id TEXT NOT NULL,
            before_hash TEXT,
            after_hash TEXT NOT NULL,
            before_bytes INTEGER,
            after_bytes INTEGER NOT NULL,
            actor TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshot_refs_target
            ON snapshot_refs(target_kind, target_id, at DESC);

        -- Append-only audit log (PRD-102 §12).
        -- Each row hashes (prev_hash || canonical row fields) so a tampered
        -- row breaks the chain on the next verification.
        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            target_kind TEXT NOT NULL,
            target_id TEXT NOT NULL,
            detail_json TEXT NOT NULL DEFAULT '{}',
            prev_hash TEXT NOT NULL,
            this_hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC);

        -- Append-only triggers — updates/deletes raise.
        CREATE TRIGGER IF NOT EXISTS audit_no_update
            BEFORE UPDATE ON audit
            BEGIN SELECT RAISE(FAIL, 'audit log is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS audit_no_delete
            BEFORE DELETE ON audit
            BEGIN SELECT RAISE(FAIL, 'audit log is append-only'); END;
        "#,
    )?;
    let current: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |r| r.get(0))?;
    if current < 1 {
        conn.execute("INSERT INTO schema_version (version) VALUES (1)", [])?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct PingResult {
    pub rows: i64,
    pub last_write: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// 32-byte hex key — different from the one in the next test so a
    /// wrong-key check is meaningful.
    const KEY_A: &str = "0011223344556677889900112233445566778899001122334455667788990011";
    const KEY_B: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn read_header(path: &Path) -> Vec<u8> {
        use std::io::Read;
        let mut f = std::fs::File::open(path).unwrap();
        let mut buf = [0u8; 16];
        let _ = f.read(&mut buf);
        buf.to_vec()
    }

    #[test]
    fn fresh_db_is_encrypted() {
        let tmp = TempDir::new().unwrap();
        let db = Db::open_with_key_for_test(tmp.path(), KEY_A).unwrap();
        // Force a write so the file is fully materialized.
        db.ping().unwrap();
        drop(db);

        let header = read_header(&tmp.path().join("cos.db"));
        assert_ne!(
            &header, b"SQLite format 3\0",
            "fresh DB should be SQLCipher-encrypted, not plaintext"
        );
    }

    #[test]
    fn wrong_key_fails_to_read() {
        let tmp = TempDir::new().unwrap();
        let db = Db::open_with_key_for_test(tmp.path(), KEY_A).unwrap();
        db.ping().unwrap();
        drop(db);

        // Reopen with the wrong key — schema query should error.
        let path = tmp.path().join("cos.db");
        let conn = Connection::open(&path).unwrap();
        apply_key(&conn, KEY_B).unwrap();
        let result: rusqlite::Result<i64> =
            conn.query_row("SELECT COUNT(*) FROM _ping", [], |r| r.get(0));
        assert!(
            result.is_err(),
            "wrong key should not be able to read the schema"
        );
    }

    #[test]
    fn correct_key_roundtrips_data() {
        let tmp = TempDir::new().unwrap();
        let db = Db::open_with_key_for_test(tmp.path(), KEY_A).unwrap();
        db.ping().unwrap();
        db.ping().unwrap();
        let rows_before: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM _ping", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows_before, 2);
        drop(db);

        let db2 = Db::open_with_key_for_test(tmp.path(), KEY_A).unwrap();
        let rows_after: i64 = db2
            .conn
            .query_row("SELECT COUNT(*) FROM _ping", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            rows_after, 2,
            "writes from the first session should survive a reopen"
        );
    }

    #[test]
    fn plaintext_db_migrates_on_open() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("cos.db");

        // Step 1: hand-craft a plaintext SQLite DB at the canonical path.
        {
            let conn = Connection::open(&path).unwrap();
            init_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO _ping (at) VALUES ('2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let header_before = read_header(&path);
        assert_eq!(
            &header_before, b"SQLite format 3\0",
            "test setup: file should start out plaintext"
        );

        // Step 2: open through Db::open — should migrate transparently.
        let db = Db::open_with_key_for_test(tmp.path(), KEY_A).unwrap();
        let rows: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM _ping", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the pre-existing row must survive migration");

        // Step 3: file on disk is now encrypted, and the .preencrypt-bak
        // sibling holds the original plaintext for recovery.
        drop(db);
        let header_after = read_header(&path);
        assert_ne!(
            &header_after, b"SQLite format 3\0",
            "after migration the live file should be encrypted"
        );
        let backup = tmp.path().join("cos.db.preencrypt-bak");
        assert!(backup.exists(), "plaintext backup must remain on disk");
        let backup_header = read_header(&backup);
        assert_eq!(
            &backup_header, b"SQLite format 3\0",
            "the .preencrypt-bak copy must still be plaintext-readable"
        );
    }

    #[test]
    fn migration_is_idempotent_after_already_encrypted() {
        let tmp = TempDir::new().unwrap();
        // First open: creates fresh encrypted DB.
        let db = Db::open_with_key_for_test(tmp.path(), KEY_A).unwrap();
        db.ping().unwrap();
        drop(db);
        let header_after_first = read_header(&tmp.path().join("cos.db"));

        // Second open: must NOT trigger migration (no .preencrypt-bak,
        // header byte-for-byte unchanged across the open).
        let db2 = Db::open_with_key_for_test(tmp.path(), KEY_A).unwrap();
        drop(db2);
        let header_after_second = read_header(&tmp.path().join("cos.db"));
        assert_eq!(
            header_after_first, header_after_second,
            "an already-encrypted DB must not re-migrate"
        );
        assert!(
            !tmp.path().join("cos.db.preencrypt-bak").exists(),
            ".preencrypt-bak should not appear when no migration was needed"
        );
    }

    #[test]
    fn is_hex_key_rejects_non_hex_and_uppercase() {
        assert!(is_hex_key(KEY_A));
        assert!(!is_hex_key("short"));
        assert!(!is_hex_key(&"g".repeat(64)));
        assert!(!is_hex_key(&"A".repeat(64)));
        assert!(!is_hex_key(&"0".repeat(63)));
    }
}
