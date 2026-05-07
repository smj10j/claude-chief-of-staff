mod annotations;
mod audit;
mod automation;
mod calendar;
mod chat;
mod claude;
mod console;
mod content;
mod diskhealth;
mod github;
mod install;
mod local_network;
mod paging;
mod perf;
mod db;
mod error;
mod org;
mod plugins;
mod profile;
mod secrets;
mod snapshots;
mod v1_tasks;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Manager, State};

use crate::audit::AuditRow;
use crate::content::{
    AttentionPerson, Content, ContentStatus, DocFile, MeetingRef, PersonProfile, PersonRef,
    PriorityItem, ProjectFile, ProjectRef, ProjectStatusInfo, RestoreOutcome, SaveResult,
    SearchHit, SessionMeta, SessionRef,
};
use crate::db::{Db, PingResult};
use crate::error::{AppError, AppResult};
use crate::snapshots::BlobStore;
use crate::v1_tasks::{V1Status, V1Task, V1Tasks};

struct AppState {
    db: Arc<Mutex<Db>>,
    v1_tasks: V1Tasks,
    content: Content,
    blobs: BlobStore,
    perf_log: perf::PerfLog,
    plugins: plugins::Plugins,
    app_data_dir: std::path::PathBuf,
    local_net_handle: Arc<Mutex<Option<local_network::ServerHandle>>>,
    /// PRD-116 Console — single Manager owns all live PTY sessions.
    /// Wrapped in Arc so the per-command spawn_blocking task can
    /// hold a reference without borrowing the State guard.
    console: Arc<console::Manager>,
    /// PRD-116 Phase 2.5 Chat — same pattern as `console`, but for
    /// stream-json mode sessions. Separate manager so a chat-mode
    /// handle can never collide with a raw-mode handle.
    chat: Arc<chat::Manager>,
}

/// Personal attribution baked into the binary at compile time. Anyone
/// running `strings` on the binary will see this string; the About
/// dialog also displays it; `codesign -dv` shows the matching name as
/// the signing authority on properly signed builds.
pub const BUILT_BY: &str = "User";
pub const BUILT_WITH: &str = "Claude Code";

#[derive(Serialize)]
struct BackendInfo {
    version: String,
    db_path: String,
    /// Human-readable attribution for the build. Surfaced in the
    /// Settings → General → About card. Stable across rebuilds; if
    /// it ever changes, every binary you've ever produced becomes a
    /// different "Chief of Staff" to macOS Keychain.
    built_by: String,
    built_with: String,
}

#[tauri::command]
fn backend_version(state: State<'_, AppState>) -> AppResult<BackendInfo> {
    let db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    Ok(BackendInfo {
        version: format!("cos-app v{}", env!("CARGO_PKG_VERSION")),
        db_path: db.path.display().to_string(),
        built_by: BUILT_BY.into(),
        built_with: BUILT_WITH.into(),
    })
}

#[tauri::command]
fn db_ping(state: State<'_, AppState>) -> AppResult<PingResult> {
    let db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    db.ping()
}

#[tauri::command]
fn secret_set(account: String, value: String) -> AppResult<()> {
    secrets::set(&account, &value)
}

#[tauri::command]
fn secret_get(account: String) -> AppResult<Option<String>> {
    secrets::get(&account)
}

#[tauri::command]
fn secret_delete(account: String) -> AppResult<()> {
    secrets::delete(&account)
}

#[derive(Serialize)]
struct DbEncryptionStatus {
    /// True when a 256-bit key exists in Keychain.
    key_present: bool,
    /// True when the running build links against SQLCipher (the
    /// `bundled-sqlcipher-vendored-openssl` rusqlite feature, on by
    /// default since M8).
    sqlcipher_linked: bool,
    /// True when both the build links SQLCipher AND the live `cos.db`
    /// file passes the SQLCipher header check. The Db::open path
    /// migrates plaintext files automatically, so once a v2 app has
    /// run successfully this is true.
    encrypted: bool,
    /// True if a recovery phrase has been generated and confirmed by
    /// the user. M8b gates sensitive features on this — without a
    /// confirmed phrase, a wiped Keychain means data loss.
    recovery_confirmed: bool,
}

#[tauri::command]
fn db_encryption_status(state: State<'_, AppState>) -> AppResult<DbEncryptionStatus> {
    let key_present = secrets::has_db_encryption_key()?;
    let sqlcipher_linked = cfg!(feature = "sqlcipher_linked");
    let db_path = state.app_data_dir.join("cos.db");
    let encrypted = sqlcipher_linked && db_path.exists() && !is_plaintext_header(&db_path);
    let recovery_confirmed = secrets::has_recovery_confirmed()?;
    Ok(DbEncryptionStatus {
        key_present,
        sqlcipher_linked,
        encrypted,
        recovery_confirmed,
    })
}

/// Cheap on-disk check — encrypted SQLCipher files do not start with
/// the standard "SQLite format 3\0" magic.
fn is_plaintext_header(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut header = [0u8; 16];
    if f.read_exact(&mut header).is_err() {
        return false;
    }
    &header == b"SQLite format 3\0"
}

/// Generate (if missing) + return the database encryption key. The
/// frontend never sees the raw key — this IPC only confirms a key
/// exists. Calling it is idempotent: subsequent calls return the
/// already-stored key.
#[tauri::command]
fn db_encryption_key_ensure(_state: State<'_, AppState>) -> AppResult<bool> {
    let _ = secrets::ensure_db_encryption_key()?;
    Ok(true)
}

#[derive(Serialize)]
struct RecoveryStatus {
    /// Wrapped recovery blob exists in Keychain (i.e., a phrase has
    /// been generated at some point).
    wrapped_present: bool,
    /// User has confirmed they captured the phrase by re-typing the
    /// challenge words.
    confirmed: bool,
}

#[tauri::command]
fn recovery_status() -> AppResult<RecoveryStatus> {
    Ok(RecoveryStatus {
        wrapped_present: secrets::has_recovery_wrapped()?,
        confirmed: secrets::has_recovery_confirmed()?,
    })
}

/// Generate a fresh 24-word recovery phrase and wrap the workspace
/// key under it. Returns the phrase to the frontend for one-time
/// display. The frontend MUST drop the phrase from React state once
/// the wizard advances. Errors if a phrase already exists — call
/// `recovery_reset` first to rotate.
#[tauri::command]
fn recovery_create_phrase() -> AppResult<String> {
    secrets::create_recovery_phrase()
}

/// Cheap syntactic check — does this string parse as a valid 24-word
/// BIP-39 phrase (correct words from the wordlist + valid checksum)?
/// Used by the wizard's import step to give immediate feedback before
/// firing the full decrypt path.
#[tauri::command]
fn recovery_validate_phrase(phrase: String) -> AppResult<bool> {
    Ok(secrets::phrase_is_valid_bip39(&phrase))
}

/// Mark that the user has shown they captured the phrase. Wizard
/// calls this after the user re-types the challenge words. Until
/// this is set, the install wizard's "skip" button is disabled on
/// the recovery step.
#[tauri::command]
fn recovery_mark_confirmed() -> AppResult<()> {
    secrets::mark_recovery_confirmed()
}

/// Import flow — caller provides the 24-word phrase; we decrypt the
/// wrapped blob in Keychain and re-store the workspace key. After
/// this succeeds, the next `Db::open` will unlock the encrypted DB.
/// Errors if the phrase is wrong or the wrapped blob is missing.
#[tauri::command]
fn recovery_import_phrase(phrase: String) -> AppResult<()> {
    secrets::recover_workspace_key_from_phrase(&phrase)?;
    Ok(())
}

/// Wipe the recovery state so a fresh phrase can be generated. Used
/// for "rotate phrase" in Settings → Security. Does NOT touch the
/// workspace key itself — the encrypted DB stays readable through
/// Keychain. Re-call `recovery_create_phrase` after this.
#[tauri::command]
fn recovery_reset() -> AppResult<()> {
    secrets::forget_recovery()
}

/// Disk health snapshot — audit row count, blob store size, oldest
/// restorable doc.write, content tree size. Pure inventory; safe to
/// call any time.
#[tauri::command]
fn disk_health(state: State<'_, AppState>) -> AppResult<diskhealth::DiskHealth> {
    let db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    let audit_db_path = state.app_data_dir.join("cos.db");
    let blob_root = state.app_data_dir.join("snapshots");
    let content_root = state.content.root().to_path_buf();
    diskhealth::snapshot(&db.conn, &audit_db_path, &blob_root, &content_root)
}

#[tauri::command]
fn v1_tasks_status(state: State<'_, AppState>) -> V1Status {
    state.v1_tasks.status()
}

#[tauri::command]
fn v1_tasks_list(state: State<'_, AppState>) -> AppResult<Vec<V1Task>> {
    state.v1_tasks.list_active()
}

#[tauri::command]
fn v1_tasks_complete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    state.v1_tasks.complete_task(&id, &mut db.conn, "local")
}

#[tauri::command]
fn v1_tasks_uncomplete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    state.v1_tasks.uncomplete_task(&id, &mut db.conn, "local")
}

#[tauri::command]
fn v1_tasks_get(state: State<'_, AppState>, id: String) -> AppResult<Option<V1Task>> {
    state.v1_tasks.get_task(&id)
}

#[tauri::command]
fn v1_tasks_update(
    state: State<'_, AppState>,
    id: String,
    patch: serde_json::Value,
) -> AppResult<V1Task> {
    let mut db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    state
        .v1_tasks
        .update_task(&id, &patch, &mut db.conn, "local")?;
    state
        .v1_tasks
        .get_task(&id)?
        .ok_or_else(|| AppError::NotFound(format!("task {}", id)))
}

#[tauri::command]
fn v1_tasks_create(
    state: State<'_, AppState>,
    input: serde_json::Value,
) -> AppResult<V1Task> {
    let mut db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    state.v1_tasks.create_task(&input, &mut db.conn, "local")
}

#[tauri::command]
fn claude_status(state: State<'_, AppState>) -> AppResult<claude::ClaudeCliStatus> {
    let cfg = claude::load_config(&state.app_data_dir)?;
    Ok(claude::ClaudeCliStatus::compute(&state.app_data_dir, &cfg))
}

#[tauri::command]
fn claude_config_get(state: State<'_, AppState>) -> AppResult<claude::ClaudeCliConfig> {
    claude::load_config(&state.app_data_dir)
}

