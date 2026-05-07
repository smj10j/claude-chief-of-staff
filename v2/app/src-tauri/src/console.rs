//! PRD-116 Console — embedded `claude` session in a pseudoterminal.
//!
//! Solo-dev cut: raw PTY mode only. Spawns the user's local `claude`
//! binary inside a real pseudo-terminal (via `portable-pty`) and pumps
//! bytes between the child and the frontend. Stream-json chat mode is
//! a follow-up — the `mode` arg is part of the Tauri surface from day
//! one so the chat-mode commit doesn't need to break the wire format.
//!
//! Lifecycle:
//!   * `open(cwd, mode, ...)` spawns the child, returns a handle, and
//!     starts a reader task that pushes stdout chunks back over Tauri's
//!     event bus (`console:<handle>:data`).
//!   * `send(handle, bytes)` writes bytes (typed keystrokes, signals
//!     like Ctrl+C) to the child's stdin.
//!   * `resize(handle, rows, cols)` updates the PTY's window size — the
//!     terminal renderer needs this whenever the surface lays out.
//!   * `cancel(handle)` sends SIGINT, then SIGKILL after a 2s grace
//!     (the spec deadline; PRD-116 §3 success-criterion #11).
//!   * `close(handle)` graceful shutdown — drops the writer, kills
//!     the child if still alive, and removes the handle from the map.
//!
//! Concurrency model: one `Manager` instance lives for the lifetime
//! of the app, holding `HashMap<Handle, Session>` behind a `Mutex`.
//! Each session owns its own writer (the PTY master's writer half) and
//! a kill-channel that the reader task closes when stdout EOFs.
//!
//! What this file deliberately does NOT do (yet):
//!   - parse stream-json (Phase 2.5)
//!   - persist transcripts to .md / .jsonl files (Phase 3)
//!   - approval cards, queued input, image paste (Phase 2.5+)
//!   - chip metadata, model/mode toggling beyond what's in the args
//!     handed to the child (the user can always run `/model` inside
//!     `claude` itself)

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::str;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

/// Opaque handle the frontend uses to identify a session. We use a
/// monotonically-increasing u64 stringified to "console-<n>"; opaque
/// is the contract, not the format.
pub type Handle = String;

/// Mode flag — currently only `Raw` is implemented. `Chat` is the
/// stream-json mode (Phase 2.5). The frontend already passes this to
/// keep the wire stable; `Chat` errors with NotImplemented for now.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleMode {
    Raw,
    Chat,
}

