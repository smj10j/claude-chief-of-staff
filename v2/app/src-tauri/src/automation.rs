//! PRD-103 Phase 0.5 — automation setup IPCs.
//!
//! Wraps the bash setup scripts under `bin/reminders/`,
//! `bin/weekly-review/`, and `bin/schedule/`
//! so the wizard can offer one-click install of the launchd agents
//! that run those skills on a schedule. Scripts are resolved from
//! the dev repo when reachable; otherwise fall back to the
//! bundled-resource copy.
//!
//! Each install path is a shell-out — the scripts know how to
//! create + load a launchctl plist. We don't reimplement that in
//! Rust because the bash version is already battle-tested by the
//! CLI workflow, and parity matters: a user who installs from the
//! wizard should land in the same state as one who runs the
//! scripts by hand.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Which cron we're operating on. Maps to a script + relative path.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CronKind {
    /// `bin/reminders/overdue-notifier-setup.sh`
    RemindersOverdue,
    /// `bin/weekly-review/weekly-review-setup.sh`
    WeeklyReview,
    /// `bin/schedule/morning-briefing-setup.sh`
    MorningBriefing,
}

impl CronKind {
    fn script_relpath(self) -> &'static str {
        match self {
            Self::RemindersOverdue => "bin/reminders/overdue-notifier-setup.sh",
            Self::WeeklyReview => "bin/weekly-review/weekly-review-setup.sh",
            Self::MorningBriefing => "bin/schedule/morning-briefing-setup.sh",
        }
    }

    #[allow(dead_code)] // used by frontend metadata; kept for future Settings UI
    pub fn label(self) -> &'static str {
        match self {
            Self::RemindersOverdue => "Apple Reminders overdue notifier",
            Self::WeeklyReview => "Weekly review (Friday 8 PM)",
            Self::MorningBriefing => "Morning briefing (daily 7 AM)",
        }
    }
}

#[derive(Serialize)]
pub struct CronOpResult {
    pub kind: String,
    pub action: String,
    pub status: String,
    pub stdout: String,
    pub stderr: String,
}

/// Resolve the setup script path. Tries the dev workflow first
/// (script lives in the repo) then the bundle-resource copy.
fn resolve_script(
    kind: CronKind,
    bundle_resource_dir: Option<&Path>,
    repo_root: Option<&Path>,
) -> AppResult<PathBuf> {
    let rel = kind.script_relpath();
    if let Some(rr) = repo_root {
        let p = rr.join(rel);
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Some(rd) = bundle_resource_dir {
        let p = rd.join(rel);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err(AppError::NotFound(format!(
        "automation script not found at {rel} — checked repo + bundle resources",
    )))
}

/// Run `<script> <action>` and capture the result. Action is one
/// of "install" / "uninstall" / "status" — the scripts share that
/// CLI shape.
pub fn run_cron_op(
    kind: CronKind,
    action: &str,
    bundle_resource_dir: Option<&Path>,
    repo_root: Option<&Path>,
) -> AppResult<CronOpResult> {
    let allowed = ["install", "uninstall", "status"];
    if !allowed.contains(&action) {
        return Err(AppError::InvalidState(format!(
            "unknown action '{action}' (expected install/uninstall/status)",
        )));
    }
    let script = resolve_script(kind, bundle_resource_dir, repo_root)?;
    // Use `bash` explicitly so we don't depend on the script being
    // marked executable (bundled resources sometimes lose +x).
    let out = Command::new("bash")
        .arg(&script)
        .arg(action)
        .output()
        .map_err(|e| {
            AppError::InvalidState(format!("spawn {}: {e}", script.display()))
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let status = if out.status.success() { "ok" } else { "error" };
    Ok(CronOpResult {
        kind: format!("{:?}", kind),
        action: action.to_string(),
        status: status.to_string(),
        stdout,
        stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_action() {
        let err = run_cron_op(CronKind::WeeklyReview, "delete-everything", None, None);
        assert!(err.is_err());
    }

    #[test]
    fn errors_when_script_missing() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Empty repo root — no scripts present
        let err = run_cron_op(
            CronKind::RemindersOverdue,
            "status",
            None,
            Some(tmp.path()),
        );
        assert!(err.is_err());
    }
}