#[tauri::command]
fn claude_config_set(
    state: State<'_, AppState>,
    config: claude::ClaudeCliConfig,
) -> AppResult<claude::ClaudeCliStatus> {
    // Keep "at least one arg" as a soft invariant — an empty extra_args would
    // make the CLI run in interactive mode, which has no chance of working
    // inside a subprocess.
    let mut cfg = config;
    if cfg.extra_args.is_empty() {
        cfg.extra_args = claude::default_extra_args();
    }
    claude::save_config(&state.app_data_dir, &cfg)?;
    Ok(claude::ClaudeCliStatus::compute(&state.app_data_dir, &cfg))
}

#[tauri::command]
fn claude_config_reset(state: State<'_, AppState>) -> AppResult<claude::ClaudeCliStatus> {
    let cfg = claude::ClaudeCliConfig::default();
    claude::save_config(&state.app_data_dir, &cfg)?;
    Ok(claude::ClaudeCliStatus::compute(&state.app_data_dir, &cfg))
}

// ====== Calendar (ICS subscription) ======

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct CalendarConfig {
    /// ICS subscription URL (Google Calendar, Outlook, etc.) or local file
    /// path / `file://` URL during development.
    #[serde(default)]
    ics_url: String,
    /// "ics" (default) or "eventkit". When "eventkit" we shell out to
    /// bin/calendar/eventkit.sh; if that fails (no permission, no Swift
    /// toolchain), the handler falls back to ICS so the user is never
    /// stuck. Frontend exposes the choice as a radio.
    #[serde(default = "default_transport")]
    transport: String,
}

fn default_transport() -> String {
    // EventKit is the default on macOS because it sidesteps Google
    // Calendar's "Secret address" lookup (which Workspace admins
    // sometimes hide) and pulls full event details from Calendar.app.
    // ICS stays as an explicit fallback the user can pick.
    "eventkit".into()
}

fn calendar_config_path(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    app_data_dir.join("calendar.json")
}

fn load_calendar_config(app_data_dir: &std::path::Path) -> AppResult<CalendarConfig> {
    let path = calendar_config_path(app_data_dir);
    if !path.exists() {
        return Ok(CalendarConfig::default());
    }
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidState(format!("calendar.json: {e}")))
}

fn save_calendar_config(
    app_data_dir: &std::path::Path,
    cfg: &CalendarConfig,
) -> AppResult<()> {
    std::fs::create_dir_all(app_data_dir)?;
    std::fs::write(
        calendar_config_path(app_data_dir),
        serde_json::to_string_pretty(cfg)?,
    )?;
    Ok(())
}

#[tauri::command]
fn calendar_config_get(state: State<'_, AppState>) -> AppResult<CalendarConfig> {
    load_calendar_config(&state.app_data_dir)
}

#[tauri::command]
fn calendar_config_set(
    state: State<'_, AppState>,
    config: CalendarConfig,
) -> AppResult<CalendarConfig> {
    save_calendar_config(&state.app_data_dir, &config)?;
    Ok(config)
}

#[tauri::command]
async fn calendar_events(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    from: Option<String>,
    to: Option<String>,
) -> AppResult<Vec<calendar::CalendarEvent>> {
    // Settings get re-read each call so the user can paste a new URL and
    // hit refresh without restarting. The cost is one tiny disk read per
    // refresh, which is fine for a manually-triggered fetch.
    let cfg = load_calendar_config(&state.app_data_dir)?;
    let content_root = state.content.root().to_path_buf();
    // content_root is <repo>/data/files; bin/calendar/eventkit.sh lives at
    // <repo>/bin/...  so go up two levels, not one.
    let repo_root = content_root
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());

    let want_eventkit = cfg.transport == "eventkit";

    // EventKit path: requires from+to since the adapter can't dump the
    // whole calendar history. If the user explicitly chose eventkit but
    // didn't pass a window, default to today + 6 days at the call site —
    // the frontend always passes a range, but tests hit this path naked.
    if want_eventkit {
        let (f, t) = match (from.clone(), to.clone()) {
            (Some(f), Some(t)) => (f, t),
            _ => {
                // No-window default — empty list rather than guess; the
                // frontend always provides a range.
                return Ok(vec![]);
            }
        };
        // Resolve the EventKit script path. Dev runs find it at
        // <repo>/bin/calendar/eventkit.sh; packaged builds extract
        // it from bundle resources to <app_data>/calendar/ on first
        // call so the script's `.eventkit-bin` cache has a writable
        // home (the .app bundle itself is signed read-only).
        let resource_dir = app_handle.path().resource_dir().ok();
        let app_data = state.app_data_dir.clone();
        let repo_root_for_resolve = repo_root.clone();
        let resolve_result = tauri::async_runtime::spawn_blocking(move || {
            calendar::resolve_eventkit_script(
                &app_data,
                resource_dir.as_deref(),
                repo_root_for_resolve.as_deref(),
            )
        })
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?;

        if let Ok(script) = resolve_result {
            let from_for = f.clone();
            let to_for = t.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                calendar::fetch_eventkit_at(&script, &from_for, &to_for)
            })
            .await
            .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?;
            match result {
                Ok(events) => return Ok(calendar::events_in_range(&events, &f, &t)),
                Err(_) if !cfg.ics_url.trim().is_empty() => {
                    // Fall through to ICS — user has a URL configured as
                    // backup. No log; the surface shows the events that
                    // succeeded.
                }
                Err(e) => return Err(e),
            }
        }
    }

    if cfg.ics_url.trim().is_empty() {
        return Ok(vec![]);
    }
    let url = cfg.ics_url.clone();
    let events = tauri::async_runtime::spawn_blocking(move || calendar::fetch(&url))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    let events = match (from, to) {
        (Some(f), Some(t)) => calendar::events_in_range(&events, &f, &t),
        _ => events,
    };
    Ok(events)
}

