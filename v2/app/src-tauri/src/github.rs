//! gh CLI seam. Drives the user's locally-installed `gh` binary as a
//! subprocess — no PAT management, no octokit. The user supplies `gh`
//! on $PATH and stays signed in via `gh auth login`; we shell out for
//! every call.
//!
//! Velocity (PRD-109) reads PR + Jira + CI data through this module
//! and an Atlassian-MCP-via-claude path. Keeping the surface narrow
//! here (status, run_gh) means the eventual swap to a hosted GitHub
//! integration only touches one file.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Resolve which `gh` binary to call. Same priority order as
/// `claude::resolve_binary` for consistency:
///   1. `$PATH` first (mirrors how the user runs gh in their terminal).
///   2. Common Homebrew + system locations as a fallback (Tauri apps
///      launched from Finder inherit a minimal PATH).
pub fn resolve_binary() -> Option<PathBuf> {
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join("gh");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/gh"),
        PathBuf::from("/usr/local/bin/gh"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Snapshot of the user's gh install + auth state. Returned from
/// `gh_status` so Settings → GitHub can render a one-shot health card
/// without round-tripping for every field.
#[derive(Serialize, Default, Debug, Clone)]
pub struct GhStatus {
    /// Resolved absolute path to the binary. None means we couldn't
    /// find one anywhere.
    pub binary_path: Option<String>,
    /// True when `gh auth status` reports the active account is
    /// logged in to github.com (the only host the rest of v2 talks
    /// to today).
    pub authed: bool,
    /// Login of the active account (e.g. `user-example`).
    /// None when not authed or when we couldn't parse it.
    pub login: Option<String>,
    /// Token scopes parsed from `gh auth status`. Empty when not
    /// authed.
    pub scopes: Vec<String>,
    /// Scopes gh itself flagged as missing (e.g. `read:org`). When
    /// non-empty, surface a hint in Settings.
    pub missing_scopes: Vec<String>,
    /// One-line diagnostic from `gh auth status` when authed=false,
    /// so we can show the user *why* they're not authed (vs. silently
    /// rendering an empty card).
    pub error: Option<String>,
}

/// Run `gh auth status -h github.com` and parse the output into a
/// status struct. We deliberately avoid `--json` here — that flag
/// only exists on a recent gh and the human output is stable
/// enough for our needs (login line, scopes line, missing-scopes
/// line).
pub fn status() -> GhStatus {
    let bin = match resolve_binary() {
        Some(p) => p,
        None => {
            return GhStatus {
                error: Some("gh binary not found on $PATH".into()),
                ..Default::default()
            };
        }
    };

    let mut cmd = Command::new(&bin);
    cmd.args(["auth", "status", "-h", "github.com"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let out = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            return GhStatus {
                binary_path: Some(bin.display().to_string()),
                error: Some(format!("spawn {}: {e}", bin.display())),
                ..Default::default()
            };
        }
    };

    // gh writes auth status to stderr historically; recent versions
    // also emit on stdout. Concatenate both so the parser doesn't
    // have to know the version.
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );

    let parsed = parse_auth_status(&combined);
    GhStatus {
        binary_path: Some(bin.display().to_string()),
        ..parsed
    }
}

/// Pure parser for `gh auth status` output. Exposed for tests.
pub fn parse_auth_status(raw: &str) -> GhStatus {
    let mut authed = false;
    let mut login: Option<String> = None;
    let mut scopes: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut error: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // "✓ Logged in to github.com account <login> (...)"
        if let Some(rest) = trimmed.strip_prefix("✓ Logged in to github.com account ") {
            authed = true;
            login = Some(
                rest.split_whitespace()
                    .next()
                    .unwrap_or(rest)
                    .to_string(),
            );
            continue;
        }
        // Some recent gh phrasing: "Logged in to github.com as <login> (...)"
        if let Some(rest) = trimmed.strip_prefix("Logged in to github.com as ") {
            authed = true;
            login = Some(
                rest.split_whitespace()
                    .next()
                    .unwrap_or(rest)
                    .to_string(),
            );
            continue;
        }
        // "- Token scopes: 'a', 'b', ..."
        if let Some(rest) = trimmed.strip_prefix("- Token scopes:") {
            scopes = parse_quoted_list(rest);
            continue;
        }
        // "! Missing required token scopes: 'read:org'"
        if let Some(rest) = trimmed.strip_prefix("! Missing required token scopes:") {
            missing = parse_quoted_list(rest);
            continue;
        }
        // First "X" / "error" line if we never saw a tick
        if !authed && (trimmed.starts_with('X') || trimmed.to_lowercase().contains("error"))
            && error.is_none()
        {
            error = Some(trimmed.to_string());
        }
    }

    GhStatus {
        authed,
        login,
        scopes,
        missing_scopes: missing,
        error,
        binary_path: None, // caller fills
    }
}