/// Args the frontend passes when opening a session. Defaults are the
/// most-permissive-but-safe shape — `default` permission mode (Claude
/// asks before tools), no `--print` (interactive), no model override
/// (claude picks the user's last-used).
#[derive(Debug, Clone, Deserialize)]
pub struct OpenArgs {
    /// Working directory the session is rooted at. PRD §4.3 chip "Cwd".
    /// If empty, falls back to the workspace root resolved from app
    /// state at the call site.
    #[serde(default)]
    pub cwd: String,
    pub mode: ConsoleMode,
    /// Optional model override. Passed as `--model <id>` if non-empty.
    #[serde(default)]
    pub model: String,
    /// Optional permission mode override. Passed as
    /// `--permission-mode <mode>` if non-empty.
    #[serde(default)]
    pub permission_mode: String,
    /// Optional resume id — passed as `--resume <id>` to continue a
    /// prior Claude Code session. Used by the chat ↔ raw mode toggle
    /// (Phase 2.5) and by `cos console attach <id>` (Phase 3).
    #[serde(default)]
    pub resume_id: String,
    /// Initial PTY window size. Reasonable defaults (24×80) if zero.
    #[serde(default)]
    pub rows: u16,
    #[serde(default)]
    pub cols: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenResult {
    pub handle: Handle,
    pub mode: ConsoleMode,
    pub binary_path: String,
    pub cwd: String,
    pub argv: Vec<String>,
}

/// One live PTY session. `master` is owned so we can resize; `writer`
/// is the master's writer half kept around for `send`. `child` is the
/// subprocess so we can SIGINT / SIGKILL it. `reaper_done` flips true
/// when the reader task observes EOF — the writer task uses it to
/// short-circuit "child already dead" sends.
struct Session {
    // Metadata kept on the session for an upcoming `info()` accessor
    // the chip row will read once the frontend wants to show the
    // active model / mode / cwd without round-tripping through
    // OpenResult (which the renderer otherwise has to retain).
    #[allow(dead_code)]
    mode: ConsoleMode,
    #[allow(dead_code)]
    cwd: String,
    #[allow(dead_code)]
    argv: Vec<String>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    reaper_done: Arc<Mutex<bool>>,
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

/// Decide which `claude` to invoke. Mirrors `claude::resolve_binary`
/// but threaded through here so we don't have to clone its private
/// helper. The frontend should pass `binary_path_override` as
/// `cfg.binary_path` (empty for auto-detect).
pub fn resolve_claude_binary(binary_path_override: &str) -> Option<PathBuf> {
    crate::claude::resolve_binary(binary_path_override)
}

/// Pull as much complete UTF-8 as we can from `buf`, returning the
/// emittable string + any trailing bytes that look like the start of
/// a multi-byte codepoint cut off mid-sequence. The leftover should
/// be prepended to the next read.
///
/// The PTY emits whatever bytes Claude writes, and reads chunk
/// arbitrarily — a 4-byte codepoint can land 1+3 across two reads.
/// `String::from_utf8_lossy` of each chunk independently corrupts
/// the boundary character into U+FFFD, which is what surfaces as
/// "odd characters" in the rendered terminal (and worse, what makes
/// claude's box-drawing / spinner output look like garbage).
///
/// We treat *invalid* bytes (not just incomplete) as garbage and
/// emit them with the standard replacement character — those don't
/// happen for legit Claude output, but if the user pastes raw
/// binary into the PTY we shouldn't hold onto bytes forever.
pub fn stitch_utf8(buf: &[u8]) -> (String, Vec<u8>) {
    if buf.is_empty() {
        return (String::new(), Vec::new());
    }
    match str::from_utf8(buf) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            // Safety: valid_up_to bytes form a complete UTF-8 prefix.
            let good = str::from_utf8(&buf[..valid_up_to])
                .unwrap_or("")
                .to_string();
            match e.error_len() {
                // Genuine invalid byte sequence: emit it lossily and
                // skip past, then check the rest recursively.
                Some(invalid_len) => {
                    let (rest_good, rest_tail) =
                        stitch_utf8(&buf[valid_up_to + invalid_len..]);
                    let mut combined = good;
                    combined.push(char::REPLACEMENT_CHARACTER);
                    combined.push_str(&rest_good);
                    (combined, rest_tail)
                }
                // Trailing incomplete codepoint: hold those bytes for
                // the next read.
                None => (good, buf[valid_up_to..].to_vec()),
            }
        }
    }
}

/// Flags that force `claude` into non-interactive mode and would
/// break the console surface. Stripped from the inherited
/// `extra_args` before the child is spawned.
const NON_INTERACTIVE_FLAGS: &[&str] =
    &["--print", "-p", "--output-format", "--input-format"];

/// Flags the user may have set in `extra_args` that the Console
/// surface accepts as defaults. Per-session OpenArgs override these.
fn flag_takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "--model"
            | "--permission-mode"
            | "--effort"
            | "--settings"
            | "--resume"
            | "--output-format"
            | "--input-format"
    )
}

/// Filter the user's saved `extra_args` for safe pass-through to an
/// interactive PTY session. Drops:
///   - `--print` / `-p` and their value pairs (force non-interactive)
///   - `--output-format` / `--input-format` (stream-json modes that
///     don't compose with raw PTY rendering — chat mode will reach
///     for them itself in Phase 2.5)
///   - any flags the per-session OpenArgs are about to override
///     (we don't want the same flag twice on argv)
pub fn filter_inherited_args(
    extra_args: &[String],
    overrides: &OpenArgs,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut iter = extra_args.iter();
    let override_model = !overrides.model.trim().is_empty();
    let override_perm = !overrides.permission_mode.trim().is_empty();
    let override_resume = !overrides.resume_id.trim().is_empty();
    while let Some(arg) = iter.next() {
        // Strip `--flag=value` form by splitting once.
        let (flag_part, _eq_value) = match arg.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (arg.as_str(), None),
        };
        // Non-interactive flags: drop the flag *and* its value if it
        // takes one (handled by the inline match below).
        if NON_INTERACTIVE_FLAGS.contains(&flag_part) {
            if flag_takes_value(flag_part) && _eq_value.is_none() {
                let _ = iter.next();
            }
            continue;
        }
        // Per-session overrides win — drop the inherited copy.
        let dropped_by_override = match flag_part {
            "--model" if override_model => true,
            "--permission-mode" if override_perm => true,
            "--resume" if override_resume => true,
            _ => false,
        };
        if dropped_by_override {
            if flag_takes_value(flag_part) && _eq_value.is_none() {
                let _ = iter.next();
            }
            continue;
        }
        out.push(arg.clone());
    }
    out
}

