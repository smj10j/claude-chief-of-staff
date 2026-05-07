use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;

use crate::audit;
use crate::error::{AppError, AppResult};

/// Read-only access to the v1 task database.
/// Every read opens a fresh connection so concurrent writes from the v1 CLI
/// don't see a stale handle.
#[derive(Clone)]
pub struct V1Tasks {
    path: PathBuf,
}

#[derive(Serialize, Clone, Debug)]
pub struct V1Task {
    pub id: String,
    pub title: String,
    pub status: String,
    pub priority: String,
    pub due: Option<String>,
    pub project: Option<String>,
    pub notes: Option<String>,
    pub tags: Vec<String>,
    pub links: Vec<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Serialize)]
pub struct V1Status {
    pub path: String,
    pub found: bool,
}

impl V1Tasks {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn status(&self) -> V1Status {
        V1Status {
            path: self.path.display().to_string(),
            found: self.path.exists(),
        }
    }

    /// Create the v1 task DB at `self.path` with the canonical
    /// schema if it doesn't already exist. Idempotent: an existing
    /// DB is left alone, even if its schema is stale (the
    /// `CREATE TABLE IF NOT EXISTS` clauses in the embedded SQL
    /// handle that case for fresh tables; real migrations beyond
    /// v1 land via the bin/db/migrations/ pipeline that the CLI
    /// applies).
    ///
    /// Returns `Ok(true)` when the DB was created, `Ok(false)`
    /// when an existing DB was reused.
    pub fn ensure_initialized(&self) -> AppResult<bool> {
        if self.path.exists() {
            return Ok(false);
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&self.path)?;
        conn.execute_batch(SCHEMA_INITIAL)?;
        // Stamp schema_migrations so the bin/db CLI knows this DB is
        // at version 1 and won't try to re-apply.
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (1, ?1)",
            ["initial schema (auto-created by v2 app on first launch)"],
        )?;
        Ok(true)
    }
}

/// Embedded copy of `bin/db/migrations/001-initial-schema.sql`.
/// Bundled at compile time so a fresh install never depends on the
/// repo being present at runtime.
const SCHEMA_INITIAL: &str = include_str!(
    "../../../../bin/db/migrations/001-initial-schema.sql"
);

// Re-open the impl so the trailing methods (list_active, etc.) stay
// part of the same struct.
impl V1Tasks {

    fn open(&self) -> AppResult<Connection> {
        let conn = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(conn)
    }

    fn open_rw(&self) -> AppResult<Connection> {
        let conn = Connection::open(&self.path)?;
        // v1 CLI uses WAL; make sure we stay compatible with concurrent readers.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        Ok(conn)
    }

    /// Active (non-archived) tasks ordered by: priority, due date, title.
    pub fn list_active(&self) -> AppResult<Vec<V1Task>> {
        if !self.path.exists() {
            return Ok(vec![]);
        }
        let conn = self.open()?;

        let mut stmt = conn.prepare(
            r#"
            SELECT id, title, status, priority, due, project, notes,
                   created_at, updated_at
            FROM tasks
            WHERE is_archived = 0
            ORDER BY
              CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              COALESCE(due, '9999-12-31'),
              title
            "#,
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(V1Task {
                id: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                priority: r.get(3)?,
                due: r.get(4)?,
                project: r.get(5)?,
                notes: r.get(6)?,
                tags: Vec::new(),
                links: Vec::new(),
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })?;
        let mut tasks: Vec<V1Task> = rows.collect::<Result<_, _>>()?;

        let tags = load_tags(&conn)?;
        let links = load_links(&conn)?;
        for t in tasks.iter_mut() {
            if let Some(ts) = tags.get(&t.id) {
                t.tags = ts.clone();
            }
            if let Some(ls) = links.get(&t.id) {
                t.links = ls.clone();
            }
        }
        Ok(tasks)
    }

    /// Create a new v1 task. Minimum input is a non-empty title; everything
    /// else is optional and defaults to the same values v1 CLI uses:
    /// priority='medium', status='todo', no due/project/notes/tags/links.
    ///
    /// The new row's id is a slug of the title with collision suffixing
    /// (`write-m1a`, `write-m1a-2`, …) — same algorithm as v1
    /// `generateId`.
    ///
    /// Writes a `task.create` audit row with the full initial row in
    /// `detail_json.task`. Returns the freshly-loaded V1Task so the UI can
    /// select it immediately without a follow-up list refetch.
    pub fn create_task(
        &self,
        input: &serde_json::Value,
        audit_conn: &mut Connection,
        actor: &str,
    ) -> AppResult<V1Task> {
        if !self.path.exists() {
            return Err(AppError::NotFound(format!(
                "v1 db at {}",
                self.path.display()
            )));
        }
        let input = input.as_object().ok_or_else(|| {
            AppError::InvalidState("input must be a JSON object".into())
        })?;

        // --- Validate the input. No DB changes until every check passes.
        let title = input
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::InvalidState("title is required".into()))?
            .to_string();

        let priority = match input.get("priority") {
            None | Some(serde_json::Value::Null) => "medium".to_string(),
            Some(serde_json::Value::String(s)) => {
                if !matches!(s.as_str(), "high" | "medium" | "low") {
                    return Err(AppError::InvalidState(format!(
                        "priority '{}' invalid",
                        s
                    )));
                }
                s.clone()
            }
            _ => {
                return Err(AppError::InvalidState(
                    "priority must be a string".into(),
                ))
            }
        };

        let due = match input.get("due") {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(s)) if s.is_empty() => None,
            Some(serde_json::Value::String(s)) => {
                validate_date(s)?;
                Some(s.clone())
            }
            _ => {
                return Err(AppError::InvalidState(
                    "due must be a YYYY-MM-DD[ HH:MM] string or null".into(),
                ))
            }
        };

        let project = optional_string(input.get("project"), "project")?;
        let notes = optional_string(input.get("notes"), "notes")?;

