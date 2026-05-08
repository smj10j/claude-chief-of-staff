//! PRD-116 Phase 2.5 — stream-json chat transport.
//!
//! Spawns the user's local `claude` binary with
//! `--print --output-format stream-json --input-format stream-json
//! --verbose` and ferries structured events between the child and the
//! frontend. This is the structured counterpart to `console.rs`'s raw
//! PTY transport — both share the same `Manager`-style lifecycle but
//! emit different event shapes.
//!
//! Wire protocol (from claude → us, NDJSON):
//!   * `system` (subtype: "init")    — session metadata: session_id,
//!     cwd, model, permissionMode, mcp_servers, tools.
//!   * `assistant` / `user`           — message events: each carries a
//!     `message` object with role + structured content. We forward
//!     these untouched so the frontend can render them.
//!   * `result` (subtype: "success") — terminal: total cost,
//!     usage, duration. Emitted at the end of each turn.
//!
//! Wire protocol (from us → claude, NDJSON on stdin):
//!   * `{"type":"user","message":{"role":"user","content":"<text>"}}`
//!     — sends a user turn. We wrap text in this envelope.
//!
//! Multi-turn: with stream-json input *and* output enabled, claude's
//! `--print` mode keeps the session alive between turns. The
//! `session_id` from the first `system.init` event is what the
//! `--resume <id>` flag takes for cross-restart resume.
//!
//! Why not reuse `console.rs`? Two reasons:
//!   1. The PTY-vs-pipes distinction is real: stream-json wants
//!      proper pipes (no PTY echo, no terminal control sequences).
//!   2. Event parsing + emission is materially different from the
//!      raw byte stream — keeping them in separate modules avoids
//!      accidental cross-pollination of "is this UTF-8" / "should
//!      we wrap output" concerns.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

// PRD-116 §4.5 — paired transcript files. Workspace-rooted.
const TRANSCRIPT_DIR: &str = "areas/console-sessions/sessions";

/// Opaque handle, format `chat-<n>`. Distinct prefix from
/// `console-<n>` so frontend code can route events without ambiguity.
pub type Handle = String;

/// Args the frontend passes when opening a chat session. Mirrors
/// `console::OpenArgs` but without rows/cols (no PTY).
#[derive(Debug, Clone, Deserialize)]
pub struct OpenArgs {
    /// Working directory. Empty → workspace root from caller.
    #[serde(default)]
    pub cwd: String,
    /// `--model <id>` override. Empty → claude's default.
    #[serde(default)]
    pub model: String,
    /// `--permission-mode <mode>` override. Empty → claude's default.
    /// Phase 2.5 ships without inline approval cards, so callers
    /// should default to `acceptEdits` (loose) or `plan` (safe);
    /// `default` is technically supported but the user has no UI to
    /// approve mid-turn yet.
    #[serde(default)]
    pub permission_mode: String,
    /// `--resume <id>` to continue a prior session.
    #[serde(default)]
    pub resume_id: String,
    /// Filesystem path of an existing `.jsonl` transcript that
    /// should keep getting appended to instead of opening a fresh
    /// pair. Used for resume — caller passes the .jsonl path; we
    /// append events as they arrive. The caller is also expected to
    /// pass `resume_id` so claude continues the same conversation.
    /// PRD §4.5.
    #[serde(default)]
    pub transcript_path: String,
}

/// Snapshot returned to the frontend at open time so the chip row
/// can render before the first `system.init` event arrives.
#[derive(Debug, Clone, Serialize)]
pub struct OpenResult {
    pub handle: Handle,
    pub binary_path: String,
    pub cwd: String,
    pub argv: Vec<String>,
    /// Workspace-relative path of the `.md` transcript file. The
    /// `.jsonl` companion lives at the same path with the extension
    /// swapped. Both are created lazily on first event so an
    /// immediately-canceled session doesn't leave empty files
    /// behind. None until the first event arrives.
    pub transcript_md_rel: Option<String>,
}

/// Live chat session. The reader thread parses NDJSON off stdout
/// and re-emits each event to the frontend. The writer (`stdin`)
/// stays here so `send()` can write a user-turn envelope without
/// fighting the reader for ownership.
struct Session {
    #[allow(dead_code)]
    cwd: String,
    #[allow(dead_code)]
    argv: Vec<String>,
    stdin: ChildStdin,
    child: Child,
    reaper_done: Arc<Mutex<bool>>,
    /// Shared transcript writer the reader thread appends to. The
    /// `send_user_turn` path also writes to it so user turns land
    /// in the .md / .jsonl as soon as they leave our process. None
    /// only when transcript creation failed at open time (rare;
    /// we'd rather degrade than refuse to spawn).
    transcript: Option<Arc<Mutex<TranscriptWriter>>>,
}

/// Paired-file transcript writer. PRD §4.5:
///   * `.md`  — human-readable (the artifact in Recents + search)
///   * `.jsonl` — every event verbatim (resume + replay source-of-truth)
///
/// We open both files on first event so an immediately-canceled
/// session doesn't leave empty files behind. Frontmatter for the
/// `.md` is written on the first call too — subsequent calls just
/// append per-turn sections.
struct TranscriptWriter {
    md_path: PathBuf,
    jsonl_path: PathBuf,
    /// Set after the frontmatter is written (idempotent guard).
    initialized: bool,
    /// Cached metadata used in the frontmatter on first init.
    started_iso: String,
    cwd: String,
    /// argv we spawned with — useful for replay debugging.
    argv: Vec<String>,
    /// Updated on every system.init / result event so close() can
    /// patch the frontmatter with end time + final cost. Phase-3
    /// "good enough" — we just append a closing block rather than
    /// rewriting the file.
    last_session_id: Option<String>,
    last_model: Option<String>,
}

