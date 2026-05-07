//! Install / first-run readiness check (M5).
//!
//! A small typed snapshot the frontend can read to know whether the
//! app is "ready to use" or whether the user still has setup steps.
//! Three things matter for v2 today:
//!
//!   1. Content root — does `data/files/` exist? Without it, every
//!      surface renders empty and the user has no signal why.
//!   2. Claude CLI — is the binary discoverable? Without it, every
//!      skill (briefing, prep, triage) errors at run time.
//!   3. Calendar source — is the user's chosen transport ready?
//!      ICS = URL set; EventKit = adapter script + Swift toolchain
//!      present. Either OK is enough; both unset = setup needed.
//!
//! The IPC returns one entry per check with `ok` + a one-line
//! `detail` string for human display + a `fix_hint` pointing at the
//! relevant Settings tab. Frontend joins these with the existing
//! Diagnostics readout.

use std::path::Path;

use serde::Serialize;

use crate::error::AppResult;

#[derive(Serialize, Clone, Debug)]
pub struct InstallCheck {
    /// Stable kebab-case id — frontend uses this to deep-link to the
    /// right Settings tab.
    pub id: String,
    pub label: String,
    pub ok: bool,
    /// One-line human-readable status. Either the success answer
    /// ("found at /usr/local/bin/claude") or the failure reason
    /// ("set the path in Settings → Claude Code").
    pub detail: String,
    /// "settings:claude" | "settings:calendar" | "" — frontend
    /// dispatches `cos:goto` with the section to deep-link.
    pub fix_hint: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct InstallStatus {
    pub checks: Vec<InstallCheck>,
    pub all_ok: bool,
}

/// Compute the readiness checks. Pure: takes a content root path, an
/// (optional) claude binary path, and a calendar source descriptor.
/// `eventkit_script_present` is computed by the caller because it
/// needs the repo-root resolution that lives in lib.rs.
pub fn compute(
    content_root: &Path,
    claude_binary: Option<&Path>,
    calendar_ics_url: &str,
    calendar_transport: &str,
    eventkit_script_present: bool,
) -> AppResult<InstallStatus> {
    let mut checks = Vec::new();

    // 1. Content root.
    let content_ok = content_root.is_dir();
    checks.push(InstallCheck {
        id: "content-root".into(),
        label: "Content root".into(),
        ok: content_ok,
        detail: if content_ok {
            format!("found at {}", content_root.display())
        } else {
            format!(
                "{} not found — create the directory or run /init in Claude Code",
                content_root.display(),
            )
        },
        fix_hint: String::new(),
    });

    // 2. Claude CLI.
    let claude_ok = claude_binary.map(|p| p.is_file()).unwrap_or(false);
    checks.push(InstallCheck {
        id: "claude-cli".into(),
        label: "Claude Code CLI".into(),
        ok: claude_ok,
        detail: match claude_binary {
            Some(p) if p.is_file() => format!("found at {}", p.display()),
            Some(_) => "binary path is set but the file isn't there".into(),
            None => "not found on PATH; set the path in Settings → Claude Code".into(),
        },
        fix_hint: "settings:claude".into(),
    });

    // 3. Calendar source.
    let want_eventkit = calendar_transport == "eventkit";
    let cal_ok = if want_eventkit {
        eventkit_script_present
    } else {
        !calendar_ics_url.trim().is_empty()
    };
    checks.push(InstallCheck {
        id: "calendar-source".into(),
        label: "Calendar source".into(),
        ok: cal_ok,
        detail: if want_eventkit {
            if cal_ok {
                "EventKit adapter present — first refresh prompts macOS for permission".into()
            } else {
                "EventKit selected but bin/calendar/eventkit.sh isn't reachable".into()
            }
        } else if cal_ok {
            "ICS subscription URL configured".into()
        } else {
            "no source configured — Settings → Calendar".into()
        },
        fix_hint: "settings:calendar".into(),
    });

    let all_ok = checks.iter().all(|c| c.ok);
    Ok(InstallStatus { checks, all_ok })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn all_ok_when_everything_resolves() {
        let tmp = TempDir::new().unwrap();
        // Make a fake content root + claude binary + ICS URL.
        std::fs::create_dir_all(tmp.path().join("data/files")).unwrap();
        let bin = tmp.path().join("claude");
        std::fs::write(&bin, "#!/bin/bash").unwrap();
        let status = compute(
            &tmp.path().join("data/files"),
            Some(&bin),
            "https://example.com/calendar.ics",
            "ics",
            false,
        )
        .unwrap();
        assert!(status.all_ok);
        assert!(status.checks.iter().all(|c| c.ok));
    }

    #[test]
    fn flags_missing_content_root() {
        let tmp = TempDir::new().unwrap();
        let status = compute(
            &tmp.path().join("missing"),
            None,
            "",
            "eventkit",
            false,
        )
        .unwrap();
        assert!(!status.all_ok);
        let content = status.checks.iter().find(|c| c.id == "content-root").unwrap();
        assert!(!content.ok);
        assert!(content.detail.contains("not found"));
    }

    #[test]
    fn eventkit_transport_passes_when_script_present() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("data/files")).unwrap();
        let status = compute(
            &tmp.path().join("data/files"),
            None,
            "",
            "eventkit",
            true,
        )
        .unwrap();
        let cal = status.checks.iter().find(|c| c.id == "calendar-source").unwrap();
        assert!(cal.ok);
        assert!(cal.detail.contains("EventKit"));
    }

    #[test]
    fn ics_transport_fails_when_url_blank() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("data/files")).unwrap();
        let status = compute(
            &tmp.path().join("data/files"),
            None,
            "   ", // whitespace-only counts as blank
            "ics",
            false,
        )
        .unwrap();
        let cal = status.checks.iter().find(|c| c.id == "calendar-source").unwrap();
        assert!(!cal.ok);
        assert_eq!(cal.fix_hint, "settings:calendar");
    }
}