        let tags = match input.get("tags") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(serde_json::Value::Array(arr)) => {
                let mut out = Vec::with_capacity(arr.len());
                for v in arr {
                    let s = v.as_str().ok_or_else(|| {
                        AppError::InvalidState("each tag must be a string".into())
                    })?;
                    let trimmed = s.trim();
                    if trimmed.is_empty() {
                        return Err(AppError::InvalidState(
                            "tags cannot be empty strings".into(),
                        ));
                    }
                    out.push(trimmed.to_string());
                }
                out.sort();
                out.dedup();
                out
            }
            _ => {
                return Err(AppError::InvalidState("tags must be an array".into()))
            }
        };

        let links = match input.get("links") {
            None | Some(serde_json::Value::Null) => Vec::new(),
            Some(serde_json::Value::Array(arr)) => {
                let mut out = Vec::with_capacity(arr.len());
                for v in arr {
                    let s = v.as_str().ok_or_else(|| {
                        AppError::InvalidState("each link must be a string".into())
                    })?;
                    let trimmed = s.trim();
                    if trimmed.is_empty() {
                        return Err(AppError::InvalidState(
                            "links cannot be empty strings".into(),
                        ));
                    }
                    out.push(trimmed.to_string());
                }
                out
            }
            _ => {
                return Err(AppError::InvalidState("links must be an array".into()))
            }
        };

        let mut conn = self.open_rw()?;
        let id = generate_id(&conn, &title)?;

        // --- Write inside a transaction so a failed tag/link insert doesn't
        //     leave a half-created row behind.
        let tx = conn.transaction()?;
        tx.execute(
            r#"
            INSERT INTO tasks
              (id, title, status, priority, due, project, notes,
               created_at, updated_at, is_archived)
            VALUES
              (?1, ?2, 'todo', ?3, ?4, ?5, ?6,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               0)
            "#,
            params![id, title, priority, due, project, notes],
        )?;
        for tag in &tags {
            tx.execute(
                "INSERT INTO task_tags (task_id, tag) VALUES (?1, ?2)",
                params![id, tag],
            )?;
        }
        for url in &links {
            tx.execute(
                "INSERT INTO task_links (task_id, url) VALUES (?1, ?2)",
                params![id, url],
            )?;
        }
        tx.commit()?;

        // Re-load the full row with the real created_at/updated_at.
        let fresh = self
            .get_task(&id)?
            .ok_or_else(|| AppError::InvalidState(format!(
                "task {} vanished after create",
                id
            )))?;

        let detail = serde_json::json!({
            "task": {
                "id": fresh.id,
                "title": fresh.title,
                "status": fresh.status,
                "priority": fresh.priority,
                "due": fresh.due,
                "project": fresh.project,
                "notes": fresh.notes,
                "tags": fresh.tags,
                "links": fresh.links,
            },
        })
        .to_string();
        let atx = audit_conn.transaction()?;
        audit::append(&atx, actor, "task.create", "v1_task", &id, &detail)?;
        atx.commit()?;

        Ok(fresh)
    }

    /// Read a single task by id, shaped like rows returned by `list_active`.
    /// Used by IPC handlers that need to return the fresh row after a write
    /// (so the UI doesn't have to refetch the whole list).
    pub fn get_task(&self, id: &str) -> AppResult<Option<V1Task>> {
        if !self.path.exists() {
            return Ok(None);
        }
        let conn = self.open()?;
        let task = conn.query_row(
            r#"
            SELECT id, title, status, priority, due, project, notes,
                   created_at, updated_at
            FROM tasks
            WHERE id = ?1
            "#,
            params![id],
            |r| {
                Ok(V1Task {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    status: r.get(2)?,
                    priority: r.get(3)?,
                    due: r.get(4)?,
                    project: r.get(5)?,
                    notes: r.get(6)?,
                    tags: Vec::new(),
                    links: Vec::new(),
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            },
        );
        let mut task = match task {
            Ok(t) => t,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        task.tags = load_tags_for(&conn, id)?;
        task.links = load_links_for(&conn, id)?;
        Ok(Some(task))
    }

    /// Patch a v1 task's editable fields. Accepts a JSON object where each
    /// present key names a field to change; omitted keys are left alone.
    ///
    /// Allowed scalar fields: `title`, `status` (todo|in-progress only),
    /// `priority` (high|medium|low), `due` (YYYY-MM-DD or null), `project`,
    /// `notes`. `tags` and `links` are replace-wholesale arrays.
    ///
    /// Mirrors v1 `updateTask` semantics:
    ///   - rejects archived rows (unarchive first if needed),
    ///   - rejects lifecycle fields (is_archived / completed_at / archived_at),
    ///   - rejects status=done via this path (must go through complete_task).
    ///
    /// Writes a single `task.update` audit row with the per-field before/after
    /// diff in detail_json. If the patch is a no-op (nothing actually changes),
    /// returns without touching the DB or the audit log.
    pub fn update_task(
        &self,
        id: &str,
        patch: &serde_json::Value,
        audit_conn: &mut Connection,
        actor: &str,
    ) -> AppResult<()> {
        if !self.path.exists() {
            return Err(AppError::NotFound(format!(
                "v1 db at {}",
                self.path.display()
            )));
        }
        let patch = patch.as_object().ok_or_else(|| {
            AppError::InvalidState("patch must be a JSON object".into())
        })?;

        let mut conn = self.open_rw()?;

        let before = load_task_row(&conn, id)?.ok_or_else(|| {
            AppError::NotFound(format!("task {}", id))
        })?;
        if before.is_archived {
            return Err(AppError::InvalidState(format!(
                "task {} is archived — unarchive first",
                id
            )));
        }
        let before_tags = load_tags_for(&conn, id)?;
        let before_links = load_links_for(&conn, id)?;

        // Validate + collect scalar patches.
        let mut scalar_sql: Vec<String> = Vec::new();
        let mut scalar_params: Vec<rusqlite::types::Value> = Vec::new();
        let mut tags_patch: Option<Vec<String>> = None;
        let mut links_patch: Option<Vec<String>> = None;

        for (k, v) in patch {
            match k.as_str() {
                "title" => {
                    let s = v.as_str().ok_or_else(|| {
                        AppError::InvalidState("title must be a string".into())
                    })?;
                    if s.trim().is_empty() {
                        return Err(AppError::InvalidState(
                            "title cannot be empty".into(),
                        ));
                    }
                    scalar_sql.push("title = ?".into());
                    scalar_params.push(s.to_string().into());
                }
                "status" => {
                    let s = v.as_str().ok_or_else(|| {
                        AppError::InvalidState("status must be a string".into())
                    })?;
                    if s != "todo" && s != "in-progress" {
                        return Err(AppError::InvalidState(format!(
                            "status '{}' not settable here — use complete_task for done",
                            s
                        )));
                    }
                    scalar_sql.push("status = ?".into());
                    scalar_params.push(s.to_string().into());
                }
                "priority" => {
                    let s = v.as_str().ok_or_else(|| {
                        AppError::InvalidState("priority must be a string".into())
                    })?;
                    if !matches!(s, "high" | "medium" | "low") {
                        return Err(AppError::InvalidState(format!(
                            "priority '{}' invalid",
                            s
                        )));
                    }
                    scalar_sql.push("priority = ?".into());
                    scalar_params.push(s.to_string().into());
                }
                "due" => {
                    scalar_sql.push("due = ?".into());
                    match v {
                        serde_json::Value::Null => {
                            scalar_params.push(rusqlite::types::Value::Null);
                        }
                        serde_json::Value::String(s) if s.is_empty() => {
                            scalar_params.push(rusqlite::types::Value::Null);
                        }
                        serde_json::Value::String(s) => {
                            validate_date(s)?;
                            scalar_params.push(s.clone().into());
                        }
                        _ => {
                            return Err(AppError::InvalidState(
                                "due must be a YYYY-MM-DD string or null".into(),
                            ))
                        }
                    }
                }
                "project" => {
                    scalar_sql.push("project = ?".into());
                    match v {
                        serde_json::Value::Null => {
                            scalar_params.push(rusqlite::types::Value::Null);
                        }
                        serde_json::Value::String(s) if s.is_empty() => {
                            scalar_params.push(rusqlite::types::Value::Null);
                        }
                        serde_json::Value::String(s) => {
                            scalar_params.push(s.clone().into());
                        }
                        _ => {
                            return Err(AppError::InvalidState(
                                "project must be a string or null".into(),
                            ))
                        }
                    }
                }
                "notes" => {
                    scalar_sql.push("notes = ?".into());
                    match v {
                        serde_json::Value::Null => {
                            scalar_params.push(rusqlite::types::Value::Null);
                        }
                        serde_json::Value::String(s) if s.is_empty() => {
                            scalar_params.push(rusqlite::types::Value::Null);
                        }
                        serde_json::Value::String(s) => {
                            scalar_params.push(s.clone().into());
                        }
                        _ => {
                            return Err(AppError::InvalidState(
                                "notes must be a string or null".into(),
                            ))
                        }
                    }
                }
                "tags" => {
                    let arr = v.as_array().ok_or_else(|| {
                        AppError::InvalidState("tags must be an array".into())
                    })?;
                    let mut out = Vec::with_capacity(arr.len());
                    for entry in arr {
                        let s = entry.as_str().ok_or_else(|| {
                            AppError::InvalidState("each tag must be a string".into())
                        })?;
                        let trimmed = s.trim();
                        if trimmed.is_empty() {
                            return Err(AppError::InvalidState(
                                "tags cannot be empty strings".into(),
                            ));
                        }
                        out.push(trimmed.to_string());
                    }
                    out.sort();
                    out.dedup();
                    tags_patch = Some(out);
                }
                "links" => {
                    let arr = v.as_array().ok_or_else(|| {
                        AppError::InvalidState("links must be an array".into())
                    })?;
                    let mut out = Vec::with_capacity(arr.len());
                    for entry in arr {
                        let s = entry.as_str().ok_or_else(|| {
                            AppError::InvalidState("each link must be a string".into())
                        })?;
                        let trimmed = s.trim();
                        if trimmed.is_empty() {
                            return Err(AppError::InvalidState(
                                "links cannot be empty strings".into(),
                            ));
                        }
                        out.push(trimmed.to_string());
                    }
                    // Preserve insertion order for links; v1 has no canonical order.
                    links_patch = Some(out);
                }
                "is_archived" | "completed_at" | "archived_at" => {
                    return Err(AppError::InvalidState(format!(
                        "field {} is controlled by complete/archive actions, not update",
                        k
                    )));
                }
                other => {
                    return Err(AppError::InvalidState(format!(
                        "field {} is not editable",
                        other
                    )));
                }
            }
        }

        let tx = conn.transaction()?;

        if !scalar_sql.is_empty() {
            scalar_sql.push(
                "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')".into(),
            );
            let sql = format!(
                "UPDATE tasks SET {} WHERE id = ?",
                scalar_sql.join(", ")
            );
            // Bind the scalar params, then id.
            let mut bound: Vec<rusqlite::types::Value> = scalar_params;
            bound.push(id.to_string().into());
            let params_refs: Vec<&dyn rusqlite::ToSql> =
                bound.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
            tx.execute(&sql, params_refs.as_slice())?;
        }

        if let Some(tags) = &tags_patch {
            tx.execute("DELETE FROM task_tags WHERE task_id = ?1", params![id])?;
            for tag in tags {
                tx.execute(
                    "INSERT INTO task_tags (task_id, tag) VALUES (?1, ?2)",
                    params![id, tag],
                )?;
            }
            // Bump updated_at even when only tags changed, so downstream
            // consumers see a fresh mtime.
            tx.execute(
                "UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
                params![id],
            )?;
        }
        if let Some(links) = &links_patch {
            tx.execute("DELETE FROM task_links WHERE task_id = ?1", params![id])?;
            for url in links {
                tx.execute(
                    "INSERT INTO task_links (task_id, url) VALUES (?1, ?2)",
                    params![id, url],
                )?;
            }
            tx.execute(
                "UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
                params![id],
            )?;
        }

        tx.commit()?;

        let after = load_task_row(&conn, id)?.ok_or_else(|| {
            AppError::InvalidState(format!("task {} disappeared after update", id))
        })?;
        let after_tags = load_tags_for(&conn, id)?;
        let after_links = load_links_for(&conn, id)?;

        // Build a field-level diff. Only changed fields land in the audit row.
        let diff = build_task_diff(
            &before,
            &after,
            &before_tags,
            &after_tags,
            &before_links,
            &after_links,
        );
        if diff.is_empty() {
            return Ok(());
        }
        let detail = serde_json::json!({ "changes": diff }).to_string();

        let atx = audit_conn.transaction()?;
        audit::append(&atx, actor, "task.update", "v1_task", id, &detail)?;
        atx.commit()?;
        Ok(())
    }

    /// Mark a v1 task `done` + archived. Mirrors the v1 CLI semantics
    /// (`bin/db/task-db.js::markDone`): sets status, completed_at, is_archived,
    /// archived_at, updated_at in a single UPDATE so the
    /// `done_must_be_archived` CHECK constraint holds.
    ///
    /// Writes a `task.complete` row to the v2 audit log with the before/after
    /// field snapshot in `detail_json`. The v1 UPDATE and the audit append are
    /// not a single atomic transaction — they're on different databases — so
    /// the v1 write commits first. If the audit write fails after, the v1
    /// change persists unaudited. For a local single-user app this is an
    /// acceptable trade; a two-phase commit is out of scope for M1a.
    pub fn complete_task(
        &self,
        id: &str,
        audit_conn: &mut Connection,
        actor: &str,
    ) -> AppResult<()> {
        if !self.path.exists() {
            return Err(AppError::NotFound(format!(
                "v1 db at {}",
                self.path.display()
            )));
        }
        let conn = self.open_rw()?;

        let before = load_task_row(&conn, id)?.ok_or_else(|| {
            AppError::NotFound(format!("task {}", id))
        })?;

        if before.is_archived {
            return Err(AppError::InvalidState(format!(
                "task {} already archived",
                id
            )));
        }

        let rows = conn.execute(
            r#"
            UPDATE tasks
               SET status = 'done',
                   completed_at = date('now', 'localtime'),
                   is_archived = 1,
                   archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                   updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1
               AND is_archived = 0
            "#,
            params![id],
        )?;
        if rows != 1 {
            // Either the row vanished mid-flight or was archived concurrently.
            return Err(AppError::InvalidState(format!(
                "task {} no longer completable",
                id
            )));
        }

        let after = load_task_row(&conn, id)?.ok_or_else(|| {
            AppError::InvalidState(format!("task {} disappeared after update", id))
        })?;

        let detail = serde_json::json!({
            "before": before.to_json(),
            "after": after.to_json(),
        })
        .to_string();

        let tx = audit_conn.transaction()?;
        audit::append(&tx, actor, "task.complete", "v1_task", id, &detail)?;
        tx.commit()?;
        Ok(())
    }

    /// Reverse a `complete_task` call: status back to 'todo',
    /// is_archived → 0, completed_at + archived_at cleared. Records a
    /// `task.uncomplete` audit row. Used by the inline "Undo" toast
    /// after a fresh complete.
    ///
    /// Conservative: only reopens tasks that ARE currently archived
    /// AND have status='done'. Doesn't reopen tasks the user
    /// explicitly archived without completing — those don't fit the
    /// "I just hit done by mistake" pattern this exists for.
    pub fn uncomplete_task(
        &self,
        id: &str,
        audit_conn: &mut Connection,
        actor: &str,
    ) -> AppResult<()> {
        if !self.path.exists() {
            return Err(AppError::NotFound(format!(
                "v1 db at {}",
                self.path.display()
            )));
        }
        let conn = self.open_rw()?;
        let before = load_task_row(&conn, id)?.ok_or_else(|| {
            AppError::NotFound(format!("task {}", id))
        })?;
        if !before.is_archived || before.status != "done" {
            return Err(AppError::InvalidState(format!(
                "task {} is not in a completed state; nothing to undo",
                id
            )));
        }
        let rows = conn.execute(
            r#"
            UPDATE tasks
               SET status = 'todo',
                   completed_at = NULL,
                   is_archived = 0,
                   archived_at = NULL,
                   updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id = ?1
               AND is_archived = 1
               AND status = 'done'
            "#,
            params![id],
        )?;
        if rows != 1 {
            return Err(AppError::InvalidState(format!(
                "task {} no longer in a state to uncomplete",
                id
            )));
        }
        let after = load_task_row(&conn, id)?.ok_or_else(|| {
            AppError::InvalidState(format!("task {} disappeared after update", id))
        })?;
        let detail = serde_json::json!({
            "before": before.to_json(),
            "after": after.to_json(),
        })
        .to_string();
        let tx = audit_conn.transaction()?;
        audit::append(&tx, actor, "task.uncomplete", "v1_task", id, &detail)?;
        tx.commit()?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct TaskRow {
    id: String,
    title: String,
    status: String,
    priority: String,
    due: Option<String>,
    project: Option<String>,
    notes: Option<String>,
    completed_at: Option<String>,
    is_archived: bool,
    archived_at: Option<String>,
}

impl TaskRow {
    fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "priority": self.priority,
            "due": self.due,
            "project": self.project,
            "notes": self.notes,
            "completed_at": self.completed_at,
            "is_archived": self.is_archived,
            "archived_at": self.archived_at,
        })
    }
}

/// Serde-shape helper for `create_task`: accept a string, empty-string-is-null,
/// or JSON null. Anything else (number, array, object) is a type error.
fn optional_string(
    v: Option<&serde_json::Value>,
    field: &str,
) -> AppResult<Option<String>> {
    match v {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) if s.is_empty() => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(AppError::InvalidState(format!(
            "{} must be a string or null",
            field
        ))),
    }
}

