//! Disk health snapshot for the Diagnostics panel. Pure inventory:
//! audit row count, blob store size + count, oldest restorable
//! doc.write, content tree size + file count. Helps the user trust
//! the safety floor by making it visible.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::AppResult;

#[derive(Serialize, Clone, Debug)]
pub struct DiskHealth {
    /// Total audit rows (append-only — strictly grows).
    pub audit_rows: i64,
    /// Most-recent audit at timestamp (ISO-8601 UTC); None if empty.
    pub audit_latest_at: Option<String>,
    /// Bytes used by the audit DB file.
    pub audit_db_bytes: u64,
    /// Number of files inside the blob store.
    pub blob_count: u64,
    /// Total bytes of the blob store on disk (sum of file sizes).
    pub blob_bytes: u64,
    /// The oldest doc.write audit row whose before_hash is still
    /// recoverable from the blob store. Lets the user answer "how
    /// far back can I roll a doc?".
    pub oldest_restorable_at: Option<String>,
    /// Number of .md files in the content root (excluding archive/
    /// and dotfiles). Useful as a "size of the working set" hint.
    pub content_md_count: u64,
    /// Total bytes of those files.
    pub content_md_bytes: u64,
}

pub fn snapshot(
    audit_db: &Connection,
    audit_db_path: &Path,
    blob_root: &Path,
    content_root: &Path,
) -> AppResult<DiskHealth> {
    let audit_rows: i64 = audit_db
        .query_row("SELECT COUNT(*) FROM audit", [], |r| r.get(0))
        .unwrap_or(0);
    let audit_latest_at: Option<String> = audit_db
        .query_row(
            "SELECT at FROM audit ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    let audit_db_bytes = std::fs::metadata(audit_db_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let (blob_count, blob_bytes) = walk_blob_store(blob_root);
    let oldest_restorable_at = oldest_restorable(audit_db, blob_root);

    let (content_md_count, content_md_bytes) = walk_content_md(content_root);

    Ok(DiskHealth {
        audit_rows,
        audit_latest_at,
        audit_db_bytes,
        blob_count,
        blob_bytes,
        oldest_restorable_at,
        content_md_count,
        content_md_bytes,
    })
}

fn walk_blob_store(root: &Path) -> (u64, u64) {
    if !root.is_dir() {
        return (0, 0);
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return (0, 0),
    };
    for shard in entries.flatten() {
        let p = shard.path();
        if !p.is_dir() {
            continue;
        }
        let inner = match std::fs::read_dir(&p) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for blob in inner.flatten() {
            let bp = blob.path();
            if let Ok(meta) = std::fs::metadata(&bp) {
                if meta.is_file() {
                    count += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    (count, bytes)
}

/// Find the oldest audit row whose before_hash is still on disk.
/// Walking from the END backwards and stopping at the first hit
/// would be wrong — we want the OLDEST recoverable row, not the
/// most-recent. So scan in id-asc order and return the first row
/// whose blob is present.
fn oldest_restorable(conn: &Connection, blob_root: &Path) -> Option<String> {
    let mut stmt = match conn.prepare(
        r#"
        SELECT at, detail_json
          FROM audit
         WHERE action = 'doc.write'
         ORDER BY id ASC
        "#,
    ) {
        Ok(s) => s,
        Err(_) => return None,
    };
    let mut rows = match stmt.query([]) {
        Ok(r) => r,
        Err(_) => return None,
    };
    while let Ok(Some(row)) = rows.next() {
        let at: String = match row.get(0) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let detail: String = match row.get(1) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_str(&detail) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let before = match parsed.get("before_hash").and_then(|v| v.as_str()) {
            Some(h) => h,
            None => continue,
        };
        // Mirror BlobStore::path_for: 2-char prefix sharding.
        if before.len() < 3 {
            continue;
        }
        let (prefix, rest) = before.split_at(2);
        let blob_path = blob_root.join(prefix).join(rest);
        if blob_path.is_file() {
            return Some(at);
        }
    }
    None
}

fn walk_content_md(root: &Path) -> (u64, u64) {
    if !root.is_dir() {
        return (0, 0);
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                if name == "archive" || name == "node_modules" {
                    continue;
                }
                stack.push(p);
            } else if name.ends_with(".md") {
                if let Ok(meta) = std::fs::metadata(&p) {
                    count += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    (count, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn open_mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::Db::init_schema_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn empty_disk_health_snapshot_is_all_zeros() {
        let tmp = TempDir::new().unwrap();
        let conn = open_mem_db();
        // Use a never-created path so audit_db_bytes returns 0.
        let phantom_db = tmp.path().join("does-not-exist.db");
        let blob_root = tmp.path().join("blobs");
        let content_root = tmp.path().join("content");
        let h = snapshot(&conn, &phantom_db, &blob_root, &content_root).unwrap();
        assert_eq!(h.audit_rows, 0);
        assert_eq!(h.audit_latest_at, None);
        assert_eq!(h.audit_db_bytes, 0);
        assert_eq!(h.blob_count, 0);
        assert_eq!(h.blob_bytes, 0);
        assert_eq!(h.oldest_restorable_at, None);
        assert_eq!(h.content_md_count, 0);
        assert_eq!(h.content_md_bytes, 0);
    }

    #[test]
    fn walk_blob_store_counts_sharded_files() {
        let tmp = TempDir::new().unwrap();
        // Mirror BlobStore's 2-char-prefix sharding.
        fs::create_dir_all(tmp.path().join("ab")).unwrap();
        fs::create_dir_all(tmp.path().join("cd")).unwrap();
        fs::write(tmp.path().join("ab/cdef"), b"first blob").unwrap();
        fs::write(tmp.path().join("ab/ghij"), b"second blob").unwrap();
        fs::write(tmp.path().join("cd/efgh"), b"third").unwrap();
        let (count, bytes) = walk_blob_store(tmp.path());
        assert_eq!(count, 3);
        assert_eq!(bytes, 10 + 11 + 5);
    }

    #[test]
    fn walk_content_md_skips_archive_and_dotfiles() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("areas/x")).unwrap();
        fs::create_dir_all(tmp.path().join("archive")).unwrap();
        fs::create_dir_all(tmp.path().join(".cache")).unwrap();
        fs::write(tmp.path().join("areas/x/a.md"), "AAA").unwrap();
        fs::write(tmp.path().join("areas/x/b.md"), "BBBB").unwrap();
        fs::write(tmp.path().join("archive/old.md"), "ignored").unwrap();
        fs::write(tmp.path().join(".cache/skip.md"), "ignored").unwrap();
        fs::write(tmp.path().join("areas/x/notes.txt"), "non-md").unwrap();
        let (count, bytes) = walk_content_md(tmp.path());
        assert_eq!(count, 2);
        assert_eq!(bytes, 3 + 4);
    }

    #[test]
    fn oldest_restorable_returns_oldest_recoverable_row() {
        let tmp = TempDir::new().unwrap();
        let blob_root = tmp.path().join("blobs");
        // Plant two pseudo-blobs whose hashes match what we'll record.
        fs::create_dir_all(blob_root.join("aa")).unwrap();
        fs::write(blob_root.join("aa/aaaaaa"), b"older").unwrap();
        fs::create_dir_all(blob_root.join("bb")).unwrap();
        fs::write(blob_root.join("bb/bbbbbb"), b"newer").unwrap();

        let conn = open_mem_db();
        // Three audit rows. First write's blob is missing (simulates
        // a pre-fix doc.write); second + third have blobs present.
        // Oldest_restorable should return the second row's at.
        crate::audit::append(
            &conn,
            "local",
            "doc.write",
            "doc",
            "old.md",
            r#"{"before_hash":"deadbeefXXXX"}"#,
        )
        .unwrap();
        crate::audit::append(
            &conn,
            "local",
            "doc.write",
            "doc",
            "mid.md",
            r#"{"before_hash":"aaaaaaaa"}"#,
        )
        .unwrap();
        crate::audit::append(
            &conn,
            "local",
            "doc.write",
            "doc",
            "new.md",
            r#"{"before_hash":"bbbbbbbb"}"#,
        )
        .unwrap();

        let oldest = oldest_restorable(&conn, &blob_root);
        assert!(oldest.is_some());
        // Mid row was the second insert, so its at-timestamp matches
        // the row we expect. We can't pin the exact string (it's
        // strftime('now')), but it must be >= the first row's at.
        let mid_at: String = conn
            .query_row("SELECT at FROM audit WHERE id = 2", [], |r| r.get(0))
            .unwrap();
        assert_eq!(oldest.unwrap(), mid_at);
    }
}