/// Pull comma-separated single-quoted tokens out of a line tail.
/// Examples handled:
///   `'repo', 'user', 'gist'`  →  ["repo", "user", "gist"]
///   `  'read:org'           `  →  ["read:org"]
fn parse_quoted_list(tail: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = tail.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c == '\'' {
            chars.next();
            let mut buf = String::new();
            while let Some(c2) = chars.next() {
                if c2 == '\'' {
                    break;
                }
                buf.push(c2);
            }
            if !buf.is_empty() {
                out.push(buf);
            }
        } else {
            chars.next();
        }
    }
    out
}

/// One PR row, normalised for the Velocity surface. Mirrors the
/// subset of `gh search prs --json …` we actually render. The
/// stable shape (rather than passing raw gh JSON to the UI) means
/// future swaps to the GitHub REST API or the GraphQL search API
/// don't ripple beyond this module.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PrRow {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub author: String,
    /// True when gh reported this author as a bot (dependabot, renovate,
    /// github-actions). The frontend uses this for the bot-author
    /// exclusion filter (B8-CP12).
    pub author_is_bot: bool,
    pub is_draft: bool,
    pub created_at: String,
    pub updated_at: String,
    pub labels: Vec<String>,
}

/// `gh search prs --author=@me --state=open` (PRs the user opened).
/// Returns PRs sorted by `updated_at` desc — gh's default — and lets
/// the frontend re-sort by attention score (B8-CP8).
pub fn my_prs(limit: u32) -> AppResult<Vec<PrRow>> {
    let limit_str = limit.to_string();
    let args = [
        "search",
        "prs",
        "--author=@me",
        "--state=open",
        "--json",
        "title,number,url,repository,author,createdAt,updatedAt,isDraft,labels",
        "--limit",
        &limit_str,
    ];
    let raw = run_gh(&args)?;
    parse_pr_rows(&raw)
}

/// CI rollup for one PR. Three coarse states + an optional summary
/// string the UI can show on hover. Coarse on purpose — the row
/// only has space for a dot, and "details" is a click-through to
/// the PR.
#[derive(Serialize, Debug, Clone)]
pub struct CiStatus {
    /// "green" / "yellow" / "red" / "unknown".
    pub state: String,
    /// Short human-readable line e.g. "12 passing · 1 pending".
    pub summary: String,
}

