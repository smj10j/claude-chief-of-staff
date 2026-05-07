//! Single-file seam for Claude calls. Drives the locally-installed Claude
//! Code CLI as a subprocess — no HTTP client, no API key management. The
//! user supplies `claude` on $PATH (or via a settings override); we write
//! prompts to its stdin and parse the response off stdout.
//!
//! PRD-114 will eventually route through a self-hosted proxy; until then
//! the CLI transport keeps billing + identity + personal context in one
//! place (the user's existing Claude Code install), rather than requiring
//! a separate API key managed by the app.
//!
//! When the transport swaps, only this file changes — callers stay on
//! `run_prompt` / `parse_task` / future `process_annotations`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Persisted CLI configuration. Lives at `<app_data>/claude-cli.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ClaudeCliConfig {
    /// User-entered absolute path to the `claude` binary. Empty string
    /// means "auto-detect from $PATH and common install locations".
    #[serde(default)]
    pub binary_path: String,

    /// Optional settings.json path handed to Claude Code via `--settings`.
    /// Empty string keeps Claude Code's default discovery (`~/.claude`).
    #[serde(default)]
    pub settings_path: String,

    /// Args appended on every invocation. The default matches
    /// `claude --print --permission-mode auto --model opus`.
    /// Each skill also adds its own task-specific flags at call time
    /// (e.g. JSON-only prompt discipline lives in the prompt itself
    /// rather than `--output-format` so stdout stays plain text).
    #[serde(default = "default_extra_args")]
    pub extra_args: Vec<String>,
}

pub fn default_extra_args() -> Vec<String> {
    vec![
        "--print".into(),
        "--permission-mode".into(),
        "auto".into(),
        "--model".into(),
        "opus".into(),
        "--effort".into(),
        "xhigh".into(),
    ]
}

impl Default for ClaudeCliConfig {
    fn default() -> Self {
        Self {
            binary_path: String::new(),
            settings_path: String::new(),
            extra_args: default_extra_args(),
        }
    }
}

fn config_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("claude-cli.json")
}

/// Load the CLI config from disk. Missing file → defaults. Partial files
/// get missing fields filled from defaults so the user can't corrupt the
/// app by hand-editing a stub.
pub fn load_config(app_data_dir: &Path) -> AppResult<ClaudeCliConfig> {
    let path = config_file(app_data_dir);
    if !path.exists() {
        return Ok(ClaudeCliConfig::default());
    }
    let text = fs::read_to_string(&path)?;
    let raw: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}));
    let mut cfg = ClaudeCliConfig::default();
    if let Some(s) = raw.get("binary_path").and_then(|v| v.as_str()) {
        cfg.binary_path = s.trim().to_string();
    }
    if let Some(s) = raw.get("settings_path").and_then(|v| v.as_str()) {
        cfg.settings_path = s.trim().to_string();
    }
    if let Some(a) = raw.get("extra_args").and_then(|v| v.as_array()) {
        let args: Vec<String> = a
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();
        // Empty extra_args means "user explicitly wants no args" — keep the
        // default behavior since users will almost certainly want at
        // least --print. The Settings UI validates "at least one arg" on
        // save too.
        if !args.is_empty() {
            cfg.extra_args = args;
        }
    }
    Ok(cfg)
}

pub fn save_config(app_data_dir: &Path, cfg: &ClaudeCliConfig) -> AppResult<()> {
    fs::create_dir_all(app_data_dir)?;
    let payload = serde_json::json!({
        "binary_path": cfg.binary_path.trim(),
        "settings_path": cfg.settings_path.trim(),
        "extra_args": cfg.extra_args,
    });
    fs::write(config_file(app_data_dir), serde_json::to_string_pretty(&payload)?)?;
    Ok(())
}