impl TranscriptWriter {
    fn new(
        md_path: PathBuf,
        jsonl_path: PathBuf,
        cwd: String,
        argv: Vec<String>,
    ) -> Self {
        let started_iso = chrono_like_iso();
        Self {
            md_path,
            jsonl_path,
            initialized: false,
            started_iso,
            cwd,
            argv,
            last_session_id: None,
            last_model: None,
        }
    }

    /// Make sure the parent dir exists + write frontmatter once.
    fn ensure_initialized(&mut self) -> std::io::Result<()> {
        if self.initialized {
            return Ok(());
        }
        if let Some(parent) = self.md_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut md = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.md_path)?;
        let frontmatter = format!(
            "---\n\
             type: console-session\n\
             started: {started}\n\
             cwd: {cwd}\n\
             argv: {argv}\n\
             resume_authoritative: jsonl\n\
             ---\n\n\
             # Console session\n\n\
             _Started {started}._\n\n",
            started = self.started_iso,
            cwd = escape_yaml(&self.cwd),
            argv = serde_json::to_string(&self.argv)
                .unwrap_or_else(|_| "[]".to_string()),
        );
        md.write_all(frontmatter.as_bytes())?;
        // Touch the .jsonl file so the frontend can resolve its
        // path for resume even if no events have arrived yet.
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.jsonl_path)?;
        self.initialized = true;
        Ok(())
    }

    /// Append a JSON event to the .jsonl + a humanized form to the
    /// .md. We call this for every stream event the reader sees.
    fn write_event(&mut self, event: &Value) -> std::io::Result<()> {
        self.ensure_initialized()?;
        // .jsonl: one event per line, verbatim.
        let mut jsonl = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.jsonl_path)?;
        jsonl.write_all(event.to_string().as_bytes())?;
        jsonl.write_all(b"\n")?;
        // .md: humanized append. Lossy on tool args — the .jsonl is
        // the source of truth for replay.
        if let Some(md_chunk) = event_to_markdown(event) {
            let mut md = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.md_path)?;
            md.write_all(md_chunk.as_bytes())?;
        }
        // Track session id + model for the close-block.
        let ty = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ty == "system" {
            if let Some(s) = event.get("session_id").and_then(|v| v.as_str()) {
                self.last_session_id = Some(s.to_string());
            }
            if let Some(m) = event.get("model").and_then(|v| v.as_str()) {
                self.last_model = Some(m.to_string());
            }
        }
        Ok(())
    }

    /// Append a user turn (text we're sending to claude) to both
    /// files. We don't see these as "user" events on stdout because
    /// they're our own input — but they belong in the transcript.
    fn write_user_turn(&mut self, text: &str) -> std::io::Result<()> {
        self.ensure_initialized()?;
        let mut jsonl = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.jsonl_path)?;
        let envelope = serde_json::json!({
            "type": "user",
            "_origin": "local",
            "message": {
                "role": "user",
                "content": text,
            }
        });
        jsonl.write_all(envelope.to_string().as_bytes())?;
        jsonl.write_all(b"\n")?;
        let mut md = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.md_path)?;
        write!(md, "## You\n\n{}\n\n", text.trim())?;
        Ok(())
    }
}