/// Normalize a title into a task id slug. Matches v1 CLI's `slugify`:
/// lowercase, keep [a-z0-9] and spaces/hyphens, collapse runs of whitespace
/// or hyphens to a single hyphen, trim leading/trailing hyphens, cap at 80.
fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_was_sep = false;
    for c in title.chars() {
        let lower = c.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_was_sep = false;
        } else if c == '-' || c.is_whitespace() {
            if !prev_was_sep && !out.is_empty() {
                out.push('-');
                prev_was_sep = true;
            }
        }
        // Drop everything else (punctuation, emoji, etc.) — matches v1.
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() > 80 {
        out.truncate(80);
        while out.ends_with('-') {
            out.pop();
        }
    }
    out
}

/// Generate an unused task id for `title`. Starts from `slug(title)`;
/// on collision suffixes `-2`, `-3`, … Matches v1 `generateId`.
fn generate_id(conn: &Connection, title: &str) -> AppResult<String> {
    let base = slugify(title);
    let base = if base.is_empty() {
        // Degenerate title (all punctuation/emoji) — fall back to a timestamp.
        format!(
            "task-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        )
    } else {
        base
    };

    if !task_id_exists(conn, &base)? {
        return Ok(base);
    }
    let mut suffix: u32 = 2;
    loop {
        let candidate = format!("{}-{}", base, suffix);
        if !task_id_exists(conn, &candidate)? {
            return Ok(candidate);
        }
        suffix = suffix
            .checked_add(1)
            .ok_or_else(|| AppError::InvalidState("id suffix overflow".into()))?;
    }
}

fn task_id_exists(conn: &Connection, id: &str) -> AppResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tasks WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn load_tags_for(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT tag FROM task_tags WHERE task_id = ?1 ORDER BY tag")?;
    let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn load_links_for(conn: &Connection, id: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT url FROM task_links WHERE task_id = ?1")?;
    let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Validate a v1 `due` string. Accepts either `YYYY-MM-DD` (date only)
/// or `YYYY-MM-DD HH:MM` (date + 24h time), matching v1 CLI's
/// `toDueStr` contract. No chrono dep — just structural checks.
fn validate_date(s: &str) -> AppResult<()> {
    let err = |msg: &str| {
        AppError::InvalidState(format!(
            "due '{}' {}: expected YYYY-MM-DD or YYYY-MM-DD HH:MM",
            s, msg
        ))
    };
    let b = s.as_bytes();
    if s.len() != 10 && s.len() != 16 {
        return Err(err("wrong length"));
    }
    if b[4] != b'-' || b[7] != b'-' {
        return Err(err("missing date dashes"));
    }
    for i in [0, 1, 2, 3, 5, 6, 8, 9] {
        if !b[i].is_ascii_digit() {
            return Err(err("non-digit in date"));
        }
    }
    let month: u32 = s[5..7].parse().unwrap();
    let day: u32 = s[8..10].parse().unwrap();
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(err("date out of range"));
    }
    if s.len() == 16 {
        if b[10] != b' ' || b[13] != b':' {
            return Err(err("expected ' HH:MM' suffix"));
        }
        for i in [11, 12, 14, 15] {
            if !b[i].is_ascii_digit() {
                return Err(err("non-digit in time"));
            }
        }
        let hour: u32 = s[11..13].parse().unwrap();
        let minute: u32 = s[14..16].parse().unwrap();
        if hour > 23 || minute > 59 {
            return Err(err("time out of range"));
        }
    }
    Ok(())
}

fn build_task_diff(
    before: &TaskRow,
    after: &TaskRow,
    before_tags: &[String],
    after_tags: &[String],
    before_links: &[String],
    after_links: &[String],
) -> serde_json::Map<String, serde_json::Value> {
    let mut diff = serde_json::Map::new();

    fn pair<T: PartialEq + serde::Serialize>(
        diff: &mut serde_json::Map<String, serde_json::Value>,
        name: &str,
        before: &T,
        after: &T,
    ) {
        if before != after {
            diff.insert(
                name.to_string(),
                serde_json::json!({
                    "before": before,
                    "after": after,
                }),
            );
        }
    }

    pair(&mut diff, "title", &before.title, &after.title);
    pair(&mut diff, "status", &before.status, &after.status);
    pair(&mut diff, "priority", &before.priority, &after.priority);
    pair(&mut diff, "due", &before.due, &after.due);
    pair(&mut diff, "project", &before.project, &after.project);
    pair(&mut diff, "notes", &before.notes, &after.notes);
    if before_tags != after_tags {
        diff.insert(
            "tags".to_string(),
            serde_json::json!({
                "before": before_tags,
                "after": after_tags,
            }),
        );
    }
    if before_links != after_links {
        diff.insert(
            "links".to_string(),
            serde_json::json!({
                "before": before_links,
                "after": after_links,
            }),
        );
    }
    diff
}

fn load_task_row(conn: &Connection, id: &str) -> AppResult<Option<TaskRow>> {
    let result = conn.query_row(
        r#"
        SELECT id, title, status, priority, due, project, notes,
               completed_at, is_archived, archived_at
        FROM tasks
        WHERE id = ?1
        "#,
        params![id],
        |r| {
            Ok(TaskRow {
                id: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                priority: r.get(3)?,
                due: r.get(4)?,
                project: r.get(5)?,
                notes: r.get(6)?,
                completed_at: r.get(7)?,
                is_archived: r.get::<_, i64>(8)? != 0,
                archived_at: r.get(9)?,
            })
        },
    );
    match result {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn load_tags(conn: &Connection) -> AppResult<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare("SELECT task_id, tag FROM task_tags ORDER BY tag")?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok::<(String, String), rusqlite::Error>((r.get(0)?, r.get(1)?))
    })?;
    for row in rows {
        let (id, tag) = row?;
        map.entry(id).or_default().push(tag);
    }
    Ok(map)
}

fn load_links(conn: &Connection) -> AppResult<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare("SELECT task_id, url FROM task_links")?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok::<(String, String), rusqlite::Error>((r.get(0)?, r.get(1)?))
    })?;
    for row in rows {
        let (id, url) = row?;
        map.entry(id).or_default().push(url);
    }
    Ok(map)
}