/// Resolve which `claude` binary to call. Priority order:
///   1. User override (`cfg.binary_path`) if non-empty — no fallback.
///   2. Anything on `$PATH`.
///   3. Common install locations we've seen in the wild.
/// Returns `None` if nothing resolves to an executable file.
pub fn resolve_binary(override_path: &str) -> Option<PathBuf> {
    let override_trimmed = override_path.trim();
    if !override_trimmed.is_empty() {
        let p = PathBuf::from(override_trimmed);
        return if p.is_file() { Some(p) } else { None };
    }

    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("claude");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // Known install locations. We check these even when $PATH is set,
    // because Tauri apps launched from Finder inherit a minimal PATH
    // that typically omits ~/.claude/local and /opt/homebrew/bin.
    let home = std::env::var("HOME").ok();
    let candidates: Vec<PathBuf> = [
        home.as_deref()
            .map(|h| PathBuf::from(format!("{h}/.claude/local/claude"))),
        Some(PathBuf::from("/opt/homebrew/bin/claude")),
        Some(PathBuf::from("/usr/local/bin/claude")),
        home.as_deref()
            .map(|h| PathBuf::from(format!("{h}/.local/bin/claude"))),
    ]
    .into_iter()
    .flatten()
    .collect();

    candidates.into_iter().find(|p| p.is_file())
}

/// Snapshot of the CLI configuration + resolution state. Returned to the
/// UI so Settings can show what's resolved and whether NL features will
/// light up without having to guess.
#[derive(Serialize)]
pub struct ClaudeCliStatus {
    pub binary_path_configured: String,
    pub binary_path_resolved: Option<String>,
    pub settings_path: String,
    pub extra_args: Vec<String>,
    pub default_extra_args: Vec<String>,
    pub available: bool,
    pub config_file: String,
}

impl ClaudeCliStatus {
    pub fn compute(app_data_dir: &Path, cfg: &ClaudeCliConfig) -> Self {
        let resolved = resolve_binary(&cfg.binary_path);
        Self {
            binary_path_configured: cfg.binary_path.clone(),
            binary_path_resolved: resolved
                .as_ref()
                .map(|p| p.display().to_string()),
            settings_path: cfg.settings_path.clone(),
            extra_args: cfg.extra_args.clone(),
            default_extra_args: default_extra_args(),
            available: resolved.is_some(),
            config_file: config_file(app_data_dir).display().to_string(),
        }
    }
}

/// Run the CLI with `prompt` piped to stdin. Returns stdout verbatim.
/// stderr is captured and folded into the error message on failure so
/// we don't lose the CLI's own diagnostics.
///
/// `cwd` optionally pins the subprocess's working directory — useful for
/// skills that should pick up the project-level CLAUDE.md (the generator
/// wants this so Claude has the user's context; parse_task doesn't).
pub fn run_prompt(
    cfg: &ClaudeCliConfig,
    prompt: &str,
    cwd: Option<&Path>,
) -> AppResult<String> {
    let bin = resolve_binary(&cfg.binary_path).ok_or_else(|| {
        AppError::NotFound(
            "claude binary not found on $PATH; set the path in Settings → Claude"
                .into(),
        )
    })?;

    let mut cmd = Command::new(&bin);
    cmd.args(&cfg.extra_args);
    if !cfg.settings_path.trim().is_empty() {
        cmd.arg("--settings").arg(&cfg.settings_path);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::InvalidState(format!("spawn {}: {e}", bin.display())))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())?;
        // Explicit close so Claude Code sees EOF on stdin and starts
        // producing output instead of waiting for more input.
        drop(stdin);
    }

    let out = child
        .wait_with_output()
        .map_err(|e| AppError::InvalidState(format!("wait: {e}")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        return Err(AppError::InvalidState(format!(
            "claude CLI exited {}: {} {}",
            out.status,
            stderr.trim(),
            stdout.trim()
        )));
    }

    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One MCP entry as returned by `claude mcp list`. The list is advisory —
/// shown in Settings so users can see which connectors will light up
/// when skills run. We don't verify state beyond "present in the list".
#[derive(Serialize, Debug, Clone)]
pub struct McpServer {
    pub name: String,
    /// Raw info line from `claude mcp list` (everything after the name).
    /// Kept opaque so we don't have to track every CLI-output format change.
    pub info: String,
    /// True when the line looks like "<name>: ✓ Connected" or similar
    /// positive signal. False for ✘/error/untested.
    pub connected: bool,
}

/// Invoke `claude mcp list` and parse the output. Shelling out to the same
/// binary the user configured (rather than reading their settings.json
/// directly) keeps this honest: what claude sees is what we show.
pub fn mcp_list(cfg: &ClaudeCliConfig) -> AppResult<Vec<McpServer>> {
    let bin = resolve_binary(&cfg.binary_path).ok_or_else(|| {
        AppError::NotFound(
            "claude binary not found on $PATH; set the path in Settings → Claude"
                .into(),
        )
    })?;

    let mut cmd = Command::new(&bin);
    cmd.args(["mcp", "list"]);
    // mcp list doesn't need the extra_args (they're `--print`-centric) and
    // the default perm-mode is fine here — mcp list is read-only.
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let out = cmd
        .output()
        .map_err(|e| AppError::InvalidState(format!("spawn {}: {e}", bin.display())))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(AppError::InvalidState(format!(
            "claude mcp list exited {}: {}",
            out.status,
            stderr.trim()
        )));
    }
    Ok(parse_mcp_list(&String::from_utf8_lossy(&out.stdout)))
}