/// Map a stream-json event to a markdown chunk. None for events
/// that don't add user-visible content (e.g., system.init metadata
/// already lives in the frontmatter).
fn event_to_markdown(event: &Value) -> Option<String> {
    let ty = event.get("type").and_then(|v| v.as_str())?;
    match ty {
        "assistant" => {
            let content = event.get("message")?.get("content")?;
            let mut out = String::from("## Claude\n\n");
            if let Some(s) = content.as_str() {
                out.push_str(s);
                out.push_str("\n\n");
                return Some(out);
            }
            if let Some(arr) = content.as_array() {
                let mut wrote_any = false;
                for block in arr {
                    let bt = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if bt == "text" {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                out.push_str(text);
                                out.push_str("\n\n");
                                wrote_any = true;
                            }
                        }
                    } else if bt == "tool_use" {
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool");
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let input = block
                            .get("input")
                            .map(|v| serde_json::to_string(v).unwrap_or_default())
                            .unwrap_or_default();
                        out.push_str(&format!(
                            "```claude-tool\nname: {name}\nid: {id}\ninput: {input}\n```\n\n",
                        ));
                        wrote_any = true;
                    } else if bt == "thinking" {
                        if let Some(text) = block.get("thinking").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                out.push_str(&format!(
                                    "<details><summary>thinking</summary>\n\n{text}\n\n</details>\n\n",
                                ));
                                wrote_any = true;
                            }
                        }
                    }
                }
                if wrote_any {
                    return Some(out);
                }
            }
            None
        }
        "user" => {
            // Only write user events that carry tool_results — direct
            // user turns are written via `write_user_turn`.
            let content = event.get("message")?.get("content")?;
            let arr = content.as_array()?;
            let mut out = String::new();
            for block in arr {
                if block.get("type").and_then(|v| v.as_str()) == Some("tool_result") {
                    let id = block
                        .get("tool_use_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let is_error = block
                        .get("is_error")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let body = block.get("content");
                    let text = match body {
                        Some(v) if v.is_string() => v.as_str().unwrap().to_string(),
                        Some(v) => v.to_string(),
                        None => String::new(),
                    };
                    out.push_str(&format!(
                        "```claude-tool-result\nid: {id}\nerror: {is_error}\n---\n{text}\n```\n\n",
                    ));
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        "result" => {
            let cost = event
                .get("total_cost_usd")
                .and_then(|v| v.as_f64())
                .map(|c| format!("${c:.4}"))
                .unwrap_or_else(|| "-".into());
            let usage = event.get("usage");
            let inp = usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(|v| v.as_i64())
                .unwrap_or(-1);
            let outp = usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(|v| v.as_i64())
                .unwrap_or(-1);
            Some(format!(
                "_Turn complete · cost {cost} · tokens in {inp} / out {outp}._\n\n",
            ))
        }
        _ => None,
    }
}

/// Slugify a string for use in the transcript filename. Lowercase,
/// kebab-case, alphanumeric + hyphens, truncated to ~50 chars.
/// Reserved for the Phase 3 follow-up that adds a slug suffix once
/// we have the first user turn (see `compute_transcript_paths`).
#[allow(dead_code)]
pub fn slugify_for_transcript(text: &str) -> String {
    let mut out = String::new();
    let mut last_was_dash = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                out.push(lc);
            }
            last_was_dash = false;
        } else if !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    trimmed.chars().take(50).collect()
}

/// Build the workspace-relative transcript path.
/// Form: `areas/console-sessions/sessions/YYYY-MM-DD-HHMM.md`
/// (we add a slug suffix once we have the first user turn — Phase 3
/// follow-up. For now we use a counter suffix to avoid collisions.)
fn compute_transcript_paths(
    content_root: &Path,
    counter: u64,
) -> (PathBuf, PathBuf, String) {
    let dir = content_root.join(TRANSCRIPT_DIR);
    let stamp = current_timestamp();
    let stem = format!("{stamp}-c{counter}");
    let md_rel = format!("{TRANSCRIPT_DIR}/{stem}.md");
    let md_path = dir.join(format!("{stem}.md"));
    let jsonl_path = dir.join(format!("{stem}.jsonl"));
    (md_path, jsonl_path, md_rel)
}

/// Local timestamp suitable for filenames: `YYYY-MM-DD-HHMM`. We
/// don't pull a chrono crate just for this; SystemTime + a tiny
/// formatter is enough for filenames.
fn current_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    civil_local_timestamp(secs)
}

/// ISO-8601 with seconds, suitable for the frontmatter `started`
/// field. Local time (matches the user's expectation when they read
/// the transcript later).
fn chrono_like_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    civil_local_iso(secs)
}

/// Convert a unix timestamp to `YYYY-MM-DD-HHMM` local time. We
/// inline a simplified version of the calendar math rather than
/// pulling chrono; this only handles dates 1970..2100 which is
/// fine for transcript filenames.
fn civil_local_timestamp(secs: i64) -> String {
    let (y, m, d, h, min, _s) = civil_from_unix(secs + local_offset_secs());
    format!("{y:04}-{m:02}-{d:02}-{h:02}{min:02}")
}

fn civil_local_iso(secs: i64) -> String {
    let (y, m, d, h, min, s) = civil_from_unix(secs + local_offset_secs());
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}")
}

/// Best-effort local offset from UTC. Calls `localtime_r` indirectly
/// via the system's tz database; falls back to 0 if unavailable.
fn local_offset_secs() -> i64 {
    // Use libc's `localtime_r` to get tm_gmtoff. macOS / Linux
    // both expose this. Wrapped in unsafe + a probe so we don't
    // panic on platforms that don't.
    #[cfg(unix)]
    unsafe {
        use std::time::{SystemTime, UNIX_EPOCH};
        #[repr(C)]
        struct Tm {
            tm_sec: i32,
            tm_min: i32,
            tm_hour: i32,
            tm_mday: i32,
            tm_mon: i32,
            tm_year: i32,
            tm_wday: i32,
            tm_yday: i32,
            tm_isdst: i32,
            tm_gmtoff: i64,
            tm_zone: *const i8,
        }
        extern "C" {
            fn localtime_r(time: *const i64, tm: *mut Tm) -> *mut Tm;
        }
        let mut tm: Tm = std::mem::zeroed();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        if !localtime_r(&now, &mut tm).is_null() {
            return tm.tm_gmtoff;
        }
        0
    }
    #[cfg(not(unix))]
    {
        0
    }
}

fn civil_from_unix(secs_local: i64) -> (i32, u32, u32, u32, u32, u32) {
    // Days since 1970-01-01.
    let total_secs = secs_local.rem_euclid(86_400);
    let days = secs_local.div_euclid(86_400);
    let hour = (total_secs / 3600) as u32;
    let min = ((total_secs / 60) % 60) as u32;
    let sec = (total_secs % 60) as u32;
    let (y, m, d) = days_to_ymd(days);
    (y, m, d, hour, min, sec)
}

