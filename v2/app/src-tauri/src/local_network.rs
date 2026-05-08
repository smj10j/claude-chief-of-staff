//! Local-network HTTP bridge.
//!
//! Serves a read-only subset of IPC commands over HTTP so the app can be
//! used from a phone/tablet on the same Wi-Fi network.
//!
//! ## Topology
//!
//! Two processes run on the host machine:
//!   - axum on port 1423 — dispatches read-only IPC commands as JSON
//!   - Vite (browser-mode dev server) on port 1422 — serves the SPA and
//!     proxies `/invoke` and `/health` to axum on 127.0.0.1:1423
//!
//! The mobile device only ever talks to port 1422 (Vite). axum binds to
//! 0.0.0.0 so the spawned Vite child can reliably connect to it across
//! macOS routing quirks for child processes, but [`handle_invoke`] rejects
//! any connection whose source is not loopback (403). Direct LAN access to
//! port 1423 is therefore not possible — the only path to data is through
//! Vite's proxy on the same machine.
//!
//! ## Threat model
//!
//! * **Trusted:** the local machine, the user's keychain, the LAN's link
//!   layer (i.e. WPA2/WPA3 — we transmit the bearer token in plaintext, so
//!   open Wi-Fi is out of scope).
//! * **Read-only:** the dispatcher matches a fixed allowlist of read
//!   commands. Anything not in the list returns "unknown or write-only
//!   command" — no write/delete/network-mutation commands are reachable.
//! * **Auth:** 256-bit random bearer token in the OS keychain. Set on the
//!   iPad via a one-time setup URL embedded in a QR code. The token can
//!   be rotated via [`rotate_token`] to revoke a lost device.
//! * **Out of scope:** root on the host machine; physical access to the
//!   keychain; an attacker who already has the token (treat as compromise
//!   and rotate).

use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::{audit, org};
use crate::content::Content;
use crate::db::Db;
use crate::plugins::Plugins;
use crate::v1_tasks::V1Tasks;

// ── Constants ───────────────────────────────────────────────────────────────

/// Port the axum bridge listens on. Hardcoded because the Vite proxy
/// (vite.config.ts) targets the same value — they must match.
pub const BRIDGE_PORT: u16 = 1423;

/// Port the Vite browser-mode dev server listens on. Hardcoded for the
/// same reason; this is what the iPad connects to.
pub const VITE_PORT: u16 = 1422;

// ── Token ────────────────────────────────────────────────────────────────────

const TOKEN_SERVICE: &str = "cos-app-local-net";
const TOKEN_ACCOUNT: &str = "bridge-token";

/// Return the existing bearer token, generating + persisting a new one if
/// none is set. The token is a 64-char hex string (256 bits of entropy).
pub fn ensure_token() -> Result<String, String> {
    let entry = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT)
        .map_err(|e| format!("keyring: {e}"))?;
    match entry.get_password() {
        Ok(t) if !t.is_empty() => Ok(t),
        _ => {
            let token = generate_token()?;
            entry
                .set_password(&token)
                .map_err(|e| format!("keyring set: {e}"))?;
            Ok(token)
        }
    }
}

pub fn get_token() -> Option<String> {
    keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|t| !t.is_empty())
}

/// Replace the existing token with a freshly-generated one. Any iPad that
/// had the old token is now revoked and must re-scan the QR code.
pub fn rotate_token() -> Result<String, String> {
    let entry = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT)
        .map_err(|e| format!("keyring: {e}"))?;
    let _ = entry.delete_credential();
    let token = generate_token()?;
    entry
        .set_password(&token)
        .map_err(|e| format!("keyring set: {e}"))?;
    Ok(token)
}

fn generate_token() -> Result<String, String> {
    use std::io::Read;
    let mut f =
        std::fs::File::open("/dev/urandom").map_err(|e| format!("urandom open: {e}"))?;
    let mut bytes = [0u8; 32];
    f.read_exact(&mut bytes)
        .map_err(|e| format!("urandom read: {e}"))?;
    Ok(hex::encode(bytes))
}