/// Parse one `claude mcp list` line per server. Output shape looks like:
///   cos-dev: /path/to/server args... - ✓ Connected
///   slack-local: npx slack-local ... - ✘ Failed to connect
///   plugin:atlassian: … - Untested
/// We treat anything beyond `<name>:` as opaque `info` and only lift a
/// connected bool from a ✓ in the line. Future CLI-format shifts can be
/// absorbed here without cascading.
fn parse_mcp_list(raw: &str) -> Vec<McpServer> {
    let mut out = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Skip header/footer lines that don't look like entries.
        if !trimmed.contains(':') {
            continue;
        }
        let lower = trimmed.to_lowercase();
        // "No MCP servers configured" or similar headers — ignore.
        if lower.starts_with("no mcp") || lower.starts_with("checking") {
            continue;
        }
        // Split at the first ':' to separate the name from the rest.
        let (name_part, info_part) = match trimmed.split_once(':') {
            Some((n, rest)) => (n.trim(), rest.trim()),
            None => continue,
        };
        if name_part.is_empty() {
            continue;
        }
        let connected = info_part.contains('✓')
            || lower.contains("connected")
                && !lower.contains("failed")
                && !lower.contains("error");
        out.push(McpServer {
            name: name_part.to_string(),
            info: info_part.to_string(),
            connected,
        });
    }
    out
}

/// Hard ceiling for Settings → Diagnostics ping so the UI can't sit
/// on a blue spinner if the binary is wedged. Anything longer than
/// this and we kill the child + return a timeout error. Skills that
/// expect long runs (briefing, digest) bypass this and use
/// run_prompt directly.
pub const PING_TIMEOUT_SECS: u64 = 30;

/// Tiny round-trip to prove the CLI is wired up. Uses a throw-away prompt
/// so we confirm spawn + stdin + stdout plumbing end-to-end. Bounded by
/// PING_TIMEOUT_SECS so a hung binary doesn't strand the UI.
pub fn ping(cfg: &ClaudeCliConfig) -> AppResult<String> {
    let out = run_prompt_with_timeout(
        cfg,
        "Reply with the single token OK and nothing else. No punctuation.",
        None,
        std::time::Duration::from_secs(PING_TIMEOUT_SECS),
    )?;
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidState(
            "claude CLI returned empty output".into(),
        ));
    }
    Ok(format!("ok · reached Claude CLI ({} bytes)", out.len()))
}