/// Howard Hinnant's days_from_civil inverse — translates a
/// signed-day count from the proleptic Gregorian epoch (1970-01-01)
/// to (year, month, day). Verified against `date` shell output for
/// 2020..2030.
fn days_to_ymd(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

fn escape_yaml(s: &str) -> String {
    if s.contains(':') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

#[derive(Default)]
pub struct Manager {
    inner: Mutex<ManagerInner>,
}

#[derive(Default)]
struct ManagerInner {
    sessions: HashMap<Handle, Session>,
    counter: u64,
}

/// Build the argv we hand to claude. Order:
///   1. `--print` (required for stream-json mode)
///   2. `--output-format stream-json`
///   3. `--input-format stream-json`
///   4. `--verbose` (system.init events only emit with --verbose)
///   5. user-supplied model/permission-mode/resume overrides
///   6. `inherited_args` from Settings → Claude (filtered)
pub fn build_argv(args: &OpenArgs, inherited: &[String]) -> Vec<String> {
    let mut argv = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
    if !args.model.trim().is_empty() {
        argv.push("--model".into());
        argv.push(args.model.trim().into());
    }
    if !args.permission_mode.trim().is_empty() {
        argv.push("--permission-mode".into());
        argv.push(args.permission_mode.trim().into());
    }
    if !args.resume_id.trim().is_empty() {
        argv.push("--resume".into());
        argv.push(args.resume_id.trim().into());
    }
    // Extras the user has saved (--effort xhigh, --settings, etc.).
    // We strip the flags chat mode owns to avoid duplicates.
    let owned_flags = [
        "--print",
        "-p",
        "--output-format",
        "--input-format",
        "--verbose",
    ];
    let owned_overrides_flags = [
        ("--model", !args.model.trim().is_empty()),
        ("--permission-mode", !args.permission_mode.trim().is_empty()),
        ("--resume", !args.resume_id.trim().is_empty()),
    ];
    let value_flags = [
        "--model",
        "--permission-mode",
        "--effort",
        "--settings",
        "--resume",
        "--output-format",
        "--input-format",
    ];
    let mut iter = inherited.iter();
    while let Some(arg) = iter.next() {
        let (flag_part, has_eq) = match arg.split_once('=') {
            Some((f, _v)) => (f, true),
            None => (arg.as_str(), false),
        };
        if owned_flags.contains(&flag_part) {
            if !has_eq && value_flags.contains(&flag_part) {
                let _ = iter.next();
            }
            continue;
        }
        if owned_overrides_flags
            .iter()
            .any(|(f, set)| *set && *f == flag_part)
        {
            if !has_eq && value_flags.contains(&flag_part) {
                let _ = iter.next();
            }
            continue;
        }
        argv.push(arg.clone());
    }
    argv
}

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a chat-mode `claude`. Returns a handle the frontend can
    /// pump send/cancel/close calls against.
    ///
    /// `content_root` is the user's data folder (where `areas/`
    /// lives). The `.md` + `.jsonl` transcript pair is created under
    /// `<content_root>/areas/console-sessions/sessions/`.
    pub fn open(
        &self,
        app: AppHandle,
        binary: PathBuf,
        cwd_default: PathBuf,
        content_root: PathBuf,
        inherited_args: Vec<String>,
        args: OpenArgs,
    ) -> AppResult<OpenResult> {
        let cwd = if args.cwd.trim().is_empty() {
            cwd_default
        } else {
            PathBuf::from(args.cwd.trim())
        };
        if !cwd.is_dir() {
            return Err(AppError::NotFound(format!(
                "cwd does not exist: {}",
                cwd.display()
            )));
        }
        let argv = build_argv(&args, &inherited_args);
        let mut cmd = Command::new(&binary);
        cmd.current_dir(&cwd);
        cmd.args(&argv);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        // Inherit a sane PATH so claude's child tools (bash, gh, git)
        // resolve. Tauri apps launched from Finder lose user-shell
        // PATH augmentations.
        if let Ok(p) = std::env::var("PATH") {
            let extra = binary.parent().map(|p| p.display().to_string());
            let merged = match extra {
                Some(d) if !p.split(':').any(|x| x == d) => format!("{d}:{p}"),
                _ => p,
            };
            cmd.env("PATH", merged);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::InvalidState(format!("spawn claude: {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::InvalidState("no stdin pipe".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::InvalidState("no stdout pipe".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::InvalidState("no stderr pipe".into()))?;

        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        inner.counter = inner.counter.wrapping_add(1);
        let handle: Handle = format!("chat-{}", inner.counter);

        let reaper_done = Arc::new(Mutex::new(false));

        // Set up the transcript writer. PRD §4.5 — paired .md/.jsonl
        // files. If the caller passed `transcript_path` we resume by
        // appending to that .jsonl; otherwise compute a fresh pair.
        let (md_path, jsonl_path, md_rel) =
            if !args.transcript_path.trim().is_empty() {
                let resume_path = PathBuf::from(args.transcript_path.trim());
                // The caller passes the .jsonl path; the .md sibling
                // shares the stem.
                let md = resume_path.with_extension("md");
                let rel = md
                    .strip_prefix(&content_root)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| md.to_string_lossy().to_string());
                (md, resume_path, rel)
            } else {
                compute_transcript_paths(&content_root, inner.counter)
            };
        let writer = TranscriptWriter::new(
            md_path,
            jsonl_path,
            cwd.display().to_string(),
            argv.clone(),
        );
        let transcript = Arc::new(Mutex::new(writer));

        // stdout reader: NDJSON → typed events → frontend + transcript.
        {
            let app = app.clone();
            let handle = handle.clone();
            let reaper_done = Arc::clone(&reaper_done);
            let transcript_for_reader = Arc::clone(&transcript);
            thread::Builder::new()
                .name(format!("chat-reader-{handle}"))
                .spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        if line.trim().is_empty() {
                            continue;
                        }
                        // Parse to a Value first; if it's not JSON, emit
                        // a "raw" event so the frontend can surface the
                        // diagnostic (claude sometimes prints non-JSON
                        // banners during a launch failure).
                        let event: Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => serde_json::json!({
                                "type": "raw",
                                "line": line,
                            }),
                        };
                        if let Ok(mut w) = transcript_for_reader.lock() {
                            let _ = w.write_event(&event);
                        }
                        let _ = app.emit(
                            &format!("chat:{handle}:event"),
                            event,
                        );
                    }
                    if let Ok(mut g) = reaper_done.lock() {
                        *g = true;
                    }
                    let _ = app.emit(
                        &format!("chat:{handle}:exit"),
                        serde_json::json!({"reason": "eof"}),
                    );
                })
                .map_err(|e| AppError::InvalidState(format!("spawn reader: {e}")))?;
        }

        // stderr forwarder: emit as "stderr" events so the frontend
        // can surface launch errors as a red-edged banner. Without
        // this, a bad --model spelling fails silently from the user's
        // POV (claude exits before any stdout JSON arrives).
        {
            let app = app.clone();
            let handle = handle.clone();
            thread::Builder::new()
                .name(format!("chat-stderr-{handle}"))
                .spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        let _ = app.emit(
                            &format!("chat:{handle}:stderr"),
                            line,
                        );
                    }
                })
                .map_err(|e| AppError::InvalidState(format!("spawn stderr reader: {e}")))?;
        }

        let result = OpenResult {
            handle: handle.clone(),
            binary_path: binary.display().to_string(),
            cwd: cwd.display().to_string(),
            argv: argv.clone(),
            transcript_md_rel: Some(md_rel),
        };
        inner.sessions.insert(
            handle,
            Session {
                cwd: cwd.display().to_string(),
                argv,
                stdin,
                child,
                reaper_done,
                transcript: Some(transcript),
            },
        );
        Ok(result)
    }

    /// Send a user-turn envelope to the child's stdin. `text` is the
    /// raw user message (markdown OK; claude renders it as input). We
    /// JSON-encode the wrapper here so callers don't need to know
    /// the protocol shape.
    pub fn send_user_turn(&self, handle: &Handle, text: &str) -> AppResult<()> {
        let envelope = build_user_envelope(text);
        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        let s = inner
            .sessions
            .get_mut(handle)
            .ok_or_else(|| AppError::NotFound(format!("chat session {handle}")))?;
        if let Ok(g) = s.reaper_done.lock() {
            if *g {
                return Err(AppError::InvalidState("session has exited".into()));
            }
        }
        // Write to the transcript before the wire write so the user
        // turn lands on disk even if stdin EAGAIN's. Best-effort:
        // a transcript failure shouldn't block the conversation.
        if let Some(t) = &s.transcript {
            if let Ok(mut w) = t.lock() {
                let _ = w.write_user_turn(text);
            }
        }
        // The wire format is one JSON object per line.
        s.stdin
            .write_all(envelope.as_bytes())
            .map_err(|e| AppError::InvalidState(format!("write: {e}")))?;
        s.stdin
            .write_all(b"\n")
            .map_err(|e| AppError::InvalidState(format!("write nl: {e}")))?;
        s.stdin
            .flush()
            .map_err(|e| AppError::InvalidState(format!("flush: {e}")))?;
        Ok(())
    }

    /// SIGINT then SIGKILL after a 2s grace.
    pub fn cancel(&self, handle: &Handle) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        let s = inner
            .sessions
            .get_mut(handle)
            .ok_or_else(|| AppError::NotFound(format!("chat session {handle}")))?;
        // No PTY here, so we send SIGTERM via Child::kill which is
        // immediate on Unix. We give the child a 2s window to clean
        // up before escalating; in practice for stream-json mode this
        // is academic since most turns are short.
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            let pid = s.child.id() as i32;
            unsafe {
                libc_sigint(pid);
            }
            let deadline = Instant::now() + Duration::from_millis(2000);
            loop {
                match s.child.try_wait() {
                    Ok(Some(_)) => return Ok(()),
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            let _ = s.child.kill();
                            // Don't care about the wait result here.
                            let _: Option<i32> = s
                                .child
                                .try_wait()
                                .ok()
                                .flatten()
                                .and_then(|st| st.signal());
                            return Ok(());
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => {
                        let _ = s.child.kill();
                        return Ok(());
                    }
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = s.child.kill();
            Ok(())
        }
    }

    /// Tear the session down: drop stdin (claude EOFs cleanly), kill
    /// the child if still alive, remove from the map.
    pub fn close(&self, handle: &Handle) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        if let Some(mut s) = inner.sessions.remove(handle) {
            let _ = s.stdin.flush();
            // Closing stdin signals EOF to the child; claude exits
            // cleanly when no more user turns are coming.
            drop(s.stdin);
            let _ = s.child.kill();
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.inner.lock().map(|g| g.sessions.len()).unwrap_or(0)
    }
}