/// Runtime resolution: the task DB lives at `<content_root>/../cos.db`
/// — i.e. `data/cos.db` relative to the user's chosen data folder
/// (whose `data/files/` is the content root). This pairs the
/// task DB and the markdown tree so they always travel together.
///
/// Layered like `content::resolve_root_with_data_dir`:
///   1. `$COS_V1_DB` if set — explicit override wins
///   2. `<content_root>/../cos.db` if it exists or its parent is
///      writable — co-located with the markdown tree
///   3. Walk up from cwd looking for `data/cos.db` — dev workflow
///   4. Fallback to `<content_root>/../cos.db` (created on demand)
pub fn resolve_path_with_content_root(content_root: &Path) -> PathBuf {
    if let Ok(explicit) = std::env::var("COS_V1_DB") {
        return PathBuf::from(explicit);
    }
    // The content root is `<data-dir>/files/`; its parent is
    // `<data-dir>/`, where the SQLite DB lives.
    if let Some(data_dir) = content_root.parent() {
        let coloc = data_dir.join("cos.db");
        if coloc.exists() {
            return coloc;
        }
        // dev fallback: walk up from cwd, in case the user is
        // running from a repo checkout but the colocated path
        // doesn't exist yet (a fresh clone).
        if let Ok(cwd) = std::env::current_dir() {
            let mut dir: Option<&Path> = Some(&cwd);
            while let Some(d) = dir {
                let candidate = d.join("data").join("cos.db");
                if candidate.exists() {
                    return candidate;
                }
                dir = d.parent();
            }
        }
        return coloc;
    }
    PathBuf::from("data/cos.db")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Minimal slice of the v1 schema that `complete_task` touches.
    /// Intentionally NOT `CREATE TABLE IF NOT EXISTS …` so a test that seeds
    /// twice would fail loudly rather than silently skip.
    const V1_TASKS_DDL: &str = r#"
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'todo',
            priority TEXT NOT NULL DEFAULT 'medium',
            due DATE,
            project TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_archived BOOLEAN NOT NULL DEFAULT 0,
            completed_at DATE,
            archived_at DATETIME,
            CONSTRAINT valid_status CHECK (status IN ('todo', 'in-progress', 'done')),
            CONSTRAINT valid_priority CHECK (priority IN ('high', 'medium', 'low')),
            CONSTRAINT done_must_be_archived CHECK (NOT (status = 'done' AND is_archived = 0))
        );
        CREATE TABLE task_tags (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            tag TEXT NOT NULL,
            PRIMARY KEY (task_id, tag)
        );
        CREATE TABLE task_links (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            PRIMARY KEY (task_id, url)
        );
    "#;

    fn seed_v1_db(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(V1_TASKS_DDL).unwrap();
        conn.execute(
            r#"INSERT INTO tasks (id, title, status, priority)
               VALUES ('t1', 'Write M1a', 'todo', 'high')"#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO tasks (id, title, status, priority, is_archived,
                                  completed_at, archived_at)
               VALUES ('t2', 'Already done', 'done', 'medium', 1,
                       '2026-04-20', '2026-04-20T10:00:00.000Z')"#,
            [],
        )
        .unwrap();
    }

    fn open_audit_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::Db::init_schema_for_test(&conn).unwrap();
        conn
    }

    #[test]
    fn complete_task_marks_done_and_archives() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path.clone());
        let mut audit_db = open_audit_db();

        tasks.complete_task("t1", &mut audit_db, "local").unwrap();

        // v1 row now satisfies done_must_be_archived in both senses.
        let row = load_task_row(&Connection::open(&v1_path).unwrap(), "t1")
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "done");
        assert!(row.is_archived);
        assert!(row.completed_at.is_some());
        assert!(row.archived_at.is_some());

        // Active list no longer includes t1.
        let active = tasks.list_active().unwrap();
        assert!(active.iter().all(|t| t.id != "t1"));

        // Audit row recorded with before/after snapshots.
        let audit_rows = crate::audit::recent(&audit_db, 10).unwrap();
        assert_eq!(audit_rows.len(), 1);
        assert_eq!(audit_rows[0].action, "task.complete");
        assert_eq!(audit_rows[0].target_kind, "v1_task");
        assert_eq!(audit_rows[0].target_id, "t1");
        let detail: serde_json::Value =
            serde_json::from_str(&audit_rows[0].detail_json).unwrap();
        assert_eq!(detail["before"]["status"], "todo");
        assert_eq!(detail["before"]["is_archived"], false);
        assert_eq!(detail["after"]["status"], "done");
        assert_eq!(detail["after"]["is_archived"], true);

        // Chain still verifies.
        assert_eq!(crate::audit::verify_chain(&audit_db).unwrap(), None);
    }

    #[test]
    fn uncomplete_task_round_trips_through_complete() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path.clone());
        let mut audit_db = open_audit_db();

        tasks.complete_task("t1", &mut audit_db, "local").unwrap();
        tasks.uncomplete_task("t1", &mut audit_db, "local").unwrap();

        let row = load_task_row(&Connection::open(&v1_path).unwrap(), "t1")
            .unwrap()
            .unwrap();
        assert_eq!(row.status, "todo", "status reverted to todo");
        assert!(!row.is_archived, "no longer archived");
        assert!(row.completed_at.is_none(), "completed_at cleared");
        assert!(row.archived_at.is_none(), "archived_at cleared");

        // Both audit rows present (complete + uncomplete) with
        // matching before/after snapshots so the chain reads as a
        // round trip.
        let audit_rows = crate::audit::recent(&audit_db, 10).unwrap();
        assert_eq!(audit_rows.len(), 2);
        // Most-recent first.
        assert_eq!(audit_rows[0].action, "task.uncomplete");
        assert_eq!(audit_rows[1].action, "task.complete");

        let detail: serde_json::Value =
            serde_json::from_str(&audit_rows[0].detail_json).unwrap();
        assert_eq!(detail["before"]["status"], "done");
        assert_eq!(detail["before"]["is_archived"], true);
        assert_eq!(detail["after"]["status"], "todo");
        assert_eq!(detail["after"]["is_archived"], false);

        // Chain still intact.
        assert_eq!(crate::audit::verify_chain(&audit_db).unwrap(), None);

        // Active list contains t1 again.
        let active = tasks.list_active().unwrap();
        assert!(active.iter().any(|t| t.id == "t1"));
    }

    #[test]
    fn uncomplete_task_rejects_active_task() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        // t1 is currently active (todo) per the seed. Trying to
        // uncomplete it is a no-op error.
        let err =
            tasks.uncomplete_task("t1", &mut audit_db, "local").unwrap_err();
        assert!(matches!(err, AppError::InvalidState(_)));
        assert_eq!(crate::audit::recent(&audit_db, 10).unwrap().len(), 0);
    }

    #[test]
    fn uncomplete_task_rejects_missing_id() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();
        let err = tasks
            .uncomplete_task("nope", &mut audit_db, "local")
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn complete_task_rejects_missing_id() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let err = tasks
            .complete_task("nope", &mut audit_db, "local")
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        // No audit churn on failed mutations.
        assert_eq!(crate::audit::recent(&audit_db, 10).unwrap().len(), 0);
    }

    #[test]
    fn complete_task_rejects_already_archived() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let err = tasks
            .complete_task("t2", &mut audit_db, "local")
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidState(_)));
        assert_eq!(crate::audit::recent(&audit_db, 10).unwrap().len(), 0);
    }

    #[test]
    fn complete_task_errors_when_db_missing() {
        let tmp = TempDir::new().unwrap();
        let tasks = V1Tasks::new(tmp.path().join("does-not-exist.db"));
        let mut audit_db = open_audit_db();
        let err = tasks
            .complete_task("t1", &mut audit_db, "local")
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // --- M1b: update_task ---

    fn audit_details(db: &Connection) -> Vec<(String, serde_json::Value)> {
        crate::audit::recent(db, 20)
            .unwrap()
            .into_iter()
            .map(|r| (r.action, serde_json::from_str(&r.detail_json).unwrap()))
            .collect()
    }

    #[test]
    fn update_task_changes_scalar_fields_and_audits_diff() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path.clone());
        let mut audit_db = open_audit_db();

        let patch = serde_json::json!({
            "title": "Write M1a — edit polish",
            "priority": "medium",
            "due": "2026-05-01",
            "notes": "drafted in side panel",
        });
        tasks
            .update_task("t1", &patch, &mut audit_db, "local")
            .unwrap();

        let got = tasks.get_task("t1").unwrap().unwrap();
        assert_eq!(got.title, "Write M1a — edit polish");
        assert_eq!(got.priority, "medium");
        assert_eq!(got.due.as_deref(), Some("2026-05-01"));
        assert_eq!(got.notes.as_deref(), Some("drafted in side panel"));

        let entries = audit_details(&audit_db);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "task.update");
        let changes = &entries[0].1["changes"];
        assert_eq!(changes["title"]["before"], "Write M1a");
        assert_eq!(changes["title"]["after"], "Write M1a — edit polish");
        assert_eq!(changes["priority"]["before"], "high");
        assert_eq!(changes["priority"]["after"], "medium");
        assert_eq!(changes["due"]["before"], serde_json::Value::Null);
        assert_eq!(changes["due"]["after"], "2026-05-01");
        assert_eq!(changes["notes"]["before"], serde_json::Value::Null);
        assert_eq!(changes["notes"]["after"], "drafted in side panel");
        assert_eq!(crate::audit::verify_chain(&audit_db).unwrap(), None);
    }

    #[test]
    fn update_task_replaces_tags_wholesale() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        {
            let conn = Connection::open(&v1_path).unwrap();
            conn.execute(
                "INSERT INTO task_tags (task_id, tag) VALUES ('t1', 'work'), ('t1', 'admin')",
                [],
            )
            .unwrap();
        }
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let patch = serde_json::json!({ "tags": ["work", "prep", "prep"] });
        tasks
            .update_task("t1", &patch, &mut audit_db, "local")
            .unwrap();

        let got = tasks.get_task("t1").unwrap().unwrap();
        assert_eq!(got.tags, vec!["prep".to_string(), "work".to_string()]);

        let entries = audit_details(&audit_db);
        assert_eq!(entries.len(), 1);
        let changes = &entries[0].1["changes"];
        assert_eq!(
            changes["tags"]["before"],
            serde_json::json!(["admin", "work"])
        );
        assert_eq!(
            changes["tags"]["after"],
            serde_json::json!(["prep", "work"])
        );
    }

    #[test]
    fn update_task_clears_nullable_fields_on_null() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        {
            let conn = Connection::open(&v1_path).unwrap();
            conn.execute(
                "UPDATE tasks SET due = '2026-05-01', notes = 'hello', project = 'cos' WHERE id = 't1'",
                [],
            )
            .unwrap();
        }
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let patch = serde_json::json!({ "due": null, "notes": "", "project": null });
        tasks
            .update_task("t1", &patch, &mut audit_db, "local")
            .unwrap();

        let got = tasks.get_task("t1").unwrap().unwrap();
        assert!(got.due.is_none());
        assert!(got.notes.is_none());
        assert!(got.project.is_none());
    }

    #[test]
    fn update_task_noop_writes_no_audit_row() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        // Every field set to its current value → empty diff.
        let patch = serde_json::json!({
            "title": "Write M1a",
            "priority": "high",
            "status": "todo",
        });
        tasks
            .update_task("t1", &patch, &mut audit_db, "local")
            .unwrap();
        assert_eq!(crate::audit::recent(&audit_db, 10).unwrap().len(), 0);
    }

    #[test]
    fn update_task_rejects_forbidden_fields() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let bad = [
            serde_json::json!({ "is_archived": true }),
            serde_json::json!({ "completed_at": "2026-04-24" }),
            serde_json::json!({ "archived_at": "2026-04-24T00:00:00Z" }),
            serde_json::json!({ "id": "other" }),
            serde_json::json!({ "status": "done" }),
            serde_json::json!({ "priority": "urgent" }),
            serde_json::json!({ "due": "bad-date" }),
            serde_json::json!({ "title": "" }),
        ];
        for patch in &bad {
            let err = tasks
                .update_task("t1", patch, &mut audit_db, "local")
                .unwrap_err();
            assert!(
                matches!(err, AppError::InvalidState(_)),
                "expected InvalidState for patch {:?}, got {:?}",
                patch,
                err
            );
        }
        assert_eq!(crate::audit::recent(&audit_db, 10).unwrap().len(), 0);
    }

    #[test]
    fn update_task_rejects_archived() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let err = tasks
            .update_task(
                "t2",
                &serde_json::json!({ "title": "tamper" }),
                &mut audit_db,
                "local",
            )
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidState(_)));
    }

    #[test]
    fn update_task_rejects_missing_id() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let err = tasks
            .update_task(
                "ghost",
                &serde_json::json!({ "title": "x" }),
                &mut audit_db,
                "local",
            )
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    // --- M1c: create_task ---

    #[test]
    fn create_task_with_only_title_inserts_sensible_defaults() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let fresh = tasks
            .create_task(
                &serde_json::json!({ "title": "Ship M1c" }),
                &mut audit_db,
                "local",
            )
            .unwrap();

        assert_eq!(fresh.id, "ship-m1c");
        assert_eq!(fresh.title, "Ship M1c");
        assert_eq!(fresh.priority, "medium");
        assert_eq!(fresh.status, "todo");
        assert!(fresh.due.is_none());
        assert!(fresh.project.is_none());
        assert!(fresh.notes.is_none());
        assert!(fresh.tags.is_empty());
        assert!(fresh.links.is_empty());

        // Appears in active list.
        let active = tasks.list_active().unwrap();
        assert!(active.iter().any(|t| t.id == "ship-m1c"));

        // Audit row landed.
        let rows = crate::audit::recent(&audit_db, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "task.create");
        assert_eq!(rows[0].target_id, "ship-m1c");
        assert_eq!(crate::audit::verify_chain(&audit_db).unwrap(), None);
    }

    #[test]
    fn create_task_with_full_input_persists_every_field() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let fresh = tasks
            .create_task(
                &serde_json::json!({
                    "title": "Prep 1:1",
                    "priority": "high",
                    "due": "2026-05-01 09:00",
                    "project": "cos-v2",
                    "notes": "look at M4 surface",
                    "tags": ["work", "prep", "prep"],
                    "links": ["https://example.com/a"],
                }),
                &mut audit_db,
                "local",
            )
            .unwrap();

        assert_eq!(fresh.id, "prep-11");
        assert_eq!(fresh.priority, "high");
        assert_eq!(fresh.due.as_deref(), Some("2026-05-01 09:00"));
        assert_eq!(fresh.project.as_deref(), Some("cos-v2"));
        assert_eq!(fresh.notes.as_deref(), Some("look at M4 surface"));
        assert_eq!(fresh.tags, vec!["prep".to_string(), "work".to_string()]);
        assert_eq!(fresh.links, vec!["https://example.com/a".to_string()]);
    }

    #[test]
    fn create_task_colliding_titles_suffix_the_id() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let a = tasks
            .create_task(
                &serde_json::json!({ "title": "Check CI" }),
                &mut audit_db,
                "local",
            )
            .unwrap();
        let b = tasks
            .create_task(
                &serde_json::json!({ "title": "Check CI" }),
                &mut audit_db,
                "local",
            )
            .unwrap();
        let c = tasks
            .create_task(
                &serde_json::json!({ "title": "Check CI" }),
                &mut audit_db,
                "local",
            )
            .unwrap();

        assert_eq!(a.id, "check-ci");
        assert_eq!(b.id, "check-ci-2");
        assert_eq!(c.id, "check-ci-3");
    }

    #[test]
    fn create_task_rejects_invalid_input() {
        let tmp = TempDir::new().unwrap();
        let v1_path = tmp.path().join("cos.db");
        seed_v1_db(&v1_path);
        let tasks = V1Tasks::new(v1_path);
        let mut audit_db = open_audit_db();

        let bad = [
            serde_json::json!({}),
            serde_json::json!({ "title": "   " }),
            serde_json::json!({ "title": "ok", "priority": "urgent" }),
            serde_json::json!({ "title": "ok", "due": "nope" }),
            serde_json::json!({ "title": "ok", "tags": ["", "work"] }),
            serde_json::json!({ "title": "ok", "tags": [1, 2, 3] }),
            serde_json::json!({ "title": "ok", "project": 5 }),
        ];
        for input in &bad {
            let err = tasks
                .create_task(input, &mut audit_db, "local")
                .unwrap_err();
            assert!(
                matches!(err, AppError::InvalidState(_)),
                "expected InvalidState for input {:?}, got {:?}",
                input,
                err
            );
        }
        // Nothing landed in the audit log — every attempt was rejected
        // before the INSERT txn opened.
        assert_eq!(crate::audit::recent(&audit_db, 10).unwrap().len(), 0);
    }

    #[test]
    fn slugify_matches_v1_rules() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("Prep 1:1"), "prep-11");
        assert_eq!(slugify("  spaced   out  "), "spaced-out");
        assert_eq!(slugify("already-dashed—em-dash"), "already-dashedem-dash");
        assert_eq!(slugify("M1a, the first checkpoint!"), "m1a-the-first-checkpoint");
        assert_eq!(slugify("✨ emoji-only ✨").is_empty(), false);
        assert_eq!(slugify("✨"), "");
        // Truncation + trailing-hyphen cleanup.
        let long = "a".repeat(85);
        let s = slugify(&long);
        assert!(s.len() <= 80);
    }

    #[test]
    fn validate_date_accepts_iso_and_rejects_garbage() {
        assert!(validate_date("2026-04-24").is_ok());
        assert!(validate_date("2026-12-31").is_ok());
        assert!(validate_date("2026-04-24 09:30").is_ok());
        assert!(validate_date("2026-04-24 23:59").is_ok());
        assert!(validate_date("2026-04-24 00:00").is_ok());
        assert!(validate_date("2026-13-01").is_err());
        assert!(validate_date("2026-00-10").is_err());
        assert!(validate_date("2026-04-32").is_err());
        assert!(validate_date("2026/04/24").is_err());
        assert!(validate_date("26-04-24").is_err());
        assert!(validate_date("2026-04-24T09:30").is_err()); // T separator not accepted
        assert!(validate_date("2026-04-24 24:00").is_err()); // hour out of range
        assert!(validate_date("2026-04-24 09:60").is_err()); // minute out of range
        assert!(validate_date("2026-04-24 9:00").is_err()); // unpadded hour
        assert!(validate_date("").is_err());
    }

    #[test]
    fn resolve_with_content_root_colocates_with_content() {
        let dir = TempDir::new().unwrap();
        // <data_dir>/files is the content root (matches the
        // `Content::resolve_root_with_data_dir` shape).
        let content_root = dir.path().join("files");
        std::fs::create_dir_all(&content_root).unwrap();
        // Seed an existing DB next to the content tree.
        let expected = dir.path().join("cos.db");
        std::fs::write(&expected, []).unwrap();
        // Make sure neither the env override nor the cwd walk
        // intercepts.
        let prev_env = std::env::var("COS_V1_DB").ok();
        std::env::remove_var("COS_V1_DB");
        let prev_cwd = std::env::current_dir().unwrap();
        let pwd = TempDir::new().unwrap();
        std::env::set_current_dir(pwd.path()).unwrap();

        let resolved = resolve_path_with_content_root(&content_root);

        std::env::set_current_dir(prev_cwd).unwrap();
        if let Some(v) = prev_env {
            std::env::set_var("COS_V1_DB", v);
        }
        assert_eq!(resolved, expected);
    }

    #[test]
    fn resolve_with_content_root_falls_back_to_colocated_when_missing() {
        let dir = TempDir::new().unwrap();
        let content_root = dir.path().join("files");
        std::fs::create_dir_all(&content_root).unwrap();
        // No cos.db exists yet.
        let prev_env = std::env::var("COS_V1_DB").ok();
        std::env::remove_var("COS_V1_DB");
        // Run from a cwd that won't find a sibling cos.db.
        let prev_cwd = std::env::current_dir().unwrap();
        let pwd = TempDir::new().unwrap();
        std::env::set_current_dir(pwd.path()).unwrap();

        let resolved = resolve_path_with_content_root(&content_root);

        std::env::set_current_dir(prev_cwd).unwrap();
        if let Some(v) = prev_env {
            std::env::set_var("COS_V1_DB", v);
        }
        // The fallback is the colocated path — exists or not, the
        // app should land here so it can create the DB on first use.
        assert_eq!(resolved, dir.path().join("cos.db"));
    }

    #[test]
    fn resolve_with_content_root_env_overrides_everything() {
        let dir = TempDir::new().unwrap();
        let content_root = dir.path().join("files");
        std::fs::create_dir_all(&content_root).unwrap();
        let override_path = dir.path().join("custom.db");
        let prev_env = std::env::var("COS_V1_DB").ok();
        std::env::set_var(
            "COS_V1_DB",
            override_path.to_string_lossy().to_string(),
        );

        let resolved = resolve_path_with_content_root(&content_root);

        if let Some(v) = prev_env {
            std::env::set_var("COS_V1_DB", v);
        } else {
            std::env::remove_var("COS_V1_DB");
        }
        assert_eq!(resolved, override_path);
    }
}