/// Build the argv we hand to the PTY child. Order matters — PRD §4.6
/// behaviour is "claude runs interactive by default; we pass through
/// the user's saved Settings → Claude args (minus non-interactive
/// ones), then layer per-session OpenArgs on top."
///
/// `inherited_args` is the user's saved `extra_args` from
/// `claude-cli.json`. Pass an empty slice for tests or when there's
/// no config to inherit.
pub fn build_argv(args: &OpenArgs, inherited_args: &[String]) -> Vec<String> {
    let mut argv: Vec<String> = filter_inherited_args(inherited_args, args);
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
    argv
}

impl Manager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a fresh `claude` PTY session. Returns a handle the frontend
    /// can use for subsequent send/resize/cancel/close calls.
    ///
    /// Errors:
    ///   - NotFound if the `claude` binary can't be resolved.
    ///   - NotImplemented if `mode == Chat` (until Phase 2.5).
    ///   - InvalidState for PTY/spawn failures.
    pub fn open(
        &self,
        app: AppHandle,
        binary: PathBuf,
        cwd_default: PathBuf,
        inherited_args: Vec<String>,
        args: OpenArgs,
    ) -> AppResult<OpenResult> {
        if matches!(args.mode, ConsoleMode::Chat) {
            return Err(AppError::InvalidState(
                "chat mode is not yet implemented (Phase 2.5)".into(),
            ));
        }
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
        let rows = if args.rows == 0 { 24 } else { args.rows };
        let cols = if args.cols == 0 { 80 } else { args.cols };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::InvalidState(format!("openpty: {e}")))?;

        let mut cmd = CommandBuilder::new(binary.as_os_str());
        cmd.cwd(&cwd);
        let argv = build_argv(&args, &inherited_args);
        for a in &argv {
            cmd.arg(a);
        }
        // Inherit a sane PATH. Tauri apps launched from Finder lose
        // user-shell PATH augmentations. Without this, `claude` itself
        // works (we resolved it to an absolute path) but its child
        // tools (`bash`, `gh`, `git`) often don't.
        if let Ok(p) = std::env::var("PATH") {
            // Ensure the resolved binary's directory is on PATH so
            // shells spawned by claude can find sibling tools shipped
            // with Claude Code (e.g. nvm-installed node).
            let extra = binary.parent().map(|p| p.display().to_string());
            let merged = match extra {
                Some(d) if !p.split(':').any(|x| x == d) => format!("{d}:{p}"),
                _ => p,
            };
            cmd.env("PATH", merged);
        }
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", home);
        }
        if let Ok(term) = std::env::var("TERM") {
            cmd.env("TERM", term);
        } else {
            cmd.env("TERM", "xterm-256color");
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::InvalidState(format!("spawn claude: {e}")))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::InvalidState(format!("take_writer: {e}")))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::InvalidState(format!("clone_reader: {e}")))?;

        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        inner.counter = inner.counter.wrapping_add(1);
        let handle: Handle = format!("console-{}", inner.counter);

        let reaper_done = Arc::new(Mutex::new(false));

        // Reader task: pump bytes from PTY → frontend events. Owns
        // its own AppHandle clone so the manager doesn't have to.
        {
            let app = app.clone();
            let handle_for_thread = handle.clone();
            let reaper_done = Arc::clone(&reaper_done);
            thread::Builder::new()
                .name(format!("console-reader-{handle}"))
                .spawn(move || {
                    let mut buf = vec![0u8; 4096];
                    // Carries UTF-8 bytes for a codepoint that was
                    // split across reads. Emptied on each emit.
                    let mut tail: Vec<u8> = Vec::new();
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break, // EOF — child done
                            Ok(n) => {
                                tail.extend_from_slice(&buf[..n]);
                                let owned = std::mem::take(&mut tail);
                                let (good, leftover) = stitch_utf8(&owned);
                                tail = leftover;
                                if !good.is_empty() {
                                    let _ = app.emit(
                                        &format!(
                                            "console:{handle_for_thread}:data"
                                        ),
                                        good,
                                    );
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    // Flush any trailing bytes we never completed —
                    // emit them lossily so the user sees *something*
                    // rather than silently swallowing the tail.
                    if !tail.is_empty() {
                        let chunk = String::from_utf8_lossy(&tail).to_string();
                        let _ = app.emit(
                            &format!("console:{handle_for_thread}:data"),
                            chunk,
                        );
                    }
                    if let Ok(mut g) = reaper_done.lock() {
                        *g = true;
                    }
                    let _ = app.emit(
                        &format!("console:{handle_for_thread}:exit"),
                        serde_json::json!({"reason": "eof"}),
                    );
                })
                .map_err(|e| AppError::InvalidState(format!("spawn reader: {e}")))?;
        }

        let result = OpenResult {
            handle: handle.clone(),
            mode: args.mode,
            binary_path: binary.display().to_string(),
            cwd: cwd.display().to_string(),
            argv: argv.clone(),
        };
        inner.sessions.insert(
            handle,
            Session {
                mode: args.mode,
                cwd: cwd.display().to_string(),
                argv,
                master: pair.master,
                writer,
                child,
                reaper_done,
            },
        );
        Ok(result)
    }

    /// Write bytes to the child's stdin. Frontend passes the raw
    /// bytes the user typed (or a control sequence like `\u{0003}`
    /// for Ctrl+C). Empty payload is a no-op.
    pub fn send(&self, handle: &Handle, bytes: &[u8]) -> AppResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        let s = inner
            .sessions
            .get_mut(handle)
            .ok_or_else(|| AppError::NotFound(format!("console session {handle}")))?;
        if let Ok(g) = s.reaper_done.lock() {
            if *g {
                return Err(AppError::InvalidState("session has exited".into()));
            }
        }
        s.writer
            .write_all(bytes)
            .map_err(|e| AppError::InvalidState(format!("write: {e}")))?;
        s.writer
            .flush()
            .map_err(|e| AppError::InvalidState(format!("flush: {e}")))?;
        Ok(())
    }

    /// Resize the PTY window. Called from the renderer's resize
    /// observer so `claude` re-flows long lines correctly.
    pub fn resize(&self, handle: &Handle, rows: u16, cols: u16) -> AppResult<()> {
        if rows == 0 || cols == 0 {
            return Ok(());
        }
        let inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        let s = inner
            .sessions
            .get(handle)
            .ok_or_else(|| AppError::NotFound(format!("console session {handle}")))?;
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::InvalidState(format!("resize: {e}")))?;
        Ok(())
    }

    /// SIGINT the child, then SIGKILL after a 2s grace if it hasn't
    /// exited. PRD-116 §3 #11 success criterion. Runs synchronously
    /// — caller is on a `spawn_blocking` runtime so blocking 2s here
    /// is fine.
    pub fn cancel(&self, handle: &Handle) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        let s = inner
            .sessions
            .get_mut(handle)
            .ok_or_else(|| AppError::NotFound(format!("console session {handle}")))?;
        // Send Ctrl+C through the PTY so claude's signal handler runs.
        // Direct SIGINT on the child group also works on Unix; PTY
        // delivery is portable across platforms portable-pty supports.
        let _ = s.writer.write_all(&[0x03]);
        let _ = s.writer.flush();
        let deadline = Instant::now() + Duration::from_millis(2000);
        loop {
            match s.child.try_wait() {
                Ok(Some(_status)) => return Ok(()),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = s.child.kill();
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

    /// Tear the session down: kill the child if alive, drop the
    /// writer, remove from the map. Idempotent — closing a closed
    /// handle is a no-op.
    pub fn close(&self, handle: &Handle) -> AppResult<()> {
        let mut inner = self.inner.lock().map_err(|_| AppError::Poisoned)?;
        if let Some(mut s) = inner.sessions.remove(handle) {
            // Best-effort EOF on stdin so claude exits cleanly.
            let _ = s.writer.flush();
            drop(s.writer);
            // Kill if still alive. Don't wait — the OS reaps via
            // the reader task which is already running.
            let _ = s.child.kill();
        }
        Ok(())
    }

    /// Snapshot of currently-open handles. Useful for sidebar
    /// "things still running" badging in a future commit.
    #[allow(dead_code)]
    pub fn list(&self) -> Vec<Handle> {
        self.inner
            .lock()
            .map(|g| g.sessions.keys().cloned().collect())
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.inner.lock().map(|g| g.sessions.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(mode: ConsoleMode) -> OpenArgs {
        OpenArgs {
            cwd: String::new(),
            mode,
            model: String::new(),
            permission_mode: String::new(),
            resume_id: String::new(),
            rows: 0,
            cols: 0,
        }
    }

    fn s(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn build_argv_empty_when_no_overrides() {
        let argv = build_argv(&args(ConsoleMode::Raw), &[]);
        assert!(argv.is_empty(), "got {argv:?}");
    }

    #[test]
    fn build_argv_passes_model_and_permission_mode() {
        let mut a = args(ConsoleMode::Raw);
        a.model = "claude-opus-4-7".into();
        a.permission_mode = "plan".into();
        let argv = build_argv(&a, &[]);
        assert_eq!(
            argv,
            vec!["--model", "claude-opus-4-7", "--permission-mode", "plan"]
        );
    }

    #[test]
    fn build_argv_passes_resume_id() {
        let mut a = args(ConsoleMode::Raw);
        a.resume_id = "abc-123".into();
        let argv = build_argv(&a, &[]);
        assert_eq!(argv, vec!["--resume", "abc-123"]);
    }

    #[test]
    fn build_argv_trims_whitespace_and_skips_empty() {
        let mut a = args(ConsoleMode::Raw);
        a.model = "   ".into();
        a.permission_mode = "  acceptEdits  ".into();
        let argv = build_argv(&a, &[]);
        assert_eq!(argv, vec!["--permission-mode", "acceptEdits"]);
    }

    #[test]
    fn inherited_args_pass_through_when_no_overrides() {
        // The default Settings → Claude args (minus --print) are what
        // a User-style configuration should drop into argv when the
        // Console is opened with no per-session overrides.
        let extra = s(&[
            "--print",
            "--permission-mode",
            "auto",
            "--model",
            "opus",
            "--effort",
            "xhigh",
        ]);
        let argv = build_argv(&args(ConsoleMode::Raw), &extra);
        // --print is stripped; everything else passes through.
        assert_eq!(
            argv,
            vec![
                "--permission-mode",
                "auto",
                "--model",
                "opus",
                "--effort",
                "xhigh"
            ]
        );
    }

    #[test]
    fn inherited_args_strip_print_with_no_value() {
        // `--print` is a boolean flag; stripping must not consume the
        // next arg as a value.
        let extra = s(&["--print", "--effort", "xhigh"]);
        let argv = build_argv(&args(ConsoleMode::Raw), &extra);
        assert_eq!(argv, vec!["--effort", "xhigh"]);
    }

    #[test]
    fn inherited_args_strip_short_print_p() {
        let extra = s(&["-p", "--effort", "xhigh"]);
        let argv = build_argv(&args(ConsoleMode::Raw), &extra);
        assert_eq!(argv, vec!["--effort", "xhigh"]);
    }

    #[test]
    fn inherited_args_strip_output_format_with_value() {
        // --output-format takes a value; stripping must skip both.
        let extra = s(&["--output-format", "stream-json", "--model", "opus"]);
        let argv = build_argv(&args(ConsoleMode::Raw), &extra);
        assert_eq!(argv, vec!["--model", "opus"]);
    }

    #[test]
    fn per_session_overrides_drop_inherited_duplicates() {
        // User has --model opus saved; opens a Console with --model
        // sonnet. The argv should carry sonnet *once*, not both.
        let extra = s(&["--model", "opus", "--effort", "xhigh"]);
        let mut a = args(ConsoleMode::Raw);
        a.model = "claude-sonnet-4-6".into();
        let argv = build_argv(&a, &extra);
        assert_eq!(
            argv,
            vec![
                "--effort",
                "xhigh",
                "--model",
                "claude-sonnet-4-6"
            ]
        );
    }

    #[test]
    fn per_session_permission_mode_overrides_inherited() {
        let extra = s(&["--permission-mode", "auto", "--effort", "xhigh"]);
        let mut a = args(ConsoleMode::Raw);
        a.permission_mode = "plan".into();
        let argv = build_argv(&a, &extra);
        assert_eq!(
            argv,
            vec![
                "--effort",
                "xhigh",
                "--permission-mode",
                "plan"
            ]
        );
    }

    #[test]
    fn inherited_args_handle_eq_value_form() {
        // Some users write --model=opus instead of --model opus.
        let extra = s(&["--model=opus", "--effort=xhigh"]);
        let argv = build_argv(&args(ConsoleMode::Raw), &extra);
        assert_eq!(argv, vec!["--model=opus", "--effort=xhigh"]);
    }

    #[test]
    fn inherited_args_strip_print_eq_value_form() {
        let extra = s(&["--print=", "--effort", "xhigh"]);
        let argv = build_argv(&args(ConsoleMode::Raw), &extra);
        assert_eq!(argv, vec!["--effort", "xhigh"]);
    }

    #[test]
    fn stitch_utf8_passes_complete_input_through() {
        let (good, tail) = stitch_utf8(b"hello, world");
        assert_eq!(good, "hello, world");
        assert!(tail.is_empty());
    }

    #[test]
    fn stitch_utf8_empty_is_empty() {
        let (good, tail) = stitch_utf8(b"");
        assert!(good.is_empty());
        assert!(tail.is_empty());
    }

    #[test]
    fn stitch_utf8_holds_split_two_byte_codepoint() {
        // "é" is U+00E9 → 0xC3 0xA9. Send only the first byte; expect
        // empty good output and a 1-byte tail.
        let (good, tail) = stitch_utf8(&[0xC3]);
        assert!(good.is_empty(), "got {good:?}");
        assert_eq!(tail, vec![0xC3]);
        // Now send the rest prepended — should emit "é".
        let mut combined = tail;
        combined.push(0xA9);
        let (good2, tail2) = stitch_utf8(&combined);
        assert_eq!(good2, "é");
        assert!(tail2.is_empty());
    }

    #[test]
    fn stitch_utf8_holds_split_four_byte_codepoint() {
        // 🦀 is U+1F980 → F0 9F A6 80. Drip-feed the bytes one at a
        // time; only the final byte should produce output.
        let bytes = [0xF0, 0x9F, 0xA6, 0x80];
        let mut tail: Vec<u8> = Vec::new();
        let mut all_good = String::new();
        for b in bytes {
            tail.push(b);
            let owned = std::mem::take(&mut tail);
            let (good, new_tail) = stitch_utf8(&owned);
            all_good.push_str(&good);
            tail = new_tail;
        }
        assert_eq!(all_good, "🦀");
        assert!(tail.is_empty());
    }

    #[test]
    fn stitch_utf8_emits_replacement_for_invalid_byte() {
        // 0xFF is never valid in UTF-8. Should produce U+FFFD and
        // not stick around as a tail.
        let (good, tail) = stitch_utf8(&[0x41, 0xFF, 0x42]);
        assert_eq!(good, "A\u{FFFD}B");
        assert!(tail.is_empty());
    }

    #[test]
    fn stitch_utf8_handles_box_drawing_unsplit() {
        // Box-drawing chars are 3-byte (U+2500..U+257F). Common in
        // claude's progress bars / spinners. When fully delivered,
        // they pass through.
        let (good, tail) = stitch_utf8("─┐│".as_bytes());
        assert_eq!(good, "─┐│");
        assert!(tail.is_empty());
    }

    #[test]
    fn manager_starts_empty() {
        let m = Manager::new();
        assert_eq!(m.count(), 0);
        assert!(m.list().is_empty());
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
        let err = m.send(&h, b"hi");
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
    }

    #[test]
    fn resize_to_unknown_handle_errors() {
        let m = Manager::new();
        let h: Handle = "nope".into();
        let err = m.resize(&h, 24, 80);
        assert!(matches!(err, Err(AppError::NotFound(_))), "got {err:?}");
    }

    #[test]
    fn resize_zero_dims_is_noop() {
        let m = Manager::new();
        // Even with no session, a zero-dim call returns Ok before the
        // session lookup — guards against renderers that fire 0×0
        // resizes during initial layout.
        let h: Handle = "ignored".into();
        assert!(m.resize(&h, 0, 80).is_ok());
        assert!(m.resize(&h, 24, 0).is_ok());
    }
}