/// Fetch CI rollup via `gh pr checks <repo>/<num> --json` and reduce
/// to a single state. Failures collapse to "unknown" — we never
/// lie about failures, but a PR with no checks shouldn't render
/// red either.
pub fn pr_ci_status(repo: &str, number: i64) -> AppResult<CiStatus> {
    let arg = format!("{repo}#{number}");
    let args = ["pr", "checks", &arg, "--json", "state,name"];
    // gh pr checks exits non-zero when at least one check failed —
    // that's still a successful query for our purposes. Read the
    // exit code separately and parse stdout regardless.
    let bin = resolve_binary().ok_or_else(|| {
        AppError::NotFound("gh not found on $PATH".into())
    })?;
    let mut cmd = Command::new(&bin);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let out = cmd
        .output()
        .map_err(|e| AppError::InvalidState(format!("spawn gh: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if stdout.trim().is_empty() {
        // No checks configured. Don't surface as red.
        if stderr.contains("no checks") || stderr.contains("no required") {
            return Ok(CiStatus {
                state: "unknown".into(),
                summary: "no checks".into(),
            });
        }
        return Ok(CiStatus {
            state: "unknown".into(),
            summary: stderr.trim().chars().take(80).collect(),
        });
    }
    Ok(reduce_ci(&stdout))
}

#[derive(Deserialize)]
struct GhCheck {
    #[serde(default)]
    state: String,
}

/// Pure reducer — many checks → one CiStatus.
pub fn reduce_ci(raw: &str) -> CiStatus {
    let parsed: Vec<GhCheck> = serde_json::from_str(raw).unwrap_or_default();
    if parsed.is_empty() {
        return CiStatus {
            state: "unknown".into(),
            summary: "no checks".into(),
        };
    }
    let mut pass = 0;
    let mut fail = 0;
    let mut pending = 0;
    for c in &parsed {
        // gh emits state values like SUCCESS, FAILURE, PENDING,
        // ERROR, EXPECTED, COMPLETED, IN_PROGRESS, QUEUED, etc.
        // Normalise to the three buckets we render.
        let s = c.state.to_uppercase();
        match s.as_str() {
            "SUCCESS" | "COMPLETED" | "EXPECTED" => pass += 1,
            "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" | "CANCELLED" => {
                fail += 1
            }
            "PENDING" | "IN_PROGRESS" | "QUEUED" | "WAITING" => pending += 1,
            _ => pending += 1,
        }
    }
    let state = if fail > 0 {
        "red"
    } else if pending > 0 {
        "yellow"
    } else if pass > 0 {
        "green"
    } else {
        "unknown"
    }
    .to_string();
    let summary = format!("{pass} passing · {pending} pending · {fail} failing");
    CiStatus { state, summary }
}

/// PR detail used by the inline expand row (B9-CP11). Fetched on
/// demand per row (not eager) so we don't burn `gh` quota on every
/// list refresh.
#[derive(Serialize, Debug, Clone)]
pub struct PrDetail {
    pub body: String,
    /// Recent review comments (top-level reviews only — line comments
    /// would be too noisy in a side-panel).
    pub reviews: Vec<PrReview>,
    /// Reviewer count from the requested-reviewers list. Feeds the
    /// attention-score reviewer divisor (B9-CP12).
    pub reviewer_count: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PrReview {
    pub author: String,
    pub state: String,
    pub body: String,
    pub submitted_at: String,
}

/// `gh pr view <repo>#<num> --json body,reviews,reviewRequests` then
/// reduce. We pass a single string arg "<owner>/<repo>#<num>" because
/// gh's pr-view accepts that form across repos.
pub fn pr_detail(repo: &str, number: i64) -> AppResult<PrDetail> {
    let arg = format!("{repo}#{number}");
    let raw = run_gh(&[
        "pr",
        "view",
        &arg,
        "--json",
        "body,reviews,reviewRequests",
    ])?;
    parse_pr_detail(&raw)
}

#[derive(Deserialize)]
struct GhPrDetail {
    #[serde(default)]
    body: String,
    #[serde(default)]
    reviews: Vec<GhReview>,
    #[serde(default, rename = "reviewRequests")]
    review_requests: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct GhReview {
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(default, rename = "submittedAt")]
    submitted_at: String,
    #[serde(default)]
    author: GhReviewAuthor,
}

#[derive(Deserialize, Default)]
struct GhReviewAuthor {
    #[serde(default)]
    login: String,
}

pub fn parse_pr_detail(raw: &str) -> AppResult<PrDetail> {
    let parsed: GhPrDetail = serde_json::from_str(raw).map_err(|e| {
        AppError::InvalidState(format!("gh pr view parse: {e}"))
    })?;
    let mut reviews: Vec<PrReview> = parsed
        .reviews
        .into_iter()
        .filter(|r| !r.body.is_empty() || r.state != "COMMENTED")
        .map(|r| PrReview {
            author: r.author.login,
            state: r.state,
            body: r.body,
            submitted_at: r.submitted_at,
        })
        .collect();
    // Most-recent first; cap at 5 so the panel stays compact.
    reviews.sort_by(|a, b| b.submitted_at.cmp(&a.submitted_at));
    reviews.truncate(5);
    Ok(PrDetail {
        body: parsed.body,
        reviews,
        reviewer_count: parsed.review_requests.len() as u32,
    })
}

/// `gh search prs --author=<login>` — PRs opened by an arbitrary
/// GitHub user. Used by Person Profile (B9-CP31) when the person's
/// github_login is set.
pub fn prs_for_author(login: &str, limit: u32) -> AppResult<Vec<PrRow>> {
    let limit_str = limit.to_string();
    let author = format!("--author={login}");
    let args = [
        "search",
        "prs",
        author.as_str(),
        "--state=open",
        "--json",
        "title,number,url,repository,author,createdAt,updatedAt,isDraft,labels",
        "--limit",
        &limit_str,
    ];
    let raw = run_gh(&args)?;
    parse_pr_rows(&raw)
}

/// `gh search prs --review-requested=@me --state=open` — PRs blocking
/// you. Same parsing path as `my_prs` so any normalisation tweak lands
/// in one place.
pub fn review_requested_prs(limit: u32) -> AppResult<Vec<PrRow>> {
    let limit_str = limit.to_string();
    let args = [
        "search",
        "prs",
        "--review-requested=@me",
        "--state=open",
        "--json",
        "title,number,url,repository,author,createdAt,updatedAt,isDraft,labels",
        "--limit",
        &limit_str,
    ];
    let raw = run_gh(&args)?;
    parse_pr_rows(&raw)
}

#[derive(Deserialize)]
struct GhPr {
    title: String,
    number: i64,
    url: String,
    repository: GhRepo,
    author: GhAuthor,
    #[serde(default, rename = "isDraft")]
    is_draft: bool,
    #[serde(rename = "createdAt", default)]
    created_at: String,
    #[serde(rename = "updatedAt", default)]
    updated_at: String,
    #[serde(default)]
    labels: Vec<GhLabel>,
}
#[derive(Deserialize)]
struct GhRepo {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}
#[derive(Deserialize)]
struct GhAuthor {
    #[serde(default)]
    login: String,
    #[serde(default, rename = "is_bot")]
    is_bot: bool,
}
#[derive(Deserialize)]
struct GhLabel {
    #[serde(default)]
    name: String,
}

/// Pure JSON-string → Vec<PrRow>. Exposed for tests so we can pin
/// the shape without spawning gh.
pub fn parse_pr_rows(raw: &str) -> AppResult<Vec<PrRow>> {
    // gh emits camelCase keys; serde renames lift them into the Rust
    // structs declared above this fn.
    let parsed: Vec<GhPr> = serde_json::from_str(raw).map_err(|e| {
        AppError::InvalidState(format!(
            "gh json parse: {e} (head: {})",
            &raw.chars().take(200).collect::<String>()
        ))
    })?;
    Ok(parsed
        .into_iter()
        .map(|p| PrRow {
            number: p.number,
            title: p.title,
            url: p.url,
            repo: p.repository.name_with_owner,
            author: p.author.login,
            author_is_bot: p.author.is_bot,
            is_draft: p.is_draft,
            created_at: p.created_at,
            updated_at: p.updated_at,
            labels: p
                .labels
                .into_iter()
                .map(|l| l.name)
                .filter(|n| !n.is_empty())
                .collect(),
        })
        .collect())
}

/// Run a one-shot gh command and return stdout. stderr is folded
/// into errors on non-zero exit so we don't lose `gh`'s own
/// diagnostics. 30 s wall-clock cap protects the UI from a wedged
/// network — gh has its own timeout but we belt-and-braces it.
pub fn run_gh(args: &[&str]) -> AppResult<String> {
    let bin = resolve_binary().ok_or_else(|| {
        AppError::NotFound("gh binary not found on $PATH; install gh and run `gh auth login`".into())
    })?;

    let mut cmd = Command::new(&bin);
    cmd.args(args);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::InvalidState(format!("spawn {}: {e}", bin.display())))?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(30) {
                    let _ = child.kill();
                    return Err(AppError::InvalidState(format!(
                        "gh {} timed out after 30s",
                        args.join(" ")
                    )));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                return Err(AppError::InvalidState(format!("wait gh: {e}")));
            }
        }
    }

    let out = child
        .wait_with_output()
        .map_err(|e| AppError::InvalidState(format!("wait gh: {e}")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(AppError::InvalidState(format!(
            "gh {} exited {}: {}",
            args.join(" "),
            out.status,
            stderr.trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_authed_status_with_scopes() {
        let raw = "github.com\n  ✓ Logged in to github.com account user-example (GITHUB_TOKEN)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: ghp_************************************\n  - Token scopes: 'admin:gpg_key', 'gist', 'notifications', 'repo', 'user'\n  ! Missing required token scopes: 'read:org'\n";
        let s = parse_auth_status(raw);
        assert!(s.authed);
        assert_eq!(s.login.as_deref(), Some("user-example"));
        assert!(s.scopes.contains(&"repo".to_string()));
        assert!(s.scopes.contains(&"gist".to_string()));
        assert_eq!(s.missing_scopes, vec!["read:org".to_string()]);
    }

    #[test]
    fn parses_unauthed_when_no_tick() {
        let raw = "github.com\n  X Not logged in to github.com\n";
        let s = parse_auth_status(raw);
        assert!(!s.authed);
        assert!(s.login.is_none());
        assert!(s.error.is_some());
    }

    #[test]
    fn parse_quoted_list_handles_trailing_quote_styles() {
        assert_eq!(
            parse_quoted_list(" 'a', 'b', 'c'"),
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
        );
        assert_eq!(parse_quoted_list("    'read:org'"), vec!["read:org".to_string()]);
        assert_eq!(parse_quoted_list("nothing here"), Vec::<String>::new());
    }

    #[test]
    fn parser_tolerates_alternate_login_phrasing() {
        let raw = "Logged in to github.com as user-example (oauth)\n";
        let s = parse_auth_status(raw);
        assert!(s.authed);
        assert_eq!(s.login.as_deref(), Some("user-example"));
    }

    #[test]
    fn parses_real_gh_search_prs_payload() {
        // Trimmed-down sample of `gh search prs --author=@me --json
        // title,number,url,repository,author,createdAt,updatedAt,isDraft,labels`.
        let raw = r#"[{"author":{"id":"U1","is_bot":false,"login":"user-example","type":"User","url":"https://github.com/user-example"},"createdAt":"2026-03-17T19:24:45Z","isDraft":true,"labels":[{"name":"feat"}],"number":1542,"repository":{"name":"location-service","nameWithOwner":"example-org/location-service"},"title":"Add ForwardGeocode RPC","updatedAt":"2026-03-17T20:25:44Z","url":"https://github.com/example-org/location-service/pull/1542"}]"#;
        let rows = parse_pr_rows(raw).unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.number, 1542);
        assert_eq!(r.title, "Add ForwardGeocode RPC");
        assert_eq!(r.url, "https://github.com/example-org/location-service/pull/1542");
        assert_eq!(r.repo, "example-org/location-service");
        assert_eq!(r.author, "user-example");
        assert!(!r.author_is_bot);
        assert!(r.is_draft);
        assert_eq!(r.labels, vec!["feat".to_string()]);
    }

    #[test]
    fn parses_pr_rows_with_bot_authors() {
        let raw = r#"[{"author":{"is_bot":true,"login":"dependabot[bot]"},"createdAt":"2026-04-01T10:00:00Z","isDraft":false,"labels":[],"number":7,"repository":{"name":"x","nameWithOwner":"o/x"},"title":"Bump deps","updatedAt":"2026-04-01T10:00:00Z","url":"https://github.com/o/x/pull/7"}]"#;
        let rows = parse_pr_rows(raw).unwrap();
        assert!(rows[0].author_is_bot);
        assert_eq!(rows[0].author, "dependabot[bot]");
    }

    #[test]
    fn parses_empty_payload_to_empty_vec() {
        let rows = parse_pr_rows("[]").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn ci_reducer_picks_red_when_any_failure() {
        let raw = r#"[{"state":"SUCCESS"},{"state":"FAILURE"},{"state":"SUCCESS"}]"#;
        let s = reduce_ci(raw);
        assert_eq!(s.state, "red");
        assert!(s.summary.contains("1 failing"));
    }

    #[test]
    fn ci_reducer_picks_yellow_when_pending_no_fail() {
        let raw = r#"[{"state":"SUCCESS"},{"state":"IN_PROGRESS"}]"#;
        let s = reduce_ci(raw);
        assert_eq!(s.state, "yellow");
    }

    #[test]
    fn ci_reducer_picks_green_when_all_pass() {
        let raw = r#"[{"state":"SUCCESS"},{"state":"SUCCESS"}]"#;
        let s = reduce_ci(raw);
        assert_eq!(s.state, "green");
    }

    #[test]
    fn ci_reducer_handles_empty_or_unparseable_payload() {
        assert_eq!(reduce_ci("[]").state, "unknown");
        assert_eq!(reduce_ci("not json").state, "unknown");
    }

    #[test]
    fn parse_pr_detail_extracts_body_reviews_and_reviewer_count() {
        let raw = "{\
\"body\":\"a body\",\
\"reviews\":[\
{\"state\":\"APPROVED\",\"body\":\"lgtm\",\"submittedAt\":\"2026-04-25T10:00:00Z\",\"author\":{\"login\":\"reviewer1\"}},\
{\"state\":\"CHANGES_REQUESTED\",\"body\":\"please address it\",\"submittedAt\":\"2026-04-24T18:00:00Z\",\"author\":{\"login\":\"reviewer2\"}}\
],\
\"reviewRequests\":[{\"login\":\"r3\"},{\"login\":\"r4\"}]\
}";
        let d = parse_pr_detail(raw).unwrap();
        assert_eq!(d.body, "a body");
        assert_eq!(d.reviews.len(), 2);
        assert_eq!(d.reviews[0].author, "reviewer1");
        assert_eq!(d.reviewer_count, 2);
    }

    #[test]
    fn parse_pr_detail_caps_reviews_at_five_most_recent() {
        let mut entries = Vec::new();
        for i in 0..10 {
            entries.push(format!(
                "{{\"state\":\"APPROVED\",\"body\":\"r{i}\",\"submittedAt\":\"2026-04-{:02}T00:00:00Z\",\"author\":{{\"login\":\"r{i}\"}}}}",
                i + 10
            ));
        }
        let raw = format!(
            "{{\"body\":\"x\",\"reviews\":[{}],\"reviewRequests\":[]}}",
            entries.join(",")
        );
        let d = parse_pr_detail(&raw).unwrap();
        assert_eq!(d.reviews.len(), 5);
        // First should be most recent submittedAt.
        assert_eq!(d.reviews[0].submitted_at, "2026-04-19T00:00:00Z");
    }
}