#[tauri::command]
async fn claude_mcp_list(
    state: State<'_, AppState>,
) -> AppResult<Vec<claude::McpServer>> {
    let cfg = claude::load_config(&state.app_data_dir)?;
    tauri::async_runtime::spawn_blocking(move || claude::mcp_list(&cfg))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

#[tauri::command]
async fn claude_ping(state: State<'_, AppState>) -> AppResult<String> {
    // Read everything off `state` synchronously, then hand the subprocess
    // call to a blocking task so the tokio runtime's worker thread doesn't
    // stall for multiple seconds (which surfaces as the beach-ball on
    // macOS because Tauri shares threads between IPC and the webview).
    let cfg = claude::load_config(&state.app_data_dir)?;
    tauri::async_runtime::spawn_blocking(move || claude::ping(&cfg))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

#[tauri::command]
async fn claude_parse_task(
    state: State<'_, AppState>,
    text: String,
) -> AppResult<claude::ParsedTask> {
    let cfg = claude::load_config(&state.app_data_dir)?;
    let projects = state.content.list_projects()?;
    let today_local = today_local_str();
    tauri::async_runtime::spawn_blocking(move || {
        claude::parse_task(&cfg, &text, &projects, &today_local)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// Snapshot of the user's gh install + auth state. Powers Settings →
/// GitHub and the Velocity surface's "configure GitHub" empty
/// state.
#[tauri::command]
async fn gh_status() -> AppResult<github::GhStatus> {
    tauri::async_runtime::spawn_blocking(github::status)
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))
}

/// PRs the user has authored that are still open. Drives the
/// Work → PRs tab (PRD-109 §5.1).
#[tauri::command]
async fn gh_my_prs(limit: Option<u32>) -> AppResult<Vec<github::PrRow>> {
    let lim = limit.unwrap_or(50).clamp(1, 200);
    tauri::async_runtime::spawn_blocking(move || github::my_prs(lim))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// PRs blocked on the user's review. Drives the Work → Review tab.
#[tauri::command]
async fn gh_review_requests(limit: Option<u32>) -> AppResult<Vec<github::PrRow>> {
    let lim = limit.unwrap_or(50).clamp(1, 200);
    tauri::async_runtime::spawn_blocking(move || github::review_requested_prs(lim))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// CI rollup for one PR. The frontend lazy-fetches the visible rows
/// (top N) so we don't eat 50 round-trips on every refresh.
#[tauri::command]
async fn gh_pr_ci(repo: String, number: i64) -> AppResult<github::CiStatus> {
    tauri::async_runtime::spawn_blocking(move || github::pr_ci_status(&repo, number))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// Per-PR detail (body + recent reviews + reviewer count). Fetched
/// on demand when the user expands a row (B9-CP11) — not eager.
#[tauri::command]
async fn gh_pr_detail(repo: String, number: i64) -> AppResult<github::PrDetail> {
    tauri::async_runtime::spawn_blocking(move || github::pr_detail(&repo, number))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// Open PRs authored by a given login. Drives the Person Profile
/// "their open PRs" section when github_login is set on person.json.
#[tauri::command]
async fn gh_prs_for_author(
    login: String,
    limit: Option<u32>,
) -> AppResult<Vec<github::PrRow>> {
    let lim = limit.unwrap_or(20).clamp(1, 50);
    tauri::async_runtime::spawn_blocking(move || {
        github::prs_for_author(&login, lim)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// Drive /ops-incidents, then read the JSON snapshot the skill wrote.
/// Returns the full payload (incidents + fetched_at + optional
/// mcp_error) so the UI can render integration health alongside
/// the data.
#[tauri::command]
async fn ops_incidents_run(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());

    let _raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "ops-incidents", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    // The skill writes to data/files/areas/ops/incidents.json. Read
    // it back rather than parse the SAVED line — we need the actual
    // payload, not just the path.
    ops_incidents_read_inner(&content_root)
}

/// Read the incidents snapshot without invoking the skill. Used by
/// the Ops tab on cold mount to show whatever the last run produced.
#[tauri::command]
async fn ops_incidents_read(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || ops_incidents_read_inner(&content_root))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

fn ops_incidents_read_inner(content_root: &std::path::Path) -> AppResult<serde_json::Value> {
    ops_snapshot_read(content_root, "incidents.json", "incidents")
}

/// Generic Ops-snapshot reader. Three Ops tabs share the same shape
/// (path under areas/ops/<file>.json with fetched_at + a list under
/// the named key) so we collapse the IPC plumbing.
fn ops_snapshot_read(
    content_root: &std::path::Path,
    file: &str,
    list_key: &str,
) -> AppResult<serde_json::Value> {
    let path = content_root.join("areas").join("ops").join(file);
    if !path.exists() {
        let mut obj = serde_json::Map::new();
        obj.insert("fetched_at".into(), serde_json::Value::Null);
        obj.insert(list_key.into(), serde_json::Value::Array(vec![]));
        obj.insert("missing".into(), serde_json::Value::Bool(true));
        return Ok(serde_json::Value::Object(obj));
    }
    let text = std::fs::read_to_string(&path).map_err(AppError::Io)?;
    let val: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| {
            AppError::InvalidState(format!("ops {file} parse: {e}"))
        })?;
    Ok(val)
}

#[tauri::command]
async fn ops_rollbar_run(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let _raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "ops-rollbar-top", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    ops_snapshot_read(&content_root, "rollbar-top.json", "items")
}

#[tauri::command]
async fn ops_rollbar_read(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        ops_snapshot_read(&content_root, "rollbar-top.json", "items")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

#[tauri::command]
async fn ops_monitors_run(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let _raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "ops-datadog-monitors", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    ops_snapshot_read(&content_root, "datadog-monitors.json", "monitors")
}

#[tauri::command]
async fn ops_monitors_read(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        ops_snapshot_read(&content_root, "datadog-monitors.json", "monitors")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// /ops-my-jira — Atlassian MCP -> JSON snapshot of issues assigned
/// to the current user. Same path-pattern as the Ops snapshots so
/// the read+run helpers compose.
#[tauri::command]
async fn jira_my_run(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let _raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "ops-my-jira", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    let path = content_root.join("areas").join("work").join("my-jira.json");
    if !path.exists() {
        return Ok(serde_json::json!({ "fetched_at": null, "issues": [], "missing": true }));
    }
    let text = std::fs::read_to_string(&path).map_err(AppError::Io)?;
    let val: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidState(format!("my-jira parse: {e}")))?;
    Ok(val)
}

#[tauri::command]
async fn jira_my_read(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    jira_read_one(state, "my-jira.json").await
}

#[tauri::command]
async fn jira_team_run(
    state: State<'_, AppState>,
    team: Option<String>,
) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let arg = team.unwrap_or_default();
    let _raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "ops-team-jira", &arg)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    let path = content_root
        .join("areas")
        .join("work")
        .join("team-jira.json");
    if !path.exists() {
        return Ok(
            serde_json::json!({ "fetched_at": null, "issues": [], "missing": true }),
        );
    }
    let text = std::fs::read_to_string(&path).map_err(AppError::Io)?;
    Ok(serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidState(format!("team-jira parse: {e}")))?)
}

#[tauri::command]
async fn jira_team_read(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    jira_read_one(state, "team-jira.json").await
}

async fn jira_read_one(
    state: State<'_, AppState>,
    file: &'static str,
) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let path = content_root.join("areas").join("work").join(file);
        if !path.exists() {
            return Ok(serde_json::json!({
                "fetched_at": null,
                "issues": [],
                "missing": true,
            }));
        }
        let text = std::fs::read_to_string(&path).map_err(AppError::Io)?;
        let val: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| AppError::InvalidState(format!("{file} parse: {e}")))?;
        Ok(val)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// Snapshot of the user's PagerDuty integration state. Reports
/// whether a token is configured and (when set) the user the
/// token resolves to. Settings → Ops → On-call calls this on
/// open + on Probe.
#[derive(serde::Serialize)]
struct PagingStatus {
    provider: String,
    has_token: bool,
    /// `Ok(email)` when whoami succeeded, `Err(message)` otherwise.
    /// Stays None when no token is configured (don't probe a
    /// missing token).
    whoami: Option<Result<String, String>>,
}

#[tauri::command]
async fn paging_status(probe: Option<bool>) -> AppResult<serde_json::Value> {
    let token = paging::read_token()?;
    let mut whoami_field: Option<Result<String, String>> = None;
    if probe.unwrap_or(false) {
        if let Some(t) = &token {
            let t = t.clone();
            let res = tauri::async_runtime::spawn_blocking(move || {
                paging::whoami(&t)
            })
            .await
            .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?;
            whoami_field = Some(match res {
                Ok(email) => Ok(email),
                Err(e) => Err(format!("{e}")),
            });
        }
    }
    let status = PagingStatus {
        provider: "pagerduty".into(),
        has_token: token.is_some(),
        whoami: whoami_field,
    };
    Ok(serde_json::to_value(status)?)
}

#[tauri::command]
fn paging_token_set(token: String) -> AppResult<()> {
    paging::write_token(&token)
}

#[tauri::command]
fn paging_token_clear() -> AppResult<()> {
    paging::clear_token()
}

/// Current on-call across every escalation policy visible to the
/// configured PD token. Returns an empty list — not an error — when
/// no token is set, so the Ops surface can tell apart "configure
/// your token" from "real fetch failed". A second call within 60s
/// returns the cached payload.
#[tauri::command]
async fn paging_oncall_now() -> AppResult<Vec<paging::OncallEntry>> {
    let Some(token) = paging::read_token()? else {
        return Ok(vec![]);
    };
    tauri::async_runtime::spawn_blocking(move || paging::oncall_now(&token))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// Current on-call for one PD service id. Two PD round-trips
/// (service → policy → filter oncalls).
#[tauri::command]
async fn paging_for_service(service_id: String) -> AppResult<Vec<paging::OncallEntry>> {
    let Some(token) = paging::read_token()? else {
        return Ok(vec![]);
    };
    tauri::async_runtime::spawn_blocking(move || {
        paging::for_service(&token, &service_id)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// Upcoming shifts for one PD user id, in the next `days`. Used by
/// Person Profile (B9-CP33).
#[tauri::command]
async fn paging_user_shifts(
    user_id: String,
    days: Option<u32>,
) -> AppResult<Vec<paging::Shift>> {
    let Some(token) = paging::read_token()? else {
        return Ok(vec![]);
    };
    let d = days.unwrap_or(14).clamp(1, 90);
    tauri::async_runtime::spawn_blocking(move || {
        paging::user_shifts(&token, &user_id, d)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// /planning-epic-update <key> — draft a weekly narrative for one
/// epic. Returns rel_path of the written file so the editor opens
/// it for the user to polish.
#[tauri::command]
async fn planning_epic_update(
    state: State<'_, AppState>,
    epic_key: String,
) -> AppResult<PrepResult> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let arg = epic_key.clone();
    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "planning-epic-update", &arg)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    let (summary, repo_rel) = parse_saved_line(&raw)?;
    let rel_path = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();
    Ok(PrepResult {
        rel_path,
        summary: summary.trim().to_string(),
    })
}

/// /velocity-diagnose — write a one-page synthesis of recent PR
/// + Jira flow. Returns rel_path so the editor can open it.
#[tauri::command]
async fn velocity_diagnose(state: State<'_, AppState>) -> AppResult<PrepResult> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "velocity-diagnose", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    let (summary, repo_rel) = parse_saved_line(&raw)?;
    let rel_path = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();
    Ok(PrepResult {
        rel_path,
        summary: summary.trim().to_string(),
    })
}

/// /planning-team-epics — Atlassian MCP snapshot of epics owned by
/// the user's team. Drives Projects → Roadmap (B8-CP24).
#[tauri::command]
async fn planning_epics_run(
    state: State<'_, AppState>,
    team: Option<String>,
) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let arg = team.unwrap_or_default();
    let _raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "planning-team-epics", &arg)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    let path = content_root.join("areas").join("planning").join("epics.json");
    planning_read_inner(&path)
}

#[tauri::command]
async fn planning_epics_read(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let path = content_root.join("areas").join("planning").join("epics.json");
        planning_read_inner(&path)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

#[tauri::command]
async fn planning_jpd_run(
    state: State<'_, AppState>,
    team: Option<String>,
) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let arg = team.unwrap_or_default();
    let _raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "planning-jpd", &arg)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;
    let path = content_root.join("areas").join("planning").join("jpd.json");
    if !path.exists() {
        return Ok(serde_json::json!({
            "fetched_at": null,
            "ideas": [],
            "missing": true,
        }));
    }
    let text = std::fs::read_to_string(&path).map_err(AppError::Io)?;
    Ok(serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidState(format!("jpd parse: {e}")))?)
}

#[tauri::command]
async fn planning_jpd_read(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    let content_root = state.content.root().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let path = content_root.join("areas").join("planning").join("jpd.json");
        if !path.exists() {
            return Ok(serde_json::json!({
                "fetched_at": null,
                "ideas": [],
                "missing": true,
            }));
        }
        let text = std::fs::read_to_string(&path).map_err(AppError::Io)?;
        Ok(serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|e| AppError::InvalidState(format!("jpd parse: {e}")))?)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

fn planning_read_inner(path: &std::path::Path) -> AppResult<serde_json::Value> {
    if !path.exists() {
        return Ok(serde_json::json!({
            "fetched_at": null,
            "epics": [],
            "missing": true,
        }));
    }
    let text = std::fs::read_to_string(path).map_err(AppError::Io)?;
    let val: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidState(format!("planning epics parse: {e}")))?;
    Ok(val)
}

fn today_local_str() -> String {
    rusqlite::Connection::open_in_memory()
        .and_then(|c| {
            c.query_row("SELECT date('now', 'localtime')", [], |r| r.get::<_, String>(0))
        })
        .unwrap_or_else(|_| String::new())
}

#[tauri::command]
fn content_status(state: State<'_, AppState>) -> ContentStatus {
    state.content.status()
}

/// Settings → Data folder: read the resolved content root so the
/// frontend can show the user where their files currently live, plus
/// the default fallback (`~/Documents/Chief of Staff/data/files`) for
/// the picker UI.
#[derive(serde::Serialize)]
struct ContentRootInfo {
    /// The path the app is using right now. Same as `content_status().root`.
    current: String,
    /// The default fallback if no choice has been made and no repo
    /// checkout is found by walking up from cwd.
    default: String,
    /// True iff the persisted-choice file exists; the frontend uses
    /// this to label the picker as "Using saved choice" vs "Using
    /// default".
    has_choice: bool,
    /// True iff `$COS_CONTENT_ROOT` is set (overrides everything else).
    env_override: bool,
}

#[tauri::command]
fn content_root_info(state: State<'_, AppState>) -> ContentRootInfo {
    let current = state.content.root().to_path_buf();
    let default = content::default_content_root();
    let has_choice = content::read_root_choice(&state.app_data_dir).is_some();
    let env_override = std::env::var("COS_CONTENT_ROOT")
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    ContentRootInfo {
        current: current.to_string_lossy().into_owned(),
        default: default.to_string_lossy().into_owned(),
        has_choice,
        env_override,
    }
}

/// Persist a new content-root choice. The new root takes effect on
/// the next launch — switching mid-session would orphan the open
/// editor's relPaths and the in-memory v1 task DB pointer, both of
/// which are wired to the previous root. The frontend should prompt
/// the user to relaunch after a successful set.
#[tauri::command]
fn content_root_set(
    state: State<'_, AppState>,
    root: String,
) -> AppResult<String> {
    let path = std::path::PathBuf::from(&root);
    let canonical = content::write_root_choice(&state.app_data_dir, &path)?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// PRD-103 / Phase 0.5.2 — read the user profile (name, role, team,
/// manager, direct reports). Returns a default when the file
/// doesn't exist yet (fresh install) so the wizard can show a
/// blank form. Pre-fill defaults from `~/.gitconfig` come back via
/// `profile_gitconfig_defaults` so the frontend can decide whether
/// to use them.
#[tauri::command]
fn profile_get(state: State<'_, AppState>) -> profile::UserProfile {
    profile::read(state.content.root())
}

#[tauri::command]
fn profile_set(
    state: State<'_, AppState>,
    profile: profile::UserProfile,
) -> AppResult<()> {
    profile::write(state.content.root(), &profile)
}

#[derive(serde::Serialize)]
struct GitconfigDefaults {
    name: String,
    email: String,
}

#[tauri::command]
fn profile_gitconfig_defaults() -> GitconfigDefaults {
    let (name, email) = profile::read_gitconfig_defaults();
    GitconfigDefaults { name, email }
}

/// PRD-103 Phase 0.5 — install / uninstall / status the launchd
/// agent for an automation. Maps `kind` to the right setup script
/// (bin/reminders/, bin/weekly-review/) and shells out with the
/// requested action.
#[tauri::command]
async fn automation_cron_run(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    kind: automation::CronKind,
    action: String,
) -> AppResult<automation::CronOpResult> {
    let resource_dir = app_handle.path().resource_dir().ok();
    let repo_root = state
        .content
        .root()
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf());
    tauri::async_runtime::spawn_blocking(move || {
        automation::run_cron_op(
            kind,
            &action,
            resource_dir.as_deref(),
            repo_root.as_deref(),
        )
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// PRD-103 / Phase 0.5.5 — scaffold person folders under
/// `<content_root>/areas/one-on-ones/<relationship>/<slug>/` for
/// each person the user picked in the wizard. Idempotent: existing
/// READMEs are preserved.
#[tauri::command]
fn profile_scaffold_people(
    state: State<'_, AppState>,
    people: Vec<profile::PersonScaffold>,
) -> AppResult<profile::ScaffoldResult> {
    profile::scaffold_people(state.content.root(), &people)
}

/// PRD-103 / Phase 0.5 #2 — create starter project READMEs from
/// the bundled templates. Each kind drops `projects/<slug>/README.md`
/// with prompts the user fills in (career development, hiring
/// pipeline, mentorship, presentation prep, quarterly planning,
/// new-team-member onboarding). Idempotent.
#[tauri::command]
fn profile_scaffold_starter_projects(
    state: State<'_, AppState>,
    kinds: Vec<profile::StarterProjectKind>,
) -> AppResult<Vec<String>> {
    profile::scaffold_starter_projects(state.content.root(), &kinds)
}

/// Write a binary attachment alongside the doc that produced it
/// (B7-CP28). Frontend hands the raw bytes as a u8 array — keeps the
/// IPC dep-free (no base64 crate) and matches what the
/// browser's clipboard / drop APIs naturally produce. Returns the
/// rel-path of the written file so the caller can insert a markdown
/// image link.
#[tauri::command]
fn content_write_attachment(
    state: State<'_, AppState>,
    doc_rel_path: String,
    filename: String,
    bytes: Vec<u8>,
) -> AppResult<String> {
    state
        .content
        .write_attachment(&doc_rel_path, &filename, &bytes)
}

#[tauri::command]
fn content_recent_sessions(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> AppResult<Vec<SessionRef>> {
    state.content.recent_sessions(limit.unwrap_or(10))
}

#[tauri::command]
fn content_list_projects(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    state.content.list_projects()
}

#[tauri::command]
fn content_list_project_refs(
    state: State<'_, AppState>,
) -> AppResult<Vec<ProjectRef>> {
    state.content.list_project_refs()
}

#[tauri::command]
fn content_list_project_files(
    state: State<'_, AppState>,
    rel_path: String,
) -> AppResult<Vec<ProjectFile>> {
    state.content.list_project_files(&rel_path)
}

#[tauri::command]
fn content_list_people(state: State<'_, AppState>) -> AppResult<Vec<PersonRef>> {
    state.content.list_people()
}

#[tauri::command]
fn content_list_meetings(state: State<'_, AppState>) -> AppResult<Vec<MeetingRef>> {
    state.content.list_meetings()
}

/// PRD-115 §6.3 — backend feed for the People "Needs your attention"
/// hero. Frontend supplies `today` (local YYYY-MM-DD); we don't compute
/// it here since Rust has no TZ-aware date math without chrono.
#[tauri::command]
fn content_attention_people(
    state: State<'_, AppState>,
    today: String,
    stale_days: Option<i64>,
) -> AppResult<Vec<AttentionPerson>> {
    state
        .content
        .list_attention_people(&today, stale_days.unwrap_or(14))
}

/// PRD-115 §6.6 — backend feed for the Projects status grid.
/// Frontend supplies `today` (YYYY-MM-DD local) so we can detect
/// "soon-done" via target-within-7-days without pulling chrono.
#[tauri::command]
fn content_project_status(
    state: State<'_, AppState>,
    today: String,
) -> AppResult<Vec<ProjectStatusInfo>> {
    state.content.compute_project_statuses(&today)
}

/// Filtered audit query for the Activity tab. All filters are
/// optional; passing empty/None means "no constraint". The frontend
/// uses this for action-bucket filters + free-text target_id search +
/// date range.
#[tauri::command]
fn audit_filter(
    state: State<'_, AppState>,
    action_prefix: Option<String>,
    target_query: Option<String>,
    from_iso: Option<String>,
    to_iso: Option<String>,
    limit: Option<i64>,
) -> AppResult<Vec<AuditRow>> {
    let db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    audit::filter(
        &db.conn,
        action_prefix.as_deref().unwrap_or(""),
        target_query.as_deref().unwrap_or(""),
        from_iso.as_deref(),
        to_iso.as_deref(),
        limit.unwrap_or(50),
    )
}

/// Restore a doc to its before-state for the given `audit_id`.
/// Returns a tagged enum the frontend uses to render the right inline
/// status (restored / no-op / create-row / blob-missing).
#[tauri::command]
fn audit_restore(
    state: State<'_, AppState>,
    audit_id: i64,
) -> AppResult<RestoreOutcome> {
    let mut db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    state
        .content
        .restore_from_audit(audit_id, &mut db.conn, &state.blobs, "local")
}

#[derive(serde::Deserialize, Serialize, Clone, Debug)]
struct OpenRequest {
    rel_path: String,
    #[serde(default)]
    label: String,
}

/// `cos open <rel-path>` writes a one-shot JSON request to
/// `<app_data>/.open-request.json`; the desktop app polls this file
/// from the frontend, picks up any pending request, and routes
/// through `cos:open-doc`. The take_*-style semantics (read + delete)
/// keep the request from re-firing on every poll.
///
/// Returns None when the file is absent OR malformed (we silently
/// drop bad payloads rather than surfacing a parse error to the UI —
/// CLI typos shouldn't show up as a Settings error).
#[tauri::command]
fn take_open_request(state: State<'_, AppState>) -> AppResult<Option<OpenRequest>> {
    let path = state.app_data_dir.join(".open-request.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    // Always delete first — even if parsing fails, the malformed
    // request shouldn't sit there blocking future writes.
    let _ = std::fs::remove_file(&path);
    let parsed: Result<OpenRequest, _> = serde_json::from_str(&raw);
    match parsed {
        Ok(req) if !req.rel_path.is_empty() => Ok(Some(req)),
        _ => Ok(None),
    }
}

/// M10a — list installed plugins (PRD-104). Today this is read-only;
/// the loader + capability surface land in later checkpoints. Empty
/// list when `<app_data>/plugins/` is absent, which is the steady
/// state on a fresh install.
#[tauri::command]
fn plugin_list(state: State<'_, AppState>) -> AppResult<Vec<plugins::PluginRow>> {
    state.plugins.list()
}

/// Resolve the on-disk plugin directory + ensure it exists. Used by
/// Settings → Plugins' "open folder" button so the user has somewhere
/// to drop a manifest manually. Creates the dir if missing — first
/// click is also the install affordance.
#[tauri::command]
fn plugin_dir_path(state: State<'_, AppState>) -> AppResult<String> {
    let dir = state.app_data_dir.join("plugins");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir.display().to_string())
}

/// Reveal the plugin directory in the platform file browser. We do
/// this from Rust instead of via the opener plugin because Tauri's
/// `opener:default` capability only authorizes `open-url` against
/// http(s)/mailto schemes — file:// URLs are rejected without a
/// custom capability list. `open <path>` (macOS) / `xdg-open <path>`
/// (Linux) / `explorer <path>` (Windows) all do exactly what the
/// user wants and need no permission plumbing.
#[tauri::command]
fn plugin_dir_open(state: State<'_, AppState>) -> AppResult<()> {
    let dir = state.app_data_dir.join("plugins");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(cmd).arg(&dir).spawn()?;
    Ok(())
}

/// M5 — install / first-run readiness snapshot. Three checks: content
/// root exists, Claude CLI resolves, calendar source is configured.
/// Frontend renders these in Settings → Diagnostics with deep-link
/// "fix it" buttons for any failing check.
#[tauri::command]
fn install_status(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> AppResult<install::InstallStatus> {
    let cfg = claude::load_config(&state.app_data_dir).unwrap_or_default();
    let claude_bin = claude::resolve_binary(&cfg.binary_path);
    let cal_cfg = load_calendar_config(&state.app_data_dir).unwrap_or_default();

    // EventKit script lives in two places depending on context:
    //   - Dev runs: <repo>/bin/calendar/eventkit.sh
    //   - Packaged builds: extracted from bundle resources to
    //     <app_data>/calendar/eventkit.sh on first calendar fetch
    // We probe both — having the bundled script counts as "present"
    // because the resolver will extract on demand.
    let repo_root = state.content.root().parent().and_then(|p| p.parent());
    let dev_present = repo_root
        .map(|r| r.join("bin").join("calendar").join("eventkit.sh").is_file())
        .unwrap_or(false);
    let bundled_present = app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|rd| rd.join("bin").join("calendar").join("eventkit.sh").is_file())
        .unwrap_or(false);
    let extracted_present = state
        .app_data_dir
        .join("calendar")
        .join("eventkit.sh")
        .is_file();
    let eventkit_present = dev_present || bundled_present || extracted_present;

    install::compute(
        state.content.root(),
        claude_bin.as_deref(),
        &cal_cfg.ics_url,
        &cal_cfg.transport,
        eventkit_present,
    )
}

// ====== Performance harness (PRD-101) ======

#[tauri::command]
fn perf_record(
    state: State<'_, AppState>,
    sample: perf::PerfSample,
) -> AppResult<()> {
    state.perf_log.record(sample)
}

#[tauri::command]
fn perf_summaries(
    state: State<'_, AppState>,
    recent: Option<usize>,
) -> AppResult<Vec<perf::PerfSummary>> {
    state.perf_log.summaries(recent.unwrap_or(5))
}

#[tauri::command]
fn perf_clear(state: State<'_, AppState>) -> AppResult<()> {
    state.perf_log.clear()
}

/// PRD-115 §6.1 — backend feed for the Home top-3 priorities hero.
/// Two-tier source: today's briefing → overdue HIGH tasks → empty.
#[tauri::command]
fn content_top_priorities(
    state: State<'_, AppState>,
    today: String,
    limit: Option<usize>,
) -> AppResult<Vec<PriorityItem>> {
    let cap = limit.unwrap_or(3);
    let mut from_briefing = state.content.top_priorities_from_briefing(&today, cap)?;
    if !from_briefing.is_empty() {
        // Try to upgrade each briefing-sourced item: if its bolded
        // title matches exactly one v1 task title, route the card to
        // the task surface instead of the briefing.
        if let Ok(tasks) = state.v1_tasks.list_active() {
            for item in from_briefing.iter_mut() {
                // Only consider items that didn't already resolve to a
                // specific doc — those are the briefing-fallback ones
                // where a task target would be a real upgrade.
                let already_specific = item
                    .rel_path
                    .as_ref()
                    .map(|p| !p.starts_with("areas/daily-briefings/"))
                    .unwrap_or(false);
                if already_specific {
                    continue;
                }
                if let Some(tid) = match_bullet_to_task_id(&item.text, &tasks) {
                    item.task_id = Some(tid);
                    // Drop rel_path/scroll_to so the frontend can route
                    // unambiguously to the task instead of the doc.
                    item.rel_path = None;
                    item.scroll_to = None;
                }
            }
        }
        return Ok(from_briefing);
    }
    // Fallback: overdue HIGH tasks. Today counts as "due today" not
    // overdue, so the strict comparison is `< today`.
    let mut tasks = state.v1_tasks.list_active().unwrap_or_default();
    tasks.retain(|t| {
        if t.priority != "high" {
            return false;
        }
        match t.due.as_deref() {
            Some(d) => {
                // Strip any time component, compare YYYY-MM-DD prefix.
                let day = d.get(..10).unwrap_or(d);
                day < today.as_str()
            }
            None => false,
        }
    });
    let out: Vec<PriorityItem> = tasks
        .into_iter()
        .take(cap)
        .map(|t| PriorityItem {
            text: t.title.clone(),
            source: "overdue".into(),
            rel_path: None,
            task_id: Some(t.id.clone()),
            scroll_to: None,
        })
        .collect();
    Ok(out)
}

/// Heuristic: pull a candidate title out of a briefing bullet (the
/// first **bold** chunk if present, else the leading words) and match
/// it against task titles. Returns Some(id) only when a single task
/// is a strong match — case-insensitive, with both directions of
/// substring containment allowed (the briefing may shorten or expand
/// on the task title). Multiple matches → None: better to leave the
/// card pointing at the briefing than to gamble on the wrong task.
fn match_bullet_to_task_id(bullet: &str, tasks: &[v1_tasks::V1Task]) -> Option<String> {
    let candidate = bolded_prefix_or_short(bullet);
    if candidate.len() < 6 {
        // Avoid matching on tiny phrases like "Open" or "Plan" that
        // collide with many task titles.
        return None;
    }
    let needle = candidate.to_lowercase();
    let mut hits: Vec<&v1_tasks::V1Task> = Vec::new();
    for t in tasks {
        let hay = t.title.to_lowercase();
        if hay.contains(&needle) || needle.contains(&hay) {
            hits.push(t);
        }
    }
    if hits.len() == 1 {
        Some(hits[0].id.clone())
    } else {
        None
    }
}

fn bolded_prefix_or_short(text: &str) -> String {
    if let Some(start) = text.find("**") {
        let rest = &text[start + 2..];
        if let Some(end) = rest.find("**") {
            let inner = rest[..end].trim();
            if !inner.is_empty() {
                return inner.to_string();
            }
        }
    }
    // Fall back: take up to the first em-dash / period / paren — those
    // tend to separate the title from the prose tail.
    let cut = text
        .find(" — ")
        .or_else(|| text.find(". "))
        .or_else(|| text.find(" ("))
        .unwrap_or_else(|| text.len().min(60));
    text[..cut].trim().to_string()
}

#[tauri::command]
fn content_list_sessions(
    state: State<'_, AppState>,
    rel_path: String,
    limit: Option<usize>,
) -> AppResult<Vec<SessionMeta>> {
    state.content.list_sessions_in(&rel_path, limit.unwrap_or(0))
}

#[tauri::command]
fn content_create_session(
    state: State<'_, AppState>,
    owner_rel_path: String,
    date: String,
    owner_label: String,
) -> AppResult<String> {
    let mut db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    state.content.create_session(
        &owner_rel_path,
        &date,
        &owner_label,
        &mut db.conn,
        &state.blobs,
        "local",
    )
}

#[tauri::command]
async fn content_search(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<SearchHit>> {
    // Block: filesystem walk + per-file reads. spawn_blocking keeps the
    // UI responsive on large content roots; the palette debounces queries
    // at 250ms so typing doesn't flood us.
    let content = state.content.clone();
    let q = query.clone();
    let lim = limit.unwrap_or(20);
    tauri::async_runtime::spawn_blocking(move || content.search(&q, lim))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

#[tauri::command]
fn annotations_list(
    state: State<'_, AppState>,
    rel_path: String,
) -> AppResult<Vec<annotations::Annotation>> {
    annotations::list(state.content.root(), &rel_path)
}

#[tauri::command]
fn annotations_list_pending(
    state: State<'_, AppState>,
) -> AppResult<Vec<annotations::PendingDoc>> {
    annotations::list_pending(state.content.root())
}

#[tauri::command]
fn annotations_save(
    state: State<'_, AppState>,
    rel_path: String,
    items: Vec<annotations::Annotation>,
) -> AppResult<()> {
    annotations::save(state.content.root(), &rel_path, &items)
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ReminderItem {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
}

#[derive(Serialize)]
struct RemindersResult {
    available: bool,
    items: Vec<ReminderItem>,
    error: Option<String>,
}

#[tauri::command]
fn reminders_list(state: State<'_, AppState>) -> AppResult<RemindersResult> {
    // Shells out to bin/reminders/apple-reminders.sh list. Read-only —
    // never mutates the user's reminders. If the adapter fails (perm
    // denied, compilation error), we return available=false + the
    // error message rather than failing the IPC so Home can still
    // render the rest of its content.
    let content_root = state.content.root().to_path_buf();
    // content_root is <repo>/data/files — script paths sit at <repo>/bin/...,
    // so we go up TWO levels to reach the repo root.
    let repo_root = match content_root.parent().and_then(|p| p.parent()) {
        Some(p) => p.to_path_buf(),
        None => {
            return Ok(RemindersResult {
                available: false,
                items: vec![],
                error: Some("could not resolve repo root".into()),
            });
        }
    };
    let script = repo_root.join("bin/reminders/apple-reminders.sh");
    if !script.is_file() {
        return Ok(RemindersResult {
            available: false,
            items: vec![],
            error: Some(format!("not found: {}", script.display())),
        });
    }
    let output = match std::process::Command::new("bash")
        .arg(&script)
        .arg("list")
        .current_dir(&repo_root)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            return Ok(RemindersResult {
                available: false,
                items: vec![],
                error: Some(format!("spawn: {e}")),
            });
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Ok(RemindersResult {
            available: false,
            items: vec![],
            error: Some(stderr.trim().to_string()),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let items: Vec<ReminderItem> = serde_json::from_str(&stdout).unwrap_or_default();
    Ok(RemindersResult {
        available: true,
        items,
        error: None,
    })
}

#[tauri::command]
fn content_recent_briefings(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> AppResult<Vec<SessionMeta>> {
    state.content.recent_briefings(limit.unwrap_or(7))
}

#[tauri::command]
fn content_person_profile(
    state: State<'_, AppState>,
    rel_path: String,
    limit: Option<usize>,
) -> AppResult<PersonProfile> {
    state
        .content
        .read_person_profile(&rel_path, limit.unwrap_or(10))
}

#[derive(Serialize)]
struct PrepResult {
    /// Relative path (from content root) of the session file the skill
    /// saved or updated. The UI opens this directly in the editor.
    rel_path: String,
    /// The skill's stdout summary (everything before the SAVED: line)
    /// in case the UI wants to surface a short toast.
    summary: String,
}

#[tauri::command]
async fn weekly_review(state: State<'_, AppState>) -> AppResult<PrepResult> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());

    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "weekly-review", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    let (summary, repo_rel) = parse_saved_line(&raw)?;
    let rel_path = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();
    Ok(PrepResult {
        rel_path,
        summary: summary.trim().to_string(),
    })
}

#[tauri::command]
async fn task_triage(state: State<'_, AppState>) -> AppResult<PrepResult> {
    // /task-triage writes to areas/task-triage/triage.md (overwriting)
    // and prints SAVED:<path>. v2 opens that file in the editor for
    // the user to annotate; /process-ui-annotations (M2c) applies the
    // annotation instructions back to the task DB.
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());

    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "task-triage", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    let (summary, repo_rel) = parse_saved_line(&raw)?;
    let rel_path = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();
    Ok(PrepResult {
        rel_path,
        summary: summary.trim().to_string(),
    })
}

#[tauri::command]
async fn morning_briefing(state: State<'_, AppState>) -> AppResult<PrepResult> {
    // Invokes /morning-briefing with no args. Skill writes the daily
    // briefing file and prints SAVED: <path>; we open that in the editor.
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());

    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "morning-briefing", "")
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    let (summary, repo_rel) = parse_saved_line(&raw)?;
    let rel_path = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();
    Ok(PrepResult {
        rel_path,
        summary: summary.trim().to_string(),
    })
}

#[tauri::command]
async fn annotations_process(
    state: State<'_, AppState>,
    rel_path: String,
) -> AppResult<PrepResult> {
    // /process-ui-annotations <repo-relative-path>. The slash command
    // applies each pending annotation's comment to the file and marks
    // them processed in place; we parse SAVED: <path> and reload the
    // editor.
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    let arg = format!("data/files/{rel_path}");

    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(
            &cfg,
            repo_root.as_deref(),
            "process-ui-annotations",
            &arg,
        )
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    let (summary, repo_rel) = parse_saved_line(&raw)?;
    let rel_path_out = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();

    // Safety net: parse the skill's PROCESSED: line and scrub those IDs
    // from the sidecar deterministically. The skill is supposed to do
    // this itself via Edit/Write, but it occasionally forgets — and a
    // user clicking "Process with Claude" expects the panel to clear.
    // Idempotent: if the skill already cleaned up, removed=0 and we
    // proceed quietly.
    let processed_ids = parse_processed_ids(&raw);
    if !processed_ids.is_empty() {
        let _ = annotations::remove_by_ids(
            state.content.root(),
            &rel_path_out,
            &processed_ids,
        );
    }

    Ok(PrepResult {
        rel_path: rel_path_out,
        summary: summary.trim().to_string(),
    })
}

#[tauri::command]
async fn session_digest(
    state: State<'_, AppState>,
    rel_path: String,
) -> AppResult<PrepResult> {
    // Invokes /digest-meeting with the session-file path. The skill
    // updates the file in place + the surrounding README, then prints
    // SAVED: <path> so we can re-read in the editor without guessing
    // which date got digested.
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    // Skill expects a repo-relative path; UI sends content-relative.
    let arg = format!("data/files/{rel_path}");

    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "digest-meeting", &arg)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    let (summary, repo_rel) = parse_saved_line(&raw)?;
    let rel_path_out = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();
    Ok(PrepResult {
        rel_path: rel_path_out,
        summary: summary.trim().to_string(),
    })
}

#[tauri::command]
async fn person_prep(
    state: State<'_, AppState>,
    slug: String,
) -> AppResult<PrepResult> {
    // Invoke the user's `/prep-1on1` slash command directly. The skill
    // owns the prompt and writes the session file at the next 1:1 date;
    // it ends its output with `SAVED: <repo-relative-path>` which we
    // parse and rebase to the content-root-relative path the UI uses.
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());

    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "prep-1on1", &slug)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    let (summary, repo_rel) = parse_saved_line(&raw)?;
    // The skill prints repo-root-relative paths
    // (`data/files/areas/...`); the UI uses content-root-relative
    // (`areas/...`). Strip the `data/files/` prefix.
    let rel_path = repo_rel
        .strip_prefix("data/files/")
        .unwrap_or(&repo_rel)
        .to_string();
    Ok(PrepResult {
        rel_path,
        summary: summary.trim().to_string(),
    })
}

/// Like `parse_saved_line` but for skills that output a `GDOC_URL: <url>`
/// line as their last line (currently /publish-to-gdoc).
fn parse_gdoc_url_line(raw: &str) -> AppResult<(String, String)> {
    let mut summary_end: Option<usize> = None;
    let mut url: Option<String> = None;
    for (i, line) in raw.lines().enumerate() {
        if let Some(rest) = line.trim().strip_prefix("GDOC_URL:") {
            url = Some(rest.trim().to_string());
            summary_end = Some(i);
        }
    }
    let url = url.ok_or_else(|| {
        AppError::InvalidState(format!(
            "skill output missing `GDOC_URL: <url>` line. raw: {}",
            raw.trim()
        ))
    })?;
    let summary = match summary_end {
        Some(line_idx) => raw.lines().take(line_idx).collect::<Vec<_>>().join("\n"),
        None => String::new(),
    };
    Ok((summary, url))
}

#[derive(Serialize)]
struct GDocResult {
    url: String,
    summary: String,
}

#[tauri::command]
async fn publish_to_gdoc(
    state: State<'_, AppState>,
    rel_path: String,
) -> AppResult<GDocResult> {
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    // Slash command expects a repo-relative path.
    let arg = format!("data/files/{rel_path}");

    let raw = tauri::async_runtime::spawn_blocking(move || {
        claude::run_skill(&cfg, repo_root.as_deref(), "publish-to-gdoc", &arg)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    let (summary, url) = parse_gdoc_url_line(&raw)?;
    Ok(GDocResult {
        url,
        summary: summary.trim().to_string(),
    })
}

fn parse_saved_line(raw: &str) -> AppResult<(String, String)> {
    // Find the last `SAVED: <path>` line. Skill spec puts it at the very
    // end, but a tolerant search lets a stray trailing newline slip by.
    let mut summary_end: Option<usize> = None;
    let mut path: Option<String> = None;
    for (i, line) in raw.lines().enumerate() {
        if let Some(rest) = line.trim().strip_prefix("SAVED:") {
            path = Some(rest.trim().to_string());
            summary_end = Some(i);
        }
    }
    let path = path.ok_or_else(|| {
        AppError::InvalidState(format!(
            "skill output missing `SAVED: <path>` line. raw: {}",
            raw.trim()
        ))
    })?;
    let summary = match summary_end {
        Some(line_idx) => raw
            .lines()
            .take(line_idx)
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    };
    Ok((summary, path))
}

/// Parse a `PROCESSED: id1,id2,id3` line out of the skill output. Empty
/// vec when the line is absent — older skill revisions don't emit it,
/// and that's fine; the safety net just no-ops.
fn parse_processed_ids(raw: &str) -> Vec<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("PROCESSED:") {
            return rest
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
        }
    }
    Vec::new()
}

#[tauri::command]
async fn person_refresh(
    state: State<'_, AppState>,
    rel_path: String,
    slug: String,
) -> AppResult<PersonProfile> {
    // Skill-as-slash-command (BUILD-PLAN §3): /person-refresh <slug>
    // does the lookup AND writes person.json directly. We just kick it
    // off and reload from disk.
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    let repo_root = content_root.parent().map(|p| p.to_path_buf());

    tauri::async_runtime::spawn_blocking(move || {
        let _summary = claude::run_skill(
            &cfg,
            repo_root.as_deref(),
            "person-refresh",
            &slug,
        )?;
        let content = content::Content::new(content_root.clone());
        content.read_person_profile(&rel_path, 10)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

#[tauri::command]
fn org_load(state: State<'_, AppState>) -> AppResult<org::OrgFile> {
    org::load(&state.content.root())
}

#[tauri::command]
fn org_save(state: State<'_, AppState>, file: org::OrgFile) -> AppResult<()> {
    org::save(&state.content.root(), &file)
}

#[tauri::command]
async fn org_generate(state: State<'_, AppState>) -> AppResult<org::OrgFile> {
    // Snapshot everything we need off State synchronously; hand the
    // multi-minute Claude call to a blocking thread the same way we do
    // for parse_task so the UI stays responsive.
    let content_root = state.content.root().to_path_buf();
    let cfg = claude::load_config(&state.app_data_dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let generated = org::generate(&content_root, &cfg)?;
        org::save(&content_root, &generated)?;
        // Reload from disk so the UI sees exactly what landed on disk
        // (stripped of any fields the save path omits).
        org::load(&content_root)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

#[tauri::command]
fn content_read_file(state: State<'_, AppState>, rel_path: String) -> AppResult<DocFile> {
    state.content.read_markdown(&rel_path)
}

#[tauri::command]
fn content_write_file(
    state: State<'_, AppState>,
    rel_path: String,
    markdown: String,
) -> AppResult<SaveResult> {
    let mut db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    state.content.save_markdown(
        &rel_path,
        &markdown,
        &mut db.conn,
        &state.blobs,
        "local",
    )
}

// ====== Local network bridge (PRD-local-net) ======
//
// Lifecycle: the bridge does NOT auto-start at app boot. The user must
// flip the toggle in Settings → Local Network each session — this keeps
// the security posture explicit (no surprise open ports across reboots)
// and avoids the "axum is up but Vite isn't" half-state. ServerHandle's
// Drop impl tears down the spawned Vite child + axum runtime when
// AppState drops on app shutdown.

/// Walk up from the current executable to find the directory that contains
/// package.json (i.e. the Vite app root). In dev builds the exe is at
/// v2/app/src-tauri/target/debug/work-agent, so this resolves to v2/app/.
/// Returns None in production bundles — the bridge is dev-only.
fn find_vite_app_dir() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?;
    loop {
        if dir.join("package.json").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

#[derive(Serialize)]
struct LocalNetStatus {
    /// True iff the axum bridge + Vite proxy are currently running.
    enabled: bool,
    /// Port the Vite proxy listens on (1422). Hardcoded.
    vite_port: u16,
    /// Port the axum bridge listens on (1423). Hardcoded.
    bridge_port: u16,
    /// Best-guess LAN IP, or None when not connected to a network.
    lan_ip: Option<String>,
    /// One-shot QR-encoded setup URL with the bearer token in the query.
    /// None when no LAN IP is available or no token has been generated.
    setup_url: Option<String>,
    /// True when this build can spawn Vite (i.e. dev build with
    /// package.json reachable from the exe). Production bundles return
    /// false and the UI should hide the Enable toggle.
    available: bool,
}

fn local_net_status_snapshot(state: &AppState) -> LocalNetStatus {
    let enabled = state
        .local_net_handle
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    let token = local_network::get_token();
    let lan_ip = local_network::lan_ip().map(|ip| ip.to_string());
    let setup_url = token
        .as_deref()
        .and_then(|t| local_network::setup_url(t));
    LocalNetStatus {
        enabled,
        vite_port: local_network::VITE_PORT,
        bridge_port: local_network::BRIDGE_PORT,
        lan_ip,
        setup_url,
        available: find_vite_app_dir().is_some(),
    }
}

#[tauri::command]
fn local_net_status(state: State<'_, AppState>) -> LocalNetStatus {
    local_net_status_snapshot(&state)
}

#[tauri::command]
fn local_net_enable(state: State<'_, AppState>) -> AppResult<LocalNetStatus> {
    let vite_dir = find_vite_app_dir().ok_or_else(|| {
        AppError::InvalidState(
            "local network access is only available in development builds".into(),
        )
    })?;

    let token = local_network::ensure_token()
        .map_err(|e| AppError::InvalidState(format!("token: {e}")))?;

    let mut handle_guard = state
        .local_net_handle
        .lock()
        .map_err(|_| AppError::Poisoned)?;

    // Drop any prior handle first (its Drop impl tears down axum + Vite).
    handle_guard.take();

    let vite_child = local_network::start_vite(&vite_dir);
    if vite_child.is_none() {
        return Err(AppError::InvalidState(
            "could not spawn Vite — neither pnpm nor npm on PATH".into(),
        ));
    }
    let bridge = local_network::BridgeState {
        db: Arc::clone(&state.db),
        content: state.content.clone(),
        v1_tasks: state.v1_tasks.clone(),
        plugins: state.plugins.clone(),
        token,
    };
    *handle_guard = Some(local_network::start(bridge, vite_child));

    drop(handle_guard);
    Ok(local_net_status_snapshot(&state))
}

#[tauri::command]
fn local_net_disable(state: State<'_, AppState>) -> AppResult<LocalNetStatus> {
    let mut handle_guard = state
        .local_net_handle
        .lock()
        .map_err(|_| AppError::Poisoned)?;
    handle_guard.take(); // Drop runs stop() — kills axum + Vite.
    drop(handle_guard);
    Ok(local_net_status_snapshot(&state))
}

/// Generate a fresh bearer token, invalidating any iPad that was previously
/// paired. The user must re-scan the new QR code. Use after losing a
/// device or suspecting compromise. If the bridge is currently running,
/// restart it so the in-memory copy of the old token is replaced —
/// otherwise a leaked token would remain valid until the next toggle.
#[tauri::command]
fn local_net_rotate_token(state: State<'_, AppState>) -> AppResult<LocalNetStatus> {
    let token = local_network::rotate_token()
        .map_err(|e| AppError::InvalidState(format!("token: {e}")))?;

    let mut handle_guard = state
        .local_net_handle
        .lock()
        .map_err(|_| AppError::Poisoned)?;

    if handle_guard.is_some() {
        handle_guard.take(); // Drop tears down axum + Vite running with old token.
        let vite_dir = find_vite_app_dir().ok_or_else(|| {
            AppError::InvalidState(
                "local network access is only available in development builds".into(),
            )
        })?;
        let vite_child = local_network::start_vite(&vite_dir);
        if vite_child.is_none() {
            return Err(AppError::InvalidState(
                "could not spawn Vite — neither pnpm nor npm on PATH".into(),
            ));
        }
        let bridge = local_network::BridgeState {
            db: Arc::clone(&state.db),
            content: state.content.clone(),
            v1_tasks: state.v1_tasks.clone(),
            plugins: state.plugins.clone(),
            token,
        };
        *handle_guard = Some(local_network::start(bridge, vite_child));
    }

    drop(handle_guard);
    Ok(local_net_status_snapshot(&state))
}

#[tauri::command]
fn audit_recent(state: State<'_, AppState>, limit: Option<i64>) -> AppResult<Vec<AuditRow>> {
    let db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    audit::recent(&db.conn, limit.unwrap_or(20))
}

#[derive(Serialize)]
struct AuditVerification {
    ok: bool,
    broken_at: Option<i64>,
}

#[tauri::command]
fn audit_verify(state: State<'_, AppState>) -> AppResult<AuditVerification> {
    let db = state.db.lock().map_err(|_| AppError::Poisoned)?;
    let broken = audit::verify_chain(&db.conn)?;
    Ok(AuditVerification {
        ok: broken.is_none(),
        broken_at: broken,
    })
}

/// PRD-116 §4.6 — open a Console PTY session.
///
/// Resolves the user's `claude` binary the same way every other
/// Claude-dependent surface does, then spawns it inside a real
/// pseudo-terminal. Frontend gets back a handle it can pump
/// data/send/resize/cancel/close calls against. Audit log gets a
/// `console.open` row with mode + cwd + argv (no secrets, no token
/// counts — those will land in Phase 2.5 once stream-json is wired).
#[tauri::command]
async fn console_open(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    args: console::OpenArgs,
) -> AppResult<console::OpenResult> {
    // Capture everything the spawn_blocking task needs *before* we
    // hand off — `state` is borrowed and can't cross threads.
    let cfg = claude::load_config(&state.app_data_dir)?;
    let binary = console::resolve_claude_binary(&cfg.binary_path).ok_or_else(|| {
        AppError::NotFound(
            "claude binary not found — configure Settings → Claude".into(),
        )
    })?;
    // Default cwd is the *workspace root* (the directory above
    // content_root) so `CLAUDE.md` and `.claude/commands/` resolve.
    let cwd_default = state
        .content
        .root()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| state.content.root().to_path_buf());
    let manager = Arc::clone(&state.console);
    let app_for_spawn = app_handle.clone();
    // Inherit Settings → Claude args (model, permission-mode, effort,
    // settings, etc.) so a session opened from the Console runs with
    // the same shape as `bash bin/cos brief`. console.rs strips the
    // non-interactive subset (--print, --output-format) and lets
    // per-session OpenArgs override what's left.
    let inherited = cfg.extra_args.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.open(app_for_spawn, binary, cwd_default, inherited, args)
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    // Audit-log the session start. Best-effort: a logging failure
    // shouldn't kill an already-spawned PTY.
    if let Ok(mut db) = state.db.lock() {
        let detail = serde_json::json!({
            "mode": result.mode,
            "cwd": result.cwd,
            "binary_path": result.binary_path,
            "argv": result.argv,
        });
        let tx = db.conn.transaction().ok();
        if let Some(tx) = tx {
            let _ = audit::append(
                &tx,
                "local",
                "console.open",
                "console_session",
                &result.handle,
                &detail.to_string(),
            );
            let _ = tx.commit();
        }
    }

    Ok(result)
}

/// PRD-116 §4.6 — write bytes into the session's PTY stdin. Frontend
/// passes the raw bytes the user typed (or a control sequence like
/// `\u{0003}` for Ctrl+C). We don't audit per-keystroke; the audit
/// trail captures session start + close + cancel.
#[tauri::command]
async fn console_send(
    state: State<'_, AppState>,
    handle: console::Handle,
    bytes: Vec<u8>,
) -> AppResult<()> {
    let manager = Arc::clone(&state.console);
    tauri::async_runtime::spawn_blocking(move || manager.send(&handle, &bytes))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// PRD-116 §4.6 — resize the PTY. Called from the renderer's resize
/// observer so `claude` re-flows lines correctly.
#[tauri::command]
async fn console_resize(
    state: State<'_, AppState>,
    handle: console::Handle,
    rows: u16,
    cols: u16,
) -> AppResult<()> {
    let manager = Arc::clone(&state.console);
    tauri::async_runtime::spawn_blocking(move || manager.resize(&handle, rows, cols))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// PRD-116 §3 #11 — SIGINT then SIGKILL after 2s grace.
#[tauri::command]
async fn console_cancel(
    state: State<'_, AppState>,
    handle: console::Handle,
) -> AppResult<()> {
    let manager = Arc::clone(&state.console);
    let handle_for_audit = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || manager.cancel(&handle))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?;
    if let Ok(mut db) = state.db.lock() {
        if let Ok(tx) = db.conn.transaction() {
            let _ = audit::append(
                &tx,
                "local",
                "console.cancel",
                "console_session",
                &handle_for_audit,
                "{}",
            );
            let _ = tx.commit();
        }
    }
    res
}

/// PRD-116 §4.6 — graceful close. Removes the handle from the
/// manager's session map; subsequent send/resize/cancel calls on the
/// same handle return NotFound.
#[tauri::command]
async fn console_close(
    state: State<'_, AppState>,
    handle: console::Handle,
) -> AppResult<()> {
    let manager = Arc::clone(&state.console);
    let handle_for_audit = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || manager.close(&handle))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?;
    if let Ok(mut db) = state.db.lock() {
        if let Ok(tx) = db.conn.transaction() {
            let _ = audit::append(
                &tx,
                "local",
                "console.close",
                "console_session",
                &handle_for_audit,
                "{}",
            );
            let _ = tx.commit();
        }
    }
    res
}

/// PRD-116 Phase 2.5 — open a stream-json chat session.
///
/// Same lifecycle shape as `console_open` but spawns claude with
/// stream-json input/output enabled. Returns a chat handle the
/// frontend pumps `chat_send` / `chat_cancel` / `chat_close` against.
#[tauri::command]
async fn chat_open(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    args: chat::OpenArgs,
) -> AppResult<chat::OpenResult> {
    let cfg = claude::load_config(&state.app_data_dir)?;
    let binary = console::resolve_claude_binary(&cfg.binary_path).ok_or_else(|| {
        AppError::NotFound(
            "claude binary not found — configure Settings → Claude".into(),
        )
    })?;
    let cwd_default = state
        .content
        .root()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| state.content.root().to_path_buf());
    let content_root = state.content.root().to_path_buf();
    let manager = Arc::clone(&state.chat);
    let app_for_spawn = app_handle.clone();
    let inherited = cfg.extra_args.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        manager.open(
            app_for_spawn,
            binary,
            cwd_default,
            content_root,
            inherited,
            args,
        )
    })
    .await
    .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))??;

    if let Ok(mut db) = state.db.lock() {
        let detail = serde_json::json!({
            "cwd": result.cwd,
            "binary_path": result.binary_path,
            "argv": result.argv,
            "transport": "stream-json",
        });
        if let Ok(tx) = db.conn.transaction() {
            let _ = audit::append(
                &tx,
                "local",
                "chat.open",
                "chat_session",
                &result.handle,
                &detail.to_string(),
            );
            let _ = tx.commit();
        }
    }
    Ok(result)
}

/// Send a user-turn message to a live chat session. `text` is the
/// raw user message; the chat module wraps it in the stream-json
/// envelope claude expects on stdin.
#[tauri::command]
async fn chat_send(
    state: State<'_, AppState>,
    handle: chat::Handle,
    text: String,
) -> AppResult<()> {
    let manager = Arc::clone(&state.chat);
    tauri::async_runtime::spawn_blocking(move || manager.send_user_turn(&handle, &text))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?
}

/// SIGINT then SIGKILL after 2s grace.
#[tauri::command]
async fn chat_cancel(
    state: State<'_, AppState>,
    handle: chat::Handle,
) -> AppResult<()> {
    let manager = Arc::clone(&state.chat);
    let handle_for_audit = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || manager.cancel(&handle))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?;
    if let Ok(mut db) = state.db.lock() {
        if let Ok(tx) = db.conn.transaction() {
            let _ = audit::append(
                &tx,
                "local",
                "chat.cancel",
                "chat_session",
                &handle_for_audit,
                "{}",
            );
            let _ = tx.commit();
        }
    }
    res
}

/// PRD-116 §4.3 — discover slash commands available to the chat
/// session. Sources: workspace `.claude/commands/`, walk-up to the
/// repo root, plugin commands at `.claude/plugins/<plugin>/commands/`,
/// user `~/.claude/commands/`, plus claude built-ins.
///
/// Caller passes the cwd they're running in. Empty → workspace root.
#[tauri::command]
fn chat_slash_commands(
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> AppResult<Vec<chat::SlashCommand>> {
    let cwd_path = cwd
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            state
                .content
                .root()
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| state.content.root().to_path_buf())
        });
    Ok(chat::discover_slash_commands(&cwd_path))
}

/// Graceful close.
#[tauri::command]
async fn chat_close(
    state: State<'_, AppState>,
    handle: chat::Handle,
) -> AppResult<()> {
    let manager = Arc::clone(&state.chat);
    let handle_for_audit = handle.clone();
    let res = tauri::async_runtime::spawn_blocking(move || manager.close(&handle))
        .await
        .map_err(|e| AppError::InvalidState(format!("blocking task: {e}")))?;
    if let Ok(mut db) = state.db.lock() {
        if let Ok(tx) = db.conn.transaction() {
            let _ = audit::append(
                &tx,
                "local",
                "chat.close",
                "chat_session",
                &handle_for_audit,
                "{}",
            );
            let _ = tx.commit();
        }
    }
    res
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Customize the About menu so dev runs (not just packaged
            // builds) show the credit line. macOS's About panel reads
            // these fields when the app menu's About item is invoked.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};
                let about = AboutMetadataBuilder::new()
                    .name(Some("Chief of Staff"))
                    .version(Some(env!("CARGO_PKG_VERSION")))
                    .copyright(Some("© User"))
                    .credits(Some("Built by User with Claude Code."))
                    .build();
                // Replace just the application submenu (leftmost) so the
                // About item picks up our metadata. Falls through to
                // Tauri defaults for File/Edit/View/Window/Help.
                let app_submenu = SubmenuBuilder::new(app, "Chief of Staff")
                    .about(Some(about))
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                // Edit menu with the predefined Cocoa selectors. Without
                // this, Cmd+C/V/X/A and undo/redo don't work in a Tauri
                // webview because macOS dispatches those shortcuts
                // through the menu bar — there's no menu, so the keys
                // never reach the input. Adding this menu wires them up
                // automatically; we don't need handlers ourselves.
                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&edit_submenu)
                    .build()?;
                app.set_menu(menu)?;
            }

            let data_dir = app.path().app_data_dir()?;
            let db = Arc::new(Mutex::new(Db::open(&data_dir)?));
            // PRD-103 packaging: resolve the content root with the
            // data-dir-aware function so packaged builds find their
            // persisted choice or default to ~/Documents/Chief of
            // Staff/data/files. The task DB co-locates next to the
            // chosen content root so they travel together.
            let content_root = content::resolve_root_with_data_dir(&data_dir);
            // PRD-103 §0.3: seed starter content (READMEs +
            // .claude/commands/) the first time a fresh root is
            // resolved. No-op when the root is already populated, or
            // when the bundle resources aren't available (dev runs).
            if let Ok(resource_dir) = app.path().resource_dir() {
                let bundle_starter = resource_dir.join("starter-data");
                if let Err(err) = content::seed_starter_content(
                    &bundle_starter,
                    &content_root,
                ) {
                    eprintln!(
                        "starter content seed failed (continuing): {err:?}",
                    );
                }
            }
            let v1_tasks = V1Tasks::new(v1_tasks::resolve_path_with_content_root(
                &content_root,
            ));
            // PRD-103 fresh-install: auto-create the v1 task DB if
            // it doesn't exist yet. Without this, the Tasks surface
            // dead-ends with "v1 database not found" on the very
            // first launch — there's no way for a user to reach the
            // CLI to bootstrap it.
            if let Err(err) = v1_tasks.ensure_initialized() {
                eprintln!(
                    "v1 task DB init failed (continuing): {err:?}",
                );
            }
            let content = Content::new(content_root);
            let blobs = BlobStore::open(&data_dir.join("snapshots"))?;
            let perf_log = perf::PerfLog::open(&data_dir)?;
            // Plugin discovery scans both <app_data>/plugins/ and the
            // bundled <repo>/plugins/ when the latter is reachable
            // (dev runs from the repo, content_root resolves to
            // <repo>/data/files). The repo path falls back to None
            // gracefully — users running a packaged build with no
            // repo nearby just see the per-user dir.
            let repo_root = content
                .root()
                .parent()
                .and_then(|p| p.parent())
                .map(|p| p.to_path_buf());
            let plugins_runtime = plugins::Plugins::with_repo_root(
                &data_dir,
                repo_root.as_deref(),
            );

            // Local network bridge starts off. The user must explicitly
            // enable it from Settings → Local Network each session — no
            // surprise open ports across reboots. ServerHandle::Drop
            // tears it down on app shutdown.
            let local_net_handle: Arc<Mutex<Option<local_network::ServerHandle>>> =
                Arc::new(Mutex::new(None));

            app.manage(AppState {
                db,
                v1_tasks,
                content,
                blobs,
                perf_log,
                plugins: plugins_runtime,
                app_data_dir: data_dir,
                local_net_handle,
                console: Arc::new(console::Manager::new()),
                chat: Arc::new(chat::Manager::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_version,
            db_ping,
            secret_set,
            secret_get,
            secret_delete,
            db_encryption_status,
            db_encryption_key_ensure,
            recovery_status,
            recovery_create_phrase,
            recovery_validate_phrase,
            recovery_mark_confirmed,
            recovery_import_phrase,
            recovery_reset,
            disk_health,
            v1_tasks_status,
            v1_tasks_list,
            v1_tasks_complete,
            v1_tasks_uncomplete,
            v1_tasks_get,
            v1_tasks_update,
            v1_tasks_create,
            claude_status,
            claude_config_get,
            claude_config_set,
            claude_config_reset,
            claude_mcp_list,
            claude_ping,
            claude_parse_task,
            gh_status,
            gh_my_prs,
            gh_review_requests,
            gh_pr_ci,
            gh_pr_detail,
            gh_prs_for_author,
            ops_incidents_run,
            ops_incidents_read,
            ops_rollbar_run,
            ops_rollbar_read,
            ops_monitors_run,
            ops_monitors_read,
            jira_my_run,
            jira_my_read,
            jira_team_run,
            jira_team_read,
            planning_epics_run,
            planning_epics_read,
            planning_jpd_run,
            planning_jpd_read,
            velocity_diagnose,
            planning_epic_update,
            paging_status,
            paging_token_set,
            paging_token_clear,
            paging_oncall_now,
            paging_for_service,
            paging_user_shifts,
            content_status,
            content_root_info,
            content_root_set,
            profile_get,
            profile_set,
            profile_gitconfig_defaults,
            profile_scaffold_people,
            profile_scaffold_starter_projects,
            automation_cron_run,
            console_open,
            console_send,
            console_resize,
            console_cancel,
            console_close,
            chat_open,
            chat_send,
            chat_cancel,
            chat_close,
            chat_slash_commands,
            content_write_attachment,
            content_recent_sessions,
            content_list_projects,
            content_list_project_refs,
            content_list_project_files,
            content_project_status,
            content_list_people,
            content_attention_people,
            content_top_priorities,
            perf_record,
            perf_summaries,
            perf_clear,
            audit_restore,
            audit_filter,
            install_status,
            plugin_list,
            plugin_dir_path,
            plugin_dir_open,
            take_open_request,
            content_list_meetings,
            content_list_sessions,
            content_create_session,
            content_search,
            content_recent_briefings,
            calendar_config_get,
            calendar_config_set,
            calendar_events,
            reminders_list,
            annotations_list,
            annotations_list_pending,
            annotations_save,
            content_person_profile,
            person_refresh,
            person_prep,
            session_digest,
            annotations_process,
            morning_briefing,
            task_triage,
            weekly_review,
            publish_to_gdoc,
            content_read_file,
            content_write_file,
            org_load,
            org_save,
            org_generate,
            audit_recent,
            audit_verify,
            local_net_status,
            local_net_enable,
            local_net_disable,
            local_net_rotate_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_saved_line_extracts_path_at_end_of_output() {
        let raw = "\
Created new file with 4 agenda items and 2 coaching notes.

SAVED: data/files/areas/one-on-ones/direct-reports/alice/sessions/2026-04-25.md
";
        let (summary, path) = parse_saved_line(raw).unwrap();
        assert!(summary.contains("Created new file"));
        assert_eq!(
            path,
            "data/files/areas/one-on-ones/direct-reports/alice/sessions/2026-04-25.md"
        );
    }

    #[test]
    fn parse_saved_line_tolerates_trailing_whitespace() {
        let raw = "Updated file.\n\nSAVED:    data/files/x/y.md   \n\n";
        let (_, path) = parse_saved_line(raw).unwrap();
        assert_eq!(path, "data/files/x/y.md");
    }

    #[test]
    fn parse_saved_line_errors_when_marker_missing() {
        let err = parse_saved_line("Just a summary, no marker.").unwrap_err();
        assert!(matches!(err, AppError::InvalidState(_)));
    }

    #[test]
    fn parse_processed_ids_empty_when_marker_missing() {
        let raw = "Did some edits.\n\nSAVED: data/files/x/y.md\n";
        assert!(parse_processed_ids(raw).is_empty());
    }

    #[test]
    fn parse_processed_ids_extracts_csv() {
        let raw = "\
Applied 2 annotations.

PROCESSED: tqxnqgl7, 7vioicmo
SAVED: data/files/x/y.md
";
        assert_eq!(
            parse_processed_ids(raw),
            vec!["tqxnqgl7".to_string(), "7vioicmo".to_string()]
        );
    }

    #[test]
    fn parse_processed_ids_skips_blank_entries() {
        let raw = "PROCESSED: a,, b ,\nSAVED: x";
        assert_eq!(
            parse_processed_ids(raw),
            vec!["a".to_string(), "b".to_string()]
        );
    }
}