/// Like run_prompt but kills the child after `timeout` elapses and
/// returns a timeout error instead of blocking indefinitely. Polled at
/// 100 ms granularity — fine for human-perceptible deadlines.
pub fn run_prompt_with_timeout(
    cfg: &ClaudeCliConfig,
    prompt: &str,
    cwd: Option<&Path>,
    timeout: std::time::Duration,
) -> AppResult<String> {
    let bin = resolve_binary(&cfg.binary_path).ok_or_else(|| {
        AppError::NotFound(
            "claude binary not found on $PATH; set the path in Settings → Claude"
                .into(),
        )
    })?;

    let mut cmd = Command::new(&bin);
    cmd.args(&cfg.extra_args);
    if !cfg.settings_path.trim().is_empty() {
        cmd.arg("--settings").arg(&cfg.settings_path);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::InvalidState(format!("spawn {}: {e}", bin.display())))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())?;
        drop(stdin);
    }

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = child
                    .wait_with_output()
                    .map_err(|e| AppError::InvalidState(format!("wait: {e}")))?;
                if !status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                    return Err(AppError::InvalidState(format!(
                        "claude CLI exited {}: {} {}",
                        status,
                        stderr.trim(),
                        stdout.trim()
                    )));
                }
                return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(AppError::InvalidState(format!(
                        "claude CLI ping timed out after {}s — binary may be wedged",
                        timeout.as_secs()
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                return Err(AppError::InvalidState(format!("try_wait: {e}")));
            }
        }
    }
}

/// Invoke a Claude Code slash command (e.g. `/prep-1on1 alice`,
/// `/morning-briefing`, `/digest-meeting alice`) and return the raw
/// stdout markdown.
///
/// **Architectural principle**: every skill the v2 UI surfaces MUST be
/// implemented as a slash command in `.claude/commands/*.md` so the
/// same skill can be driven from the UI (this seam) AND from the user's
/// own Claude Code REPL. v2 is one of two front-ends; the slash
/// command is the source of truth, this function is the v2 transport.
///
/// `command` is the slash-command name without leading slash
/// (e.g. `"prep-1on1"`); `args` is whatever positional text the
/// command's `$ARGUMENTS` should receive (or empty for no-arg skills).
pub fn run_skill(
    cfg: &ClaudeCliConfig,
    cwd: Option<&Path>,
    command: &str,
    args: &str,
) -> AppResult<String> {
    let invocation = if args.trim().is_empty() {
        format!("/{command}")
    } else {
        format!("/{command} {args}", command = command, args = args.trim())
    };
    run_prompt(cfg, &invocation, cwd)
}

/// Parse a free-form task description into structured fields. Caller
/// hands the result straight to `v1_tasks_create`.
pub fn parse_task(
    cfg: &ClaudeCliConfig,
    input: &str,
    projects: &[String],
    today_local: &str,
) -> AppResult<ParsedTask> {
    let project_list = if projects.is_empty() {
        "(none known)".to_string()
    } else {
        projects.join(", ")
    };

    let prompt = format!(
"You turn a free-form task description into a structured task.

Rules:
- title: concise, imperative-mood summary. Strip priority/date/project
  phrases that appear elsewhere in the output.
- priority: default \"medium\". Only set \"high\" or \"low\" when the user
  says so explicitly (urgent/asap/p0 = high; someday/eventually/low prio
  = low).
- due: resolve natural language against TODAY below. Output YYYY-MM-DD
  for date-only, or YYYY-MM-DD HH:MM when a time is given. Use null if
  no due is implied. 24-hour time.
- project: the user may reference a project by name or nickname. Match
  against AVAILABLE PROJECTS below. If nothing clearly matches, null.
- tags: 0-4 short lowercase tags derived from the description. Prefer
  existing conventions (work, personal, prep, comms, admin, team:*).
  Never invent unrelated tags.
- notes: only populate if the user dictated context worth keeping.
  Never fabricate context or claim you pulled from Slack/Glean/etc.
  If the user asks for external enrichment, leave notes null and note
  in the title that enrichment is needed.

TODAY: {today_local}
AVAILABLE PROJECTS: {project_list}

Respond with ONLY a JSON object. No preamble. No markdown fences. No
explanation. Exactly this shape:
{{
  \"title\": \"string\",
  \"priority\": \"high\" | \"medium\" | \"low\",
  \"due\": \"YYYY-MM-DD\" or \"YYYY-MM-DD HH:MM\" or null,
  \"project\": \"slug-from-list\" or null,
  \"tags\": [\"short-lowercase-tag\", ...],
  \"notes\": \"string\" or null
}}

User input:
{input}"
    );

    let raw = run_prompt(cfg, &prompt, None)?;
    let json_text = extract_json_object(&raw).ok_or_else(|| {
        AppError::InvalidState(format!(
            "claude CLI response had no JSON object (stdout: {})",
            raw.trim()
        ))
    })?;
    let parsed: ParsedTask = serde_json::from_str(&json_text).map_err(|e| {
        AppError::InvalidState(format!(
            "claude CLI json decode: {e} (candidate: {json_text})"
        ))
    })?;
    Ok(parsed.normalized())
}