/// A discovered slash command — used by the chat input's `/`
/// popover. Sources are workspace `.claude/commands/`, user
/// `~/.claude/commands/`, plugin commands at
/// `.claude/plugins/<plugin>/commands/`, and Claude Code built-ins.
#[derive(Debug, Clone, Serialize)]
pub struct SlashCommand {
    /// What the user types (without the leading `/`). Plugin
    /// commands carry the namespace, e.g. "<your-github-plugin>:draft-pr".
    pub name: String,
    /// Source category — drives the popover grouping.
    pub source: SlashSource,
    /// First line of the command's description, if any. Pulled from
    /// frontmatter or the first sentence of the body.
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SlashSource {
    /// Workspace command (`.claude/commands/<name>.md` in repo)
    Workspace,
    /// User command (`~/.claude/commands/<name>.md`)
    User,
    /// Plugin-namespaced command
    Plugin,
    /// Claude Code built-in (/clear, /compact, /model, /mcp, etc.)
    Builtin,
}

/// Discover slash commands available to a session rooted at `cwd`.
/// Order: workspace > user > plugin > builtin so the popover can
/// group with the most-relevant first.
pub fn discover_slash_commands(cwd: &Path) -> Vec<SlashCommand> {
    let mut out: BTreeMap<String, SlashCommand> = BTreeMap::new();

    // Workspace commands — `<cwd>/.claude/commands/`. We also walk
    // up the parent chain a couple levels so a session opened in
    // a subdirectory of the repo still picks up the repo-root
    // commands.
    let mut dir = Some(cwd.to_path_buf());
    let mut walked = 0;
    while let Some(d) = dir {
        let path = d.join(".claude").join("commands");
        if path.is_dir() {
            collect_commands_from(&path, SlashSource::Workspace, &mut out);
        }
        // Plugin commands at .claude/plugins/<plugin>/commands/.
        let plugins_dir = d.join(".claude").join("plugins");
        if plugins_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&plugins_dir) {
                for e in entries.flatten() {
                    let p = e.path().join("commands");
                    if p.is_dir() {
                        let plugin_name = e
                            .file_name()
                            .into_string()
                            .unwrap_or_default();
                        collect_plugin_commands(
                            &p,
                            &plugin_name,
                            &mut out,
                        );
                    }
                }
            }
        }
        walked += 1;
        if walked >= 4 {
            break;
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }

