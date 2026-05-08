use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::AppResult;

/// 32 bytes of 0x00, hex-encoded. The prev_hash for the very first row.
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Append an entry to the hash-chained audit log. Returns the new row's id.
/// Must be called inside a transaction owned by the caller so the snapshot
/// ref + audit write commit atomically.
pub fn append(
    conn: &Connection,
    actor: &str,
    action: &str,
    target_kind: &str,
    target_id: &str,
    detail_json: &str,
) -> AppResult<i64> {
    let at: String = conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        [],
        |r| r.get(0),
    )?;

    let prev_hash: String = conn
        .query_row(
            "SELECT COALESCE((SELECT this_hash FROM audit ORDER BY id DESC LIMIT 1), ?1)",
            params![GENESIS],
            |r| r.get(0),
        )?;

    let this_hash = compute_hash(
        &prev_hash,
        &at,
        actor,
        action,
        target_kind,
        target_id,
        detail_json,
    );

    conn.execute(
        r#"
        INSERT INTO audit (at, actor, action, target_kind, target_id,
                           detail_json, prev_hash, this_hash)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
        params![
            at, actor, action, target_kind, target_id, detail_json,
            prev_hash, this_hash
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

fn compute_hash(
    prev: &str,
    at: &str,
    actor: &str,
    action: &str,
    target_kind: &str,
    target_id: &str,
    detail_json: &str,
) -> String {
    // Canonical form: NUL-separated to avoid field-boundary ambiguity.
    let mut h = Sha256::new();
    for field in [prev, at, actor, action, target_kind, target_id, detail_json] {
        h.update(field.as_bytes());
        h.update([0u8]);
    }
    hex::encode(h.finalize())
}

#[derive(Serialize, Clone, Debug)]
pub struct AuditRow {
    pub id: i64,
    pub at: String,
    pub actor: String,
    pub action: String,
    pub target_kind: String,
    pub target_id: String,
    pub detail_json: String,
    pub this_hash: String,
}

/// Look up a single audit row by id. Returns None when the id doesn't
/// exist — caller decides whether that's an error vs "no-op".
pub fn get(conn: &Connection, id: i64) -> AppResult<Option<AuditRow>> {
    let row = conn
        .query_row(
            r#"
            SELECT id, at, actor, action, target_kind, target_id,
                   detail_json, this_hash
            FROM audit
            WHERE id = ?1
            "#,
            params![id],
            |r| {
                Ok(AuditRow {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    actor: r.get(2)?,
                    action: r.get(3)?,
                    target_kind: r.get(4)?,
                    target_id: r.get(5)?,
                    detail_json: r.get(6)?,
                    this_hash: r.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Filter audit rows by action / target_id substring / date range.
/// All filters optional; empty / None means "no constraint". Always
/// orders id DESC and caps at `limit`.
///
/// `action_prefix`: matches if `action` starts with the given string
/// — the audit vocabulary uses dot-namespaced actions like
/// `doc.write` / `task.complete` / `task.update`. Passing `task.`
/// matches every task action. Passing `task.complete` matches only
/// completes. Passing empty string is treated as "no filter".
///
/// `target_query`: case-insensitive substring match against
/// `target_id`. Useful for "find every audit row touching the file
/// X.md" without needing the full path.
///
/// `from_iso` / `to_iso`: optional `YYYY-MM-DD` bounds on `at`. The
/// `at` column is full ISO-8601 with milliseconds; we string-compare
/// the prefix, so `from='2026-04-01'` keeps everything after that
/// midnight UTC (good enough for a forensic log).
pub fn filter(
    conn: &Connection,
    action_prefix: &str,
    target_query: &str,
    from_iso: Option<&str>,
    to_iso: Option<&str>,
    limit: i64,
) -> AppResult<Vec<AuditRow>> {
    // Build the query incrementally so empty filters become "no
    // constraint" rather than "matches empty string".
    let mut sql = String::from(
        r#"
        SELECT id, at, actor, action, target_kind, target_id,
               detail_json, this_hash
        FROM audit
        WHERE 1=1
        "#,
    );
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if !action_prefix.is_empty() {
        sql.push_str(" AND action LIKE ?");
        binds.push(Box::new(format!("{action_prefix}%")));
    }
    if !target_query.is_empty() {
        sql.push_str(" AND lower(target_id) LIKE ?");
        binds.push(Box::new(format!("%{}%", target_query.to_lowercase())));
    }
    if let Some(from) = from_iso.filter(|s| !s.is_empty()) {
        sql.push_str(" AND at >= ?");
        binds.push(Box::new(from.to_string()));
    }
    if let Some(to) = to_iso.filter(|s| !s.is_empty()) {
        // Inclusive of the to-day; bump to next-day midnight is
        // cleaner but requires date math. String prefix lets us
        // accept `to='2026-04-25'` and match through that day.
        sql.push_str(" AND at < ?");
        binds.push(Box::new(format!("{to}T99:99:99Z")));
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");
    binds.push(Box::new(limit));

    let bind_refs: Vec<&dyn rusqlite::ToSql> =
        binds.iter().map(|b| b.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(bind_refs.as_slice(), |r| {
        Ok(AuditRow {
            id: r.get(0)?,
            at: r.get(1)?,
            actor: r.get(2)?,
            action: r.get(3)?,
            target_kind: r.get(4)?,
            target_id: r.get(5)?,
            detail_json: r.get(6)?,
            this_hash: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn recent(conn: &Connection, limit: i64) -> AppResult<Vec<AuditRow>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, at, actor, action, target_kind, target_id, detail_json,
               this_hash
        FROM audit
        ORDER BY id DESC
        LIMIT ?1
        "#,
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok(AuditRow {
            id: r.get(0)?,
            at: r.get(1)?,
            actor: r.get(2)?,
            action: r.get(3)?,
            target_kind: r.get(4)?,
            target_id: r.get(5)?,
            detail_json: r.get(6)?,
            this_hash: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Verify the audit chain: each row's this_hash recomputes correctly,
/// and prev_hash equals the previous row's this_hash (or GENESIS for id=1).
/// Returns Ok(None) if the chain is intact, or Ok(Some(broken_id)) pointing
/// at the first tampered row.
pub fn verify_chain(conn: &Connection) -> AppResult<Option<i64>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, at, actor, action, target_kind, target_id, detail_json,
               prev_hash, this_hash
        FROM audit
        ORDER BY id ASC
        "#,
    )?;
    let mut expected_prev = GENESIS.to_string();
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))
    })?;
    for row in rows {
        let (id, at, actor, action, kind, target, detail, prev, this) = row?;
        if prev != expected_prev {
            return Ok(Some(id));
        }
        let recomputed = compute_hash(&prev, &at, &actor, &action, &kind, &target, &detail);
        if recomputed != this {
            return Ok(Some(id));
        }
        expected_prev = this;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::Db::init_schema_for_test(&conn).unwrap();
        conn
    }

    fn seed(conn: &Connection) {
        // The audit table has an append-only trigger so we can't
        // backfill `at`. We seed real rows (timestamps = now) and
        // exercise date filtering via boundary queries that fall
        // outside the run window.
        append(conn, "local", "doc.write", "doc", "areas/x/a.md", "{}").unwrap();
        append(conn, "local", "doc.write", "doc", "areas/x/b.md", "{}").unwrap();
        append(conn, "local", "task.complete", "task", "t1", "{}").unwrap();
        append(conn, "local", "task.update", "task", "t2", "{}").unwrap();
    }

    #[test]
    fn filter_with_no_constraints_returns_all_desc() {
        let conn = open();
        seed(&conn);
        let rows = filter(&conn, "", "", None, None, 50).unwrap();
        assert_eq!(rows.len(), 4);
        // ORDER BY id DESC → most recent first.
        assert_eq!(rows[0].id, 4);
        assert_eq!(rows[3].id, 1);
    }

    #[test]
    fn filter_action_prefix_matches_namespaced_actions() {
        let conn = open();
        seed(&conn);
        let task_rows = filter(&conn, "task.", "", None, None, 50).unwrap();
        assert_eq!(task_rows.len(), 2);
        assert!(task_rows.iter().all(|r| r.action.starts_with("task.")));

        let doc_rows = filter(&conn, "doc.write", "", None, None, 50).unwrap();
        assert_eq!(doc_rows.len(), 2);
    }

    #[test]
    fn filter_target_query_is_case_insensitive_substring() {
        let conn = open();
        seed(&conn);
        let rows = filter(&conn, "", "X/A", None, None, 50).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_id, "areas/x/a.md");
    }

    #[test]
    fn filter_date_range_drops_rows_outside_window() {
        let conn = open();
        seed(&conn);
        // Far-future from-date: no rows should match.
        let rows =
            filter(&conn, "", "", Some("3000-01-01"), None, 50).unwrap();
        assert_eq!(rows.len(), 0);
        // Far-past to-date: no rows should match either.
        let rows =
            filter(&conn, "", "", None, Some("1970-01-01"), 50).unwrap();
        assert_eq!(rows.len(), 0);
        // Inside-the-run window: all 4 match (rows are stamped 'now').
        let rows =
            filter(&conn, "", "", Some("2000-01-01"), Some("3000-01-01"), 50)
                .unwrap();
        assert_eq!(rows.len(), 4);
    }

    #[test]
    fn filter_combines_constraints() {
        let conn = open();
        seed(&conn);
        // doc. + 'b.md' → exactly one row.
        let rows = filter(&conn, "doc.", "b.md", None, None, 50).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].target_id, "areas/x/b.md");
        // doc. + 'b.md' + a future from-date → no match (date overrides).
        let rows = filter(
            &conn,
            "doc.",
            "b.md",
            Some("3000-01-01"),
            None,
            50,
        )
        .unwrap();
        assert_eq!(rows.len(), 0);
    }

    #[test]
    fn filter_respects_limit() {
        let conn = open();
        seed(&conn);
        let rows = filter(&conn, "", "", None, None, 2).unwrap();
        assert_eq!(rows.len(), 2);
    }
}