// ── Network helpers ──────────────────────────────────────────────────────────

/// Best-guess primary LAN IP via the UDP-connect trick (no packet sent —
/// the kernel resolves which interface would be used to reach the public
/// address and reports its local IP).
pub fn lan_ip() -> Option<IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

/// One-shot setup URL the iPad scans. Format:
///   `http://<lan-ip>:1422?setup=<token>&api=http://<lan-ip>:1422`
/// The shim reads both params, persists them to localStorage, then strips
/// the query string from the URL bar.
pub fn setup_url(token: &str) -> Option<String> {
    let ip = lan_ip()?;
    Some(format!(
        "http://{ip}:{VITE_PORT}?setup={token}&api=http://{ip}:{VITE_PORT}"
    ))
}

/// Constant-time string compare. Returns false immediately on length
/// mismatch — token length is fixed (64 hex chars) so this leak is
/// acceptable.
fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

// ── Bridge state ─────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct BridgeState {
    pub db: Arc<Mutex<Db>>,
    pub content: Content,
    pub v1_tasks: V1Tasks,
    pub plugins: Plugins,
    pub token: String,
}

// ── Server handle ─────────────────────────────────────────────────────────────

pub struct ServerHandle {
    shutdown_tx: Option<oneshot::Sender<()>>,
    vite_child: Option<std::process::Child>,
}