    // User commands — `~/.claude/commands/`.
    if let Ok(home) = std::env::var("HOME") {
        let user_dir = PathBuf::from(home).join(".claude").join("commands");
        if user_dir.is_dir() {
            collect_commands_from(&user_dir, SlashSource::User, &mut out);
        }
    }

    // Built-ins — claude itself ships these. Hardcoded list because
    // there's no API to enumerate them; if claude adds new ones we
    // ship a code change.
    for (name, desc) in [
        ("clear", "Clear conversation history (start fresh)"),
        ("compact", "Compact the conversation to free up context"),
        ("model", "Switch the active model"),
        ("mcp", "List MCP servers + their status"),
        ("permissions", "View / change permission mode"),
        ("review", "Review the conversation so far"),
    ] {
        out.entry(name.to_string()).or_insert(SlashCommand {
            name: name.to_string(),
            source: SlashSource::Builtin,
            description: Some(desc.to_string()),
        });
    }

    out.into_values().collect()
}

fn collect_commands_from(
    dir: &Path,
    source: SlashSource,
    out: &mut BTreeMap<String, SlashCommand>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e == "md")
            .unwrap_or(false)
        {
            continue;
        }
        let name = stem.to_string();
        let description = read_command_description(&path);
        out.entry(name.clone()).or_insert(SlashCommand {
            name,
            source,
            description,
        });
    }
}

fn collect_plugin_commands(
    dir: &Path,
    plugin: &str,
    out: &mut BTreeMap<String, SlashCommand>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_file() {
            continue;
        }
        if !path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e == "md")
            .unwrap_or(false)
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let name = format!("{plugin}:{stem}");
        let description = read_command_description(&path);
        out.entry(name.clone()).or_insert(SlashCommand {
            name,
            source: SlashSource::Plugin,
            description,
        });
    }
}

/// Pull a short description from a command markdown file:
///   - YAML frontmatter `description: ...` if present
///   - first non-blank, non-heading line otherwise
///   - first 120 chars of either, trimmed
fn read_command_description(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    if let Some(rest) = text.strip_prefix("---") {
        // Walk frontmatter looking for `description:`.
        if let Some((fm, _body)) = rest.split_once("\n---") {
            for line in fm.lines() {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("description:") {
                    let desc = rest.trim().trim_matches('"').trim_matches('\'');
                    if !desc.is_empty() {
                        return Some(truncate(desc, 120));
                    }
                }
            }
        }
    }
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with("---") {
            continue;
        }
        return Some(truncate(t, 120));
    }
    None
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