/// Pull the first balanced JSON object out of a blob. Accepts:
///   - Plain `{...}` with surrounding whitespace
///   - Fenced blocks ```json ... ``` or ``` ... ```
///   - Response wrapped in chatter before/after the object
/// Returns `None` if nothing looks like JSON.
pub fn extract_json_object(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }

    // Strip ```json ... ``` or ``` ... ``` fences first — if they're
    // there, the JSON inside them is the answer.
    if let Some(after_open) = s
        .strip_prefix("```json")
        .or_else(|| s.strip_prefix("```"))
    {
        if let Some(end) = after_open.rfind("```") {
            let inner = after_open[..end].trim();
            if inner.starts_with('{') {
                return balanced_object(inner);
            }
        }
    }

    balanced_object(s)
}

/// Walk `s` looking for the first `{` and return the substring up through
/// its matching `}`. Respects strings (including escaped quotes) so a
/// `}` inside a string value doesn't close the object prematurely.
fn balanced_object(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Structured task fields returned to the UI. Mirrors the `v1_tasks_create`
/// input shape — the frontend forwards it straight to the create IPC.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedTask {
    pub title: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

fn default_priority() -> String {
    "medium".to_string()
}

impl ParsedTask {
    /// Trim strings, drop empty tags, coerce priority to the v1 enum. The
    /// model occasionally says "p0" or "urgent" even when we asked for
    /// high/medium/low — remap rather than fail the whole flow.
    fn normalized(mut self) -> Self {
        self.title = self.title.trim().to_string();
        self.priority = match self.priority.trim().to_lowercase().as_str() {
            "p0" | "p1" | "urgent" | "critical" => "high".to_string(),
            "p2" | "normal" => "medium".to_string(),
            "p3" | "p4" | "someday" => "low".to_string(),
            p @ ("high" | "medium" | "low") => p.to_string(),
            _ => "medium".to_string(),
        };
        self.due = self.due.and_then(non_empty);
        self.project = self.project.and_then(non_empty);
        self.notes = self.notes.and_then(non_empty);
        self.tags = self
            .tags
            .into_iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        self
    }
}

fn non_empty(s: String) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn run_skill_invocation_format_is_slash_command_with_args() {
        // `run_skill` itself shells out and we can't test that in a unit
        // test, but we can verify the format we'd hand to run_prompt by
        // re-implementing the same fragment here. Kept small since the
        // contract is "arg-trim + leading slash"; if we change that
        // contract this test is the canary.
        fn format_invocation(command: &str, args: &str) -> String {
            if args.trim().is_empty() {
                format!("/{command}")
            } else {
                format!("/{command} {args}", command = command, args = args.trim())
            }
        }
        assert_eq!(format_invocation("prep-1on1", "alice"), "/prep-1on1 alice");
        assert_eq!(format_invocation("morning-briefing", ""), "/morning-briefing");
        assert_eq!(
            format_invocation("digest-meeting", "  bob  "),
            "/digest-meeting bob",
        );
    }

    #[test]
    fn default_config_matches_expected_command() {
        let cfg = ClaudeCliConfig::default();
        assert_eq!(
            cfg.extra_args,
            vec![
                "--print",
                "--permission-mode",
                "auto",
                "--model",
                "opus",
                "--effort",
                "xhigh",
            ]
        );
        assert!(cfg.binary_path.is_empty());
        assert!(cfg.settings_path.is_empty());
    }

    #[test]
    fn load_config_returns_defaults_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let cfg = load_config(tmp.path()).unwrap();
        assert_eq!(cfg.extra_args, default_extra_args());
    }

    #[test]
    fn save_and_load_round_trips() {
        let tmp = TempDir::new().unwrap();
        let before = ClaudeCliConfig {
            binary_path: "/opt/homebrew/bin/claude".into(),
            settings_path: "/Users/x/.claude/settings.json".into(),
            extra_args: vec![
                "--print".into(),
                "--model".into(),
                "opus".into(),
            ],
        };
        save_config(tmp.path(), &before).unwrap();
        let after = load_config(tmp.path()).unwrap();
        assert_eq!(after.binary_path, before.binary_path);
        assert_eq!(after.settings_path, before.settings_path);
        assert_eq!(after.extra_args, before.extra_args);
    }

    #[test]
    fn load_config_merges_partial_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(
            config_file(tmp.path()),
            r#"{ "binary_path": "/tmp/claude" }"#,
        )
        .unwrap();
        let cfg = load_config(tmp.path()).unwrap();
        assert_eq!(cfg.binary_path, "/tmp/claude");
        // Missing extra_args → defaults preserved.
        assert_eq!(cfg.extra_args, default_extra_args());
    }

    #[test]
    fn resolve_binary_honors_explicit_override() {
        let tmp = TempDir::new().unwrap();
        let fake = tmp.path().join("claude");
        fs::write(&fake, "#!/bin/sh\necho hi").unwrap();
        let got = resolve_binary(fake.to_str().unwrap());
        assert_eq!(got.unwrap(), fake);
    }

    #[test]
    fn resolve_binary_rejects_override_that_does_not_exist() {
        let got = resolve_binary("/definitely/not/here/claude");
        assert!(got.is_none());
    }

    #[test]
    fn extract_json_handles_fenced_block() {
        let raw = "Here you go:\n```json\n{\"title\": \"Hi\", \"priority\": \"low\"}\n```\n";
        let got = extract_json_object(raw).unwrap();
        assert!(got.starts_with('{'));
        assert!(got.ends_with('}'));
        let p: ParsedTask = serde_json::from_str(&got).unwrap();
        assert_eq!(p.title, "Hi");
    }

    #[test]
    fn extract_json_handles_bare_object_with_chatter() {
        let raw = "sure, the task is {\"title\": \"Ship it\", \"priority\": \"high\", \"tags\": [\"work\"]}";
        let got = extract_json_object(raw).unwrap();
        let p: ParsedTask = serde_json::from_str(&got).unwrap();
        assert_eq!(p.title, "Ship it");
    }

    #[test]
    fn extract_json_respects_braces_inside_strings() {
        let raw = r#"{"title": "draft {agenda}", "priority": "medium", "tags": []}"#;
        let got = extract_json_object(raw).unwrap();
        let p: ParsedTask = serde_json::from_str(&got).unwrap();
        assert_eq!(p.title, "draft {agenda}");
    }

    #[test]
    fn extract_json_returns_none_for_garbage() {
        assert!(extract_json_object("").is_none());
        assert!(extract_json_object("just text no braces").is_none());
    }

    #[test]
    fn parsed_task_normalizes_priority_aliases() {
        let p = ParsedTask {
            title: " Ship v2 ".into(),
            priority: "P0".into(),
            due: Some(" ".into()),
            project: Some("".into()),
            tags: vec!["Work".into(), " ".into(), "PREP".into()],
            notes: None,
        }
        .normalized();
        assert_eq!(p.title, "Ship v2");
        assert_eq!(p.priority, "high");
        assert!(p.due.is_none());
        assert!(p.project.is_none());
        assert_eq!(p.tags, vec!["work".to_string(), "prep".to_string()]);
    }

    #[test]
    fn parsed_task_defaults_unknown_priority_to_medium() {
        let p = ParsedTask {
            title: "x".into(),
            priority: "giant".into(),
            due: None,
            project: None,
            tags: vec![],
            notes: None,
        }
        .normalized();
        assert_eq!(p.priority, "medium");
    }

    #[test]
    fn status_reports_available_when_binary_resolves() {
        let tmp = TempDir::new().unwrap();
        let fake = tmp.path().join("claude");
        fs::write(&fake, "").unwrap();
        let cfg = ClaudeCliConfig {
            binary_path: fake.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let status = ClaudeCliStatus::compute(tmp.path(), &cfg);
        assert!(status.available);
        assert_eq!(
            status.binary_path_resolved.as_deref(),
            Some(fake.to_str().unwrap())
        );
    }

    #[test]
    fn parse_mcp_list_extracts_connected_servers() {
        let raw = "
Checking MCP server health...

glean: https://glean.internal/mcp - ✓ Connected
google-workspace: node server.js - ✓ Connected
slack-local-mcp: npx @slack/mcp - ✘ Failed to connect
datadog-mcp: node dd.js - Untested
";
        let servers = parse_mcp_list(raw);
        assert_eq!(servers.len(), 4);
        assert_eq!(servers[0].name, "glean");
        assert!(servers[0].connected);
        assert_eq!(servers[1].name, "google-workspace");
        assert!(servers[1].connected);
        assert_eq!(servers[2].name, "slack-local-mcp");
        assert!(!servers[2].connected);
        assert_eq!(servers[3].name, "datadog-mcp");
        assert!(!servers[3].connected);
    }

    #[test]
    fn parse_mcp_list_handles_empty_and_no_mcp_lines() {
        assert!(parse_mcp_list("").is_empty());
        assert!(parse_mcp_list("No MCP servers configured.").is_empty());
        assert!(parse_mcp_list("\n\n").is_empty());
    }

    #[test]
    fn parse_mcp_list_tolerates_plugin_colons_in_name() {
        // Plugin-namespaced MCPs have a `plugin:` prefix.
        let raw = "plugin:atlassian: https://… - ✓ Connected\n";
        let servers = parse_mcp_list(raw);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "plugin");
        // We only split at the first colon, so rest goes into info. The UI
        // shows the raw info so users can still see what's going on.
        assert!(servers[0].info.contains("atlassian"));
        assert!(servers[0].connected);
    }

    #[test]
    fn status_reports_unavailable_when_override_is_bogus() {
        let tmp = TempDir::new().unwrap();
        let cfg = ClaudeCliConfig {
            binary_path: "/no/such/claude".into(),
            ..Default::default()
        };
        let status = ClaudeCliStatus::compute(tmp.path(), &cfg);
        assert!(!status.available);
        assert!(status.binary_path_resolved.is_none());
    }

    /// B7-CP17: prove the timeout path actually fires when the
    /// subprocess hangs. We point binary_path at /bin/sh which is
    /// always present on macOS/Linux, with extra_args set to
    /// `["-c", "sleep 10"]` so the child blocks for 10 seconds, and
    /// pass a 200 ms deadline. The function should kill the child
    /// and return an InvalidState error mentioning "timed out".
    #[cfg(unix)]
    #[test]
    fn run_prompt_with_timeout_kills_a_hung_child() {
        let cfg = ClaudeCliConfig {
            binary_path: "/bin/sh".into(),
            extra_args: vec!["-c".into(), "sleep 10".into()],
            settings_path: String::new(),
        };
        let started = std::time::Instant::now();
        let result = run_prompt_with_timeout(
            &cfg,
            "irrelevant",
            None,
            std::time::Duration::from_millis(200),
        );
        let elapsed = started.elapsed();
        assert!(result.is_err(), "expected timeout error");
        let msg = format!("{}", result.unwrap_err());
        assert!(
            msg.contains("timed out"),
            "error message should mention timeout, got: {msg}",
        );
        // The kill + reap should bring us back well under the
        // 10-second sleep budget. 2 seconds is generous wiggle room
        // for slow CI.
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "timeout took too long: {:?}",
            elapsed,
        );
    }

    /// B7-CP17: complement to the timeout test — prove the success
    /// path still works on a fast child. Echoes a known string and
    /// verifies it round-trips.
    #[cfg(unix)]
    #[test]
    fn run_prompt_with_timeout_returns_stdout_on_success() {
        let cfg = ClaudeCliConfig {
            binary_path: "/bin/sh".into(),
            extra_args: vec!["-c".into(), "echo hello-from-test".into()],
            settings_path: String::new(),
        };
        let result = run_prompt_with_timeout(
            &cfg,
            "irrelevant",
            None,
            std::time::Duration::from_secs(5),
        )
        .expect("fast child should succeed");
        assert!(result.contains("hello-from-test"));
    }
}