impl ServerHandle {
    /// Stop the axum runtime and tear down the Vite child process tree.
    /// Idempotent — safe to call multiple times.
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(mut child) = self.vite_child.take() {
            // pnpm wraps node, so `child.kill()` would only reap the pnpm
            // shell — the actual vite/node process would survive as an
            // orphan. SIGTERM to all children of pnpm first, then SIGKILL
            // pnpm itself.
            let pid = child.id().to_string();
            let _ = std::process::Command::new("pkill")
                .args(["-TERM", "-P", &pid])
                .status();
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ServerHandle {
    /// Ensure cleanup runs even if the handle is dropped without an explicit
    /// `stop()` (e.g. when AppState drops on Tauri shutdown).
    fn drop(&mut self) {
        self.stop();
    }
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct InvokeRequest {
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn handle_health() -> StatusCode {
    StatusCode::OK
}

async fn handle_invoke(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(req): Json<InvokeRequest>,
) -> (StatusCode, Json<Value>) {
    // axum binds to 0.0.0.0 so the Vite child process can reach us
    // reliably, but we only ever want to serve the local Vite proxy.
    // Anything from a non-loopback source is a direct LAN attempt — refuse
    // it before doing anything else, including auth (no token oracle).
    if !addr.ip().is_loopback() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "forbidden" })),
        );
    }

    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");

    if !ct_eq(auth, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        );
    }

    match dispatch(state, &req.cmd, req.args).await {
        Ok(data) => (StatusCode::OK, Json(serde_json::json!({ "data": data }))),
        // Return 200 for the unknown-command case so the client's JSON
        // error handler fires (a 500 trips the httpInvoke `res.ok` guard
        // before JSON is parsed and surfaces as a generic fetch error).
        Err(e) if e.starts_with("unknown or write-only command") => {
            (StatusCode::OK, Json(serde_json::json!({ "error": e })))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

/// Tauri's IPC layer converts camelCase JS keys → snake_case Rust params.
/// The HTTP bridge receives raw JSON so we must do the same fallback when
/// reading args, otherwise frontend code that works in Tauri mode breaks
/// in browser mode.
fn snake_to_camel(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut up = false;
    for c in s.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.push(c.to_ascii_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

fn str_arg<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key)
        .or_else(|| args.get(snake_to_camel(key).as_str()))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn usize_arg(args: &Value, key: &str, default: u64) -> usize {
    let v = args.get(key).or_else(|| args.get(snake_to_camel(key).as_str()));
    v.and_then(Value::as_u64).unwrap_or(default) as usize
}

fn i64_arg(args: &Value, key: &str, default: i64) -> i64 {
    let v = args.get(key).or_else(|| args.get(snake_to_camel(key).as_str()));
    v.and_then(Value::as_i64).unwrap_or(default)
}

/// Dispatch a single read-only command. The match arms here are the
/// authoritative allowlist — any command not listed returns
/// "unknown or write-only command" and is unreachable from the bridge.
async fn dispatch(state: BridgeState, cmd: &str, args: Value) -> Result<Value, String> {
    match cmd {
        // ── Tasks ──
        "v1_tasks_list" => state
            .v1_tasks
            .list_active()
            .map_err(|e| format!("{e}"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}"))),

        "v1_tasks_get" => {
            let id = str_arg(&args, "id").to_string();
            state
                .v1_tasks
                .get_task(&id)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "v1_tasks_status" => serde_json::to_value(state.v1_tasks.status())
            .map_err(|e| format!("{e}")),

        // ── Content ──
        "content_status" => serde_json::to_value(state.content.status())
            .map_err(|e| format!("{e}")),

        "content_list_projects" => state
            .content
            .list_projects()
            .map_err(|e| format!("{e}"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}"))),

        "content_list_project_refs" => state
            .content
            .list_project_refs()
            .map_err(|e| format!("{e}"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}"))),

        "content_list_project_files" => {
            let rel = str_arg(&args, "rel_path").to_string();
            state
                .content
                .list_project_files(&rel)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_list_people" => state
            .content
            .list_people()
            .map_err(|e| format!("{e}"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}"))),

        "content_list_meetings" => state
            .content
            .list_meetings()
            .map_err(|e| format!("{e}"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}"))),

        "content_list_sessions" => {
            let rel = str_arg(&args, "rel_path").to_string();
            let limit = usize_arg(&args, "limit", 0);
            state
                .content
                .list_sessions_in(&rel, limit)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_recent_sessions" => {
            let limit = usize_arg(&args, "limit", 10);
            state
                .content
                .recent_sessions(limit)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_recent_briefings" => {
            let limit = usize_arg(&args, "limit", 7);
            state
                .content
                .recent_briefings(limit)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_read_file" => {
            let rel = str_arg(&args, "rel_path").to_string();
            state
                .content
                .read_markdown(&rel)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_person_profile" => {
            let rel = str_arg(&args, "rel_path").to_string();
            let limit = usize_arg(&args, "limit", 10);
            state
                .content
                .read_person_profile(&rel, limit)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_attention_people" => {
            let today = str_arg(&args, "today").to_string();
            let stale_days = i64_arg(&args, "stale_days", 14);
            state
                .content
                .list_attention_people(&today, stale_days)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_project_status" => {
            let today = str_arg(&args, "today").to_string();
            state
                .content
                .compute_project_statuses(&today)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_top_priorities" => {
            let today = str_arg(&args, "today").to_string();
            let cap = usize_arg(&args, "limit", 3);
            state
                .content
                .top_priorities_from_briefing(&today, cap)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "content_search" => {
            let query = str_arg(&args, "query").to_string();
            let limit = usize_arg(&args, "limit", 20);
            let content = state.content.clone();
            tokio::task::spawn_blocking(move || content.search(&query, limit))
                .await
                .map_err(|e| format!("task: {e}"))?
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        // ── Org ──
        "org_load" => {
            let root = state.content.root().to_path_buf();
            org::load(&root)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        // ── Audit ──
        "audit_recent" => {
            let limit = i64_arg(&args, "limit", 20);
            let db = state.db.lock().map_err(|_| "db poisoned".to_string())?;
            audit::recent(&db.conn, limit)
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        "audit_filter" => {
            let action_prefix = str_arg(&args, "action_prefix").to_string();
            let target_query = str_arg(&args, "target_query").to_string();
            let from_iso = args
                .get("from_iso")
                .and_then(Value::as_str)
                .map(str::to_string);
            let to_iso = args
                .get("to_iso")
                .and_then(Value::as_str)
                .map(str::to_string);
            let limit = i64_arg(&args, "limit", 50);
            let db = state.db.lock().map_err(|_| "db poisoned".to_string())?;
            audit::filter(
                &db.conn,
                &action_prefix,
                &target_query,
                from_iso.as_deref(),
                to_iso.as_deref(),
                limit,
            )
            .map_err(|e| format!("{e}"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        // ── DB ──
        "db_ping" => {
            let db = state.db.lock().map_err(|_| "db poisoned".to_string())?;
            db.ping()
                .map_err(|e| format!("{e}"))
                .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}")))
        }

        // ── Plugins ──
        "plugin_list" => state
            .plugins
            .list()
            .map_err(|e| format!("{e}"))
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("{e}"))),

        // ── Cached JSON snapshots (file reads, no network) ──
        "jira_my_read"
        | "jira_team_read"
        | "planning_epics_read"
        | "planning_jpd_read"
        | "ops_incidents_read"
        | "ops_rollbar_read"
        | "ops_monitors_read" => {
            let rel = match cmd {
                "jira_my_read" => "areas/work/my-jira.json",
                "jira_team_read" => "areas/work/team-jira.json",
                "planning_epics_read" => "areas/planning/epics.json",
                "planning_jpd_read" => "areas/planning/jpd.json",
                "ops_incidents_read" => "areas/ops/incidents.json",
                "ops_rollbar_read" => "areas/ops/rollbar.json",
                "ops_monitors_read" => "areas/ops/monitors.json",
                _ => unreachable!(),
            };
            let path = state.content.root().join(rel);
            if !path.exists() {
                return Ok(Value::Null);
            }
            let text =
                std::fs::read_to_string(&path).map_err(|e| format!("io: {e}"))?;
            serde_json::from_str(&text).map_err(|e| format!("json: {e}"))
        }

        // Calendar requires macOS EventKit / ICS access — not available on a
        // remote browser session. Return an empty list so the surface renders
        // cleanly rather than throwing an error.
        "calendar_events" => Ok(serde_json::json!([])),

        _ => Err(format!("unknown or write-only command: {cmd}")),
    }
}

// ── Server start/stop ─────────────────────────────────────────────────────────

/// Spawn a Vite dev server in browser mode (port 1422) from the given app
/// dir. Returns None if neither pnpm nor npm is on PATH, or if the spawn
/// fails for any other reason. The caller is expected to handle that
/// gracefully (the bridge is dev-only).
pub fn start_vite(app_dir: &Path) -> Option<std::process::Child> {
    for pkg in &["pnpm", "npm"] {
        let result = std::process::Command::new(pkg)
            .args(["run", "dev"])
            .env("VITE_BROWSER_MODE", "true")
            .current_dir(app_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn();
        match result {
            Ok(child) => {
                eprintln!("[local-net] vite started with {pkg} in {}", app_dir.display());
                return Some(child);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                eprintln!("[local-net] vite spawn error: {e}");
                return None;
            }
        }
    }
    eprintln!("[local-net] neither pnpm nor npm found on PATH");
    None
}

/// Start the axum server and return a handle that owns both the shutdown
/// channel and the Vite child (if any). Dropping the handle stops both.
pub fn start(state: BridgeState, vite_child: Option<std::process::Child>) -> ServerHandle {
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("[local-net] tokio runtime");
        rt.block_on(async move {
            // Bind to all interfaces so the Vite child process can reach us
            // reliably across macOS routing quirks for child processes.
            // Direct LAN access is rejected at the application layer by
            // handle_invoke's loopback filter; /health is an unauthenticated
            // liveness probe with no body.
            let addr = format!("0.0.0.0:{BRIDGE_PORT}");
            let listener = match tokio::net::TcpListener::bind(&addr).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[local-net] bind {addr}: {e}");
                    return;
                }
            };
            eprintln!("[local-net] listening on {addr}");
            let router = Router::new()
                .route("/health", get(handle_health))
                .route("/invoke", post(handle_invoke))
                .with_state(state);
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                shutdown_rx.await.ok();
            })
            .await;
            eprintln!("[local-net] stopped");
        });
    });

    ServerHandle {
        shutdown_tx: Some(shutdown_tx),
        vite_child,
    }
}