/// Build the `{"type":"user", "message":{"role":"user","content":"<text>"}}`
/// envelope claude expects on stdin in stream-json input mode.
/// Public + pure so it's testable without spawning a process.
pub fn build_user_envelope(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": text,
        }
    })
    .to_string()
}

/// Send SIGINT to a pid via libc. Wrapped in an unsafe fn so callers
/// can't forget the unsafe block. Unix-only.
#[cfg(unix)]
unsafe fn libc_sigint(pid: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGINT: i32 = 2;
    let _ = kill(pid, SIGINT);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> OpenArgs {
        OpenArgs {
            cwd: String::new(),
            model: String::new(),
            permission_mode: String::new(),
            resume_id: String::new(),
            transcript_path: String::new(),
        }
    }

    fn s(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn build_argv_includes_required_flags() {
        let argv = build_argv(&args(), &[]);
        assert!(argv.contains(&"--print".to_string()));
        assert!(argv.contains(&"--output-format".to_string()));
        assert!(argv.contains(&"stream-json".to_string()));
        assert!(argv.contains(&"--input-format".to_string()));
        assert!(argv.contains(&"--verbose".to_string()));
    }

    #[test]
    fn build_argv_passes_overrides() {
        let mut a = args();
        a.model = "claude-opus-4-7".into();
        a.permission_mode = "plan".into();
        let argv = build_argv(&a, &[]);
        assert!(argv.windows(2).any(|w| w == ["--model", "claude-opus-4-7"]));
        assert!(argv.windows(2).any(|w| w == ["--permission-mode", "plan"]));
    }

    #[test]
    fn build_argv_inherits_effort_from_settings() {
        let extra = s(&["--effort", "xhigh", "--print", "--model", "opus"]);
        let argv = build_argv(&args(), &extra);
        // --effort passes through; --print is stripped (we own it);
        // --model passes through (no override set).
        assert!(argv.windows(2).any(|w| w == ["--effort", "xhigh"]));
        assert!(argv.windows(2).any(|w| w == ["--model", "opus"]));
        // Only one --print (the one we own).
        assert_eq!(argv.iter().filter(|a| *a == "--print").count(), 1);
    }

    #[test]
    fn build_argv_overrides_drop_inherited_duplicates() {
        // User has --model opus saved; opens chat with sonnet. Should
        // see sonnet exactly once.
        let extra = s(&["--model", "opus", "--effort", "xhigh"]);
        let mut a = args();
        a.model = "claude-sonnet-4-6".into();
        let argv = build_argv(&a, &extra);
        assert_eq!(
            argv.iter().filter(|a| *a == "--model").count(),
            1,
            "duplicate --model in {argv:?}"
        );
        assert!(argv.contains(&"claude-sonnet-4-6".to_string()));
        assert!(!argv.contains(&"opus".to_string()));
    }

    #[test]
    fn build_argv_strips_inherited_output_format() {
        // --output-format takes a value; we own it. Make sure both
        // the flag and its value are dropped.
        let extra = s(&["--output-format", "json", "--effort", "xhigh"]);
        let argv = build_argv(&args(), &extra);
        assert_eq!(
            argv.iter().filter(|a| *a == "--output-format").count(),
            1,
            "should be exactly one --output-format (ours): {argv:?}",
        );
        assert!(!argv.contains(&"json".to_string()));
        assert!(argv.windows(2).any(|w| w == ["--effort", "xhigh"]));
    }

    #[test]
    fn build_user_envelope_is_valid_ndjson_record() {
        let line = build_user_envelope("hello");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "hello");
        assert!(!line.contains('\n'), "envelope must be single-line");
    }

    #[test]
    fn build_user_envelope_escapes_quotes_and_newlines() {
        let line = build_user_envelope("line one\nline two with \"quotes\"");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            v["message"]["content"],
            "line one\nline two with \"quotes\""
        );
    }

    #[test]
    fn manager_starts_empty() {
        let m = Manager::new();
        assert_eq!(m.count(), 0);
    }

    #[test]
    fn close_unknown_handle_is_noop() {
        let m = Manager::new();
        let h: Handle = "nope".into();
        assert!(m.close(&h).is_ok());
    }

    #[test]
    fn send_to_unknown_handle_errors() {
        let m = Manager::new();
        let h: Handle = "nope".into();
        let err = m.send_user_turn(&h, "hi");
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
    }

    #[test]
    fn discover_slash_commands_picks_up_workspace_commands() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cmds = tmp.path().join(".claude/commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(
            cmds.join("morning-briefing.md"),
            "---\ndescription: Your prioritized day\n---\n\nbody here",
        )
        .unwrap();
        std::fs::write(
            cmds.join("prep-1on1.md"),
            "# Prep 1:1\n\nFull workflow for prepping a 1:1 session.",
        )
        .unwrap();
        let out = discover_slash_commands(tmp.path());
        let names: Vec<_> = out.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"morning-briefing"));
        assert!(names.contains(&"prep-1on1"));
        let mb = out.iter().find(|c| c.name == "morning-briefing").unwrap();
        assert_eq!(mb.description.as_deref(), Some("Your prioritized day"));
        let p11 = out.iter().find(|c| c.name == "prep-1on1").unwrap();
        // Frontmatter absent → first non-heading line.
        assert_eq!(
            p11.description.as_deref(),
            Some("Full workflow for prepping a 1:1 session.")
        );
    }

    #[test]
    fn discover_slash_commands_picks_up_plugin_commands() {
        let tmp = tempfile::TempDir::new().unwrap();
        let plugins = tmp.path().join(".claude/plugins/<your-github-plugin>/commands");
        std::fs::create_dir_all(&plugins).unwrap();
        std::fs::write(plugins.join("draft-pr.md"), "draft a PR").unwrap();
        let out = discover_slash_commands(tmp.path());
        let names: Vec<_> = out.iter().map(|c| c.name.as_str()).collect();
        assert!(
            names.contains(&"<your-github-plugin>:draft-pr"),
            "got {names:?}"
        );
    }

    #[test]
    fn discover_slash_commands_includes_builtins() {
        let tmp = tempfile::TempDir::new().unwrap();
        let out = discover_slash_commands(tmp.path());
        let names: Vec<_> = out.iter().map(|c| c.name.as_str()).collect();
        for built in ["clear", "compact", "model", "mcp"] {
            assert!(names.contains(&built), "missing builtin {built} in {names:?}");
        }
    }

    #[test]
    fn slugify_for_transcript_handles_typical_inputs() {
        assert_eq!(
            slugify_for_transcript("Summarize the last 3 sessions with @alice"),
            "summarize-the-last-3-sessions-with-alice"
        );
        assert_eq!(slugify_for_transcript("hello!!!"), "hello");
        assert_eq!(slugify_for_transcript("   "), "");
        // Truncation at 50 chars.
        let long = slugify_for_transcript(&"a".repeat(100));
        assert_eq!(long.len(), 50);
    }

    #[test]
    fn transcript_writer_creates_paired_files() {
        let tmp = tempfile::TempDir::new().unwrap();
        let md = tmp.path().join("areas/console-sessions/sessions/foo.md");
        let jsonl = tmp.path().join("areas/console-sessions/sessions/foo.jsonl");
        let mut w = TranscriptWriter::new(
            md.clone(),
            jsonl.clone(),
            "/some/cwd".to_string(),
            vec!["--print".into()],
        );
        // Writing a user turn lazily creates both files.
        w.write_user_turn("hello, claude").unwrap();
        assert!(md.exists());
        assert!(jsonl.exists());
        let md_content = std::fs::read_to_string(&md).unwrap();
        assert!(md_content.contains("---"), "no frontmatter: {md_content}");
        assert!(md_content.contains("type: console-session"));
        assert!(md_content.contains("## You"));
        assert!(md_content.contains("hello, claude"));
        let jsonl_content = std::fs::read_to_string(&jsonl).unwrap();
        let line: serde_json::Value =
            serde_json::from_str(jsonl_content.trim()).unwrap();
        assert_eq!(line["type"], "user");
        assert_eq!(line["_origin"], "local");
    }

    #[test]
    fn transcript_writer_writes_assistant_event_to_md_and_jsonl() {
        let tmp = tempfile::TempDir::new().unwrap();
        let md = tmp.path().join("a.md");
        let jsonl = tmp.path().join("a.jsonl");
        let mut w = TranscriptWriter::new(
            md.clone(),
            jsonl.clone(),
            ".".into(),
            vec![],
        );
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "ok" },
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": { "file_path": "x" }
                    }
                ]
            }
        });
        w.write_event(&event).unwrap();
        let md_content = std::fs::read_to_string(&md).unwrap();
        assert!(md_content.contains("## Claude"));
        assert!(md_content.contains("```claude-tool"));
        let jsonl_content = std::fs::read_to_string(&jsonl).unwrap();
        let line: serde_json::Value =
            serde_json::from_str(jsonl_content.trim()).unwrap();
        assert_eq!(line["type"], "assistant");
    }

    #[test]
    fn transcript_writer_idempotent_initialization() {
        // Calling write_event twice shouldn't write the frontmatter
        // twice (we'd end up with two `---` blocks).
        let tmp = tempfile::TempDir::new().unwrap();
        let md = tmp.path().join("b.md");
        let jsonl = tmp.path().join("b.jsonl");
        let mut w = TranscriptWriter::new(
            md.clone(),
            jsonl,
            ".".into(),
            vec![],
        );
        let ev = serde_json::json!({"type": "result", "subtype": "success"});
        w.write_event(&ev).unwrap();
        w.write_event(&ev).unwrap();
        let md_content = std::fs::read_to_string(&md).unwrap();
        let frontmatter_count = md_content.matches("type: console-session").count();
        assert_eq!(frontmatter_count, 1, "got {md_content}");
    }

    #[test]
    fn discover_slash_commands_walks_up_to_repo_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Commands at the top, but we open the session two levels deep.
        let cmds = tmp.path().join(".claude/commands");
        std::fs::create_dir_all(&cmds).unwrap();
        std::fs::write(cmds.join("morning-briefing.md"), "go").unwrap();
        let nested = tmp.path().join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        let out = discover_slash_commands(&nested);
        let names: Vec<_> = out.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"morning-briefing"), "got {names:?}");
    }
}
