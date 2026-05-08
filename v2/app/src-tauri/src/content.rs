use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::audit;
use crate::error::{AppError, AppResult};
use crate::snapshots::BlobStore;

/// Filename of the persisted user choice (lives in `<app_data>/`).
const ROOT_CHOICE_FILE: &str = "content-root.json";

#[derive(serde::Deserialize, serde::Serialize)]
struct RootChoice {
    root: String,
}

/// Resolution layered for runtime use, tried in this order:
///
/// 1. `$COS_CONTENT_ROOT` — explicit override; wins everything.
///    Useful for CI, sandboxed test launches, and the
///    fresh-install verification recipe (PRD-117 / install docs).
/// 2. Persisted user choice in `<app_data>/content-root.json` —
///    set the first time the user picks a folder, or via the
///    `content_root_set` IPC. Survives across upgrades.
/// 3. Walk up from cwd looking for `data/files/` — keeps the dev
///    workflow working when running from a repo checkout.
/// 4. Default fallback: `~/Documents/Chief of Staff/data/files/`.
///    Auto-created at startup so a packaged-build first-launch
///    succeeds without prompting. The path is stable so users can
///    find their data outside the app, and configurable later via
///    Settings if they want to point at a repo or a different home.
pub fn resolve_root_with_data_dir(data_dir: &Path) -> PathBuf {
    if let Ok(explicit) = std::env::var("COS_CONTENT_ROOT") {
        return PathBuf::from(explicit);
    }
    if let Some(stored) = read_root_choice(data_dir) {
        return stored;
    }
    if let Some(found) = walk_up_for_data_files() {
        return found;
    }
    let fallback = default_content_root();
    // Best-effort create; if it fails the directory just gets
    // re-attempted on first read/write through Content. We don't
    // surface the error here — the call happens during app setup
    // and a recoverable filesystem hiccup shouldn't crash boot.
    let _ = fs::create_dir_all(&fallback);
    fallback
}

/// `~/Documents/Chief of Staff/data/files/` on macOS, or a sane
/// fallback that doesn't require a home directory. The "Chief of
/// Staff" folder name matches the bundle's `productName`.
pub fn default_content_root() -> PathBuf {
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join("Documents")
        .join("Chief of Staff")
        .join("data")
        .join("files")
}

fn home_dir() -> Option<PathBuf> {
    // Avoid pulling in the `home` or `dirs` crates just for this —
    // $HOME is set on macOS/Linux, %USERPROFILE% on Windows.
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    None
}

fn walk_up_for_data_files() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut dir: Option<&Path> = Some(&cwd);
    while let Some(d) = dir {
        let candidate = d.join("data").join("files");
        if candidate.is_dir() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    None
}

/// Read the persisted user choice. Returns `None` if the file is
/// missing, malformed, or points at a path that no longer exists.
pub fn read_root_choice(data_dir: &Path) -> Option<PathBuf> {
    let path = data_dir.join(ROOT_CHOICE_FILE);
    let raw = fs::read_to_string(&path).ok()?;
    let choice: RootChoice = serde_json::from_str(&raw).ok()?;
    let pb = PathBuf::from(choice.root);
    // Don't honor a stale choice pointing at a deleted folder; fall
    // through so the caller can pick a default. The user can re-set
    // from Settings if they meant to.
    if pb.is_dir() {
        Some(pb)
    } else {
        None
    }
}

/// Write the user's content-root choice to `<data_dir>/content-root.json`.
/// The directory is created on demand (the path passes through
/// `Content::new`, so callers don't need to). Returns the canonical
/// path (post-create) the caller should now treat as the active root.
pub fn write_root_choice(data_dir: &Path, root: &Path) -> AppResult<PathBuf> {
    fs::create_dir_all(data_dir)?;
    fs::create_dir_all(root)?;
    let payload = RootChoice {
        root: root.to_string_lossy().into_owned(),
    };
    fs::write(
        data_dir.join(ROOT_CHOICE_FILE),
        serde_json::to_string_pretty(&payload)?,
    )?;
    Ok(root.to_path_buf())
}

/// PRD-103 §0.3 — copy the bundled starter content into the user's
/// content root if and only if the root looks empty. Idempotent: a
/// second launch is a no-op (the `areas/` subdir is the sentinel).
///
/// `bundle_root` is the path returned by Tauri's
/// `path::resource_dir()` joined with `starter-data/`. The
/// `.claude/commands/` portion is copied to the *parent* of the
/// content root (i.e. next to `data/`, matching the dev workflow's
/// repo layout where `.claude/commands/` lives at the repo root).
///
/// Returns `Ok(true)` when seeding actually happened, `Ok(false)`
/// when it was skipped (root already populated). Errors only on
/// real filesystem failures — a missing bundle resource is treated
/// as "no starter to seed" and returns `Ok(false)`.
pub fn seed_starter_content(
    bundle_starter: &Path,
    content_root: &Path,
) -> AppResult<bool> {
    // Sentinel: if `<content_root>/areas/` exists, the root has been
    // seeded (or filled in by hand); skip.
    if content_root.join("areas").exists() {
        return Ok(false);
    }
    if !bundle_starter.is_dir() {
        // Dev runs without a packaged bundle won't have the
        // resource dir — that's fine, the user is expected to have
        // their own data tree.
        return Ok(false);
    }

    fs::create_dir_all(content_root)?;

    // Copy the content portion (everything except .claude/) into
    // the content root. The .claude/commands/ portion goes one
    // directory up so Claude Code (which scans cwd ancestors) can
    // find it.
    for entry in fs::read_dir(bundle_starter)? {
        let entry = entry?;
        let name = entry.file_name();
        let path = entry.path();
        if name == ".claude" {
            // Skills go to <content_root>/../.claude/commands/.
            if let Some(parent) = content_root.parent() {
                let dest_root = parent.join(".claude");
                copy_dir_recursive(&path, &dest_root, &CopyMode::SkipExisting)?;
            }
            continue;
        }
        let dest = content_root.join(&name);
        copy_dir_recursive(&path, &dest, &CopyMode::SkipExisting)?;
    }
    Ok(true)
}

#[derive(Debug)]
enum CopyMode {
    /// Don't overwrite files that already exist at the destination.
    /// We use this for the seed path so a partial pre-existing tree
    /// (e.g. user already created an `areas/` folder) doesn't get
    /// clobbered.
    SkipExisting,
}

fn copy_dir_recursive(src: &Path, dest: &Path, mode: &CopyMode) -> AppResult<()> {
    if src.is_file() {
        if dest.exists() {
            match mode {
                CopyMode::SkipExisting => return Ok(()),
            }
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest)?;
        return Ok(());
    }
    if !src.is_dir() {
        // Symlink or other non-file/dir — skip.
        return Ok(());
    }
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let child_src = entry.path();
        let child_dest = dest.join(entry.file_name());
        copy_dir_recursive(&child_src, &child_dest, mode)?;
    }
    Ok(())
}

#[derive(Clone)]
pub struct Content {
    root: PathBuf,
}

#[derive(Serialize)]
pub struct ContentStatus {
    pub root: String,
    pub found: bool,
}

#[derive(Serialize, Clone)]
pub struct SessionRef {
    /// Path relative to the content root, using forward slashes.
    pub rel_path: String,
    pub owner_kind: String,
    pub owner_slug: String,
    pub owner_label: String,
    /// Filename date (YYYY-MM-DD) if the filename parses that way; else the
    /// stem verbatim.
    pub date: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct PersonRef {
    pub slug: String,
    pub label: String,
    pub relationship: String,
    pub rel_path: String,
    pub has_readme: bool,
    pub session_count: usize,
    pub last_session: Option<String>,
    /// Title field from `<person-dir>/person.json` if present. Used by
    /// the Cmd+K palette + People search to render a sublabel that's
    /// more specific than the relationship folder name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Photo URL from `person.json`. The People search row uses this
    /// to render an actual headshot when available; the directory
    /// fallback is initials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo_url: Option<String>,
}

/// Typed result for `restore_from_audit`. The frontend renders one of
/// four messages keyed off the `kind` discriminant — saves us from
/// having to round-trip "did anything happen?" inference through a
/// nullable SaveResult.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RestoreOutcome {
    /// File rewritten with the before-state. New audit row recorded.
    Restored(SaveResult),
    /// save_markdown's content-equal short-circuit fired — the file
    /// was already at the before-state. No new audit row.
    NoOp { rel_path: String },
    /// Audit row's detail_json had no before_hash. The targeted write
    /// was the file's first; there's no earlier state.
    CreateRow,
    /// before_hash exists but the blob isn't in the snapshot store.
    /// Pre-fix audit rows in git-tracked workspaces hit this — new
    /// writes are recoverable; historical rows aren't.
    BlobMissing,
}

/// Status bucket per PRD-v2-115 §6.6 Projects status grid.
/// "soon-done" doubles as "near completion" — short timeline left.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectStatus {
    OnTrack,
    AtRisk,
    Blocked,
    SoonDone,
    /// Archived projects show up in the "Recently Archived" strip,
    /// not the main grid. Kept as a discrete value so the frontend
    /// can route them differently.
    Archived,
}

/// Per-project status with its provenance — "explicit" if the INDEX.md
/// row specifies it, "derived" if we computed it from mtime + tags.
#[derive(Serialize, Clone, Debug)]
pub struct ProjectStatusInfo {
    pub slug: String,
    pub status: ProjectStatus,
    /// "explicit" | "derived"
    pub source: String,
    /// Free-text from the INDEX Notes column when the status is
    /// explicit; useful for rendering the 1-line status hint on the
    /// card.
    pub note: Option<String>,
}

/// One priority item for the Home top-3 hero (PRD-v2-115 §6.1).
/// Source can be a briefing line ("briefing"), an overdue task
/// ("overdue"), or a synthesized fallback ("placeholder"). The
/// frontend renders one card per item; the source field tints the
/// dot.
#[derive(Serialize, Clone, Debug)]
pub struct PriorityItem {
    /// Human text — the entire visible content of the priority card.
    /// Already trimmed; no leading bullet markers.
    pub text: String,
    /// "briefing" | "overdue" | "placeholder"
    pub source: String,
    /// Optional rel_path the card links to. Resolved to a content-root
    /// path: a project README, a 1:1 session file, or — when nothing
    /// more specific is available — the briefing itself.
    pub rel_path: Option<String>,
    /// Optional v1 task id. When set, the card should navigate to the
    /// task surface and select the row instead of opening a doc.
    /// Populated either from the overdue-tasks fallback or from
    /// matching a briefing bullet's title against the task list.
    pub task_id: Option<String>,
    /// Optional substring the editor should locate + scroll to after
    /// opening rel_path. Used when the card falls back to the briefing
    /// — we point the user at the specific bullet, not the top of the
    /// doc. Frontend matches case-insensitively, prefix-then-substring.
    pub scroll_to: Option<String>,
}

/// "Needs your attention" hero row for the People surface (PRD-v2-115
/// §6.3). One entry per direct report or skip-level report whose
/// relationship state suggests User should look at them today.
///
/// `reasons` is a typed list of why this person surfaced — same person
/// can show up for multiple reasons. The UI renders the strongest
/// reason as a colored dot + chip; the rest as a tooltip / aria-label.
///
/// The set of reasons is small + stable on purpose:
///   - `stale` — last 1:1 was > 14 days ago
///   - `no-prep` — next 1:1 has no session file scaffolded yet
///   - `no-readme` — folder exists but README hasn't been written
///   - `no-sessions` — folder exists but never had a session
#[derive(Serialize, Clone, Debug)]
pub struct AttentionPerson {
    pub slug: String,
    pub label: String,
    pub relationship: String,
    pub rel_path: String,
    /// Days since the last session (None when no sessions yet).
    pub days_since_last_session: Option<i64>,
    pub reasons: Vec<String>,
}

/// One row in the Projects surface — projects live at
/// `data/files/projects/<slug>/` per CLAUDE.md. The surface shows the
/// README (if any) and a list of supplementary files inline.
#[derive(Serialize, Clone, Debug)]
pub struct ProjectRef {
    pub slug: String,
    pub label: String,
    pub rel_path: String,
    pub has_readme: bool,
    /// Count of .md files in the folder (excluding README.md). The
    /// project README is implicit; this count is "extra notes".
    pub extra_md_count: usize,
    /// Most-recent file mtime as ISO seconds, used by the UI to sort
    /// by "recently touched" rather than alphabetical when desired.
    pub last_touched: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProjectFile {
    pub name: String,
    pub rel_path: String,
}

/// One row in the Meetings surface — recurring meetings live under
/// `data/files/areas/meetings/<slug>/` (see CLAUDE.md). Same shape as
/// PersonRef minus the relationship grouping; we list them flat in
/// most-recent-session order.
#[derive(Serialize, Clone, Debug)]
pub struct MeetingRef {
    pub slug: String,
    pub label: String,
    pub rel_path: String,
    pub has_readme: bool,
    pub session_count: usize,
    pub last_session: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionMeta {
    pub date: String,
    pub rel_path: String,
}

/// Optional per-person metadata loaded from `<person-dir>/person.json`.
/// None of the fields are required — the file can be partial or absent.
/// Generator skills populate this later via MCP lookups (email from Glean,
/// Slack profile from slack-local); hand-edit works too.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct PersonMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photo_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slack_url: Option<String>,
    /// Slack user id (e.g. "U12345AB"). Kept separate from slack_url since
    /// some use cases (mention a user in a message) need the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slack_id: Option<String>,
}

impl PersonMeta {
    /// Merge `other` on top of `self`, preferring `other` where non-None.
    /// Used when a generator or refresh run fills in gaps without blowing
    /// away hand-edited fields the user may have set.
    ///
    /// Currently unused — the merge logic moved into the
    /// `.claude/commands/person-refresh.md` and `org-generate.md` slash
    /// commands per BUILD-PLAN §3 (skills-as-slash-commands). Kept for
    /// any future Rust-side code path that needs to write meta
    /// without round-tripping through the CLI.
    #[allow(dead_code)]
    pub fn merged_with(mut self, other: PersonMeta) -> Self {
        if other.title.is_some() {
            self.title = other.title;
        }
        if other.email.is_some() {
            self.email = other.email;
        }
        if other.photo_url.is_some() {
            self.photo_url = other.photo_url;
        }
        if other.slack_url.is_some() {
            self.slack_url = other.slack_url;
        }
        if other.slack_id.is_some() {
            self.slack_id = other.slack_id;
        }
        self
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.email.is_none()
            && self.photo_url.is_none()
            && self.slack_url.is_none()
            && self.slack_id.is_none()
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchHit {
    pub rel_path: String,
    /// Filename (no extension) — what the palette renders as the headline.
    pub label: String,
    /// Folder slug above the filename (e.g. `direct-reports/alice`),
    /// so the user can tell two `2026-04-22.md` files apart.
    pub context: String,
    /// ~120-char excerpt around the first query hit, with the matched
    /// span unchanged so the frontend can highlight it client-side.
    pub snippet: String,
    /// Number of times the query appeared in the file. Used as a coarse
    /// score; the frontend can re-rank if needed.
    pub hits: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct PersonProfile {
    pub rel_path: String,
    pub readme: Option<String>,
    pub sessions: Vec<SessionMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<PersonMeta>,
}

#[derive(Serialize, Debug)]
pub struct DocFile {
    pub rel_path: String,
    pub markdown: String,
    pub bytes: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SaveResult {
    pub rel_path: String,
    pub before_hash: Option<String>,
    pub after_hash: String,
    pub bytes: u64,
    pub audit_id: i64,
    pub skipped: bool,
    /// True when the target lives inside a git working tree, so the blob
    /// capture was skipped (git covers rollback). False when the blob store
    /// was populated.
    pub git_tracked: bool,
}

impl Content {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Access the underlying content root path. Exposed for sibling
    /// modules (org.rs) that need to read/write files under the same
    /// root using their own schema.
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn status(&self) -> ContentStatus {
        ContentStatus {
            root: self.root.display().to_string(),
            found: self.root.is_dir(),
        }
    }

    /// Read a person's on-disk meta (person.json). Returns None if the
    /// file is missing or unparseable — treat absence as "no meta set".
    pub fn read_person_meta(&self, rel_path: &str) -> AppResult<Option<PersonMeta>> {
        let abs = self.resolve(rel_path)?;
        let meta_path = abs.join("person.json");
        if !meta_path.is_file() {
            return Ok(None);
        }
        match fs::read_to_string(&meta_path) {
            Ok(text) => Ok(serde_json::from_str::<PersonMeta>(&text).ok()),
            Err(_) => Ok(None),
        }
    }

    /// Merge new meta fields into the person's on-disk person.json. Fields
    /// not set on `incoming` are preserved from whatever's already there,
    /// so a hand-edited field survives a generator/refresh run unless the
    /// automation specifically overwrote it.
    #[allow(dead_code)]
    pub fn write_person_meta(
        &self,
        rel_path: &str,
        incoming: PersonMeta,
    ) -> AppResult<PersonMeta> {
        let abs = self.resolve(rel_path)?;
        if !abs.is_dir() {
            return Err(AppError::NotFound(format!(
                "person folder not found: {rel_path}"
            )));
        }
        let meta_path = abs.join("person.json");
        let existing = if meta_path.is_file() {
            fs::read_to_string(&meta_path)
                .ok()
                .and_then(|t| serde_json::from_str::<PersonMeta>(&t).ok())
                .unwrap_or_default()
        } else {
            PersonMeta::default()
        };
        let merged = existing.merged_with(incoming);
        if merged.is_empty() {
            // Nothing worth persisting — if the file existed, leave it alone
            // rather than writing an empty stub.
            return Ok(merged);
        }
        fs::write(&meta_path, serde_json::to_string_pretty(&merged)?)?;
        Ok(merged)
    }

    /// Load a person's profile: README text + the N most-recent session
    /// refs. Used by the People surface's profile pane. Sessions are
    /// returned newest-first and skip `archive/` and `compacted_*.md`
    /// just like `recent_sessions`. `limit=0` returns all sessions.
    pub fn read_person_profile(
        &self,
        rel_path: &str,
        limit: usize,
    ) -> AppResult<PersonProfile> {
        // Resolve + guard against path escape using the same rules as read_markdown.
        let abs = self.resolve(rel_path)?;
        if !abs.is_dir() {
            return Err(AppError::NotFound(format!(
                "person folder not found: {rel_path}"
            )));
        }

        let readme_path = abs.join("README.md");
        let readme = if readme_path.is_file() {
            Some(fs::read_to_string(&readme_path)?)
        } else {
            None
        };

        let meta = self.read_person_meta(rel_path)?;

        let mut sessions: Vec<SessionMeta> = Vec::new();
        let sessions_dir = abs.join("sessions");
        if sessions_dir.is_dir() {
            for entry in fs::read_dir(&sessions_dir)? {
                let entry = entry?;
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let name = match path.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n,
                    None => continue,
                };
                if !name.ends_with(".md") {
                    continue;
                }
                if name.starts_with("compacted_") || name.starts_with("README") {
                    continue;
                }
                let stem = name.trim_end_matches(".md").to_string();
                let rel = format!("{rel_path}/sessions/{name}");
                sessions.push(SessionMeta { date: stem, rel_path: rel });
            }
        }
        // Newest-first by date stem (stems that aren't ISO still sort
        // lexicographically — good enough for odd filenames).
        sessions.sort_by(|a, b| b.date.cmp(&a.date));
        if limit > 0 && sessions.len() > limit {
            sessions.truncate(limit);
        }

        Ok(PersonProfile {
            rel_path: rel_path.to_string(),
            readme,
            sessions,
            meta,
        })
    }

    /// Recent morning-briefing files under `areas/daily-briefings/sessions/`.
    /// Newest-first by filename date stem, skipping archive/ and compacted_*.
    /// `limit=0` returns all.
    pub fn recent_briefings(&self, limit: usize) -> AppResult<Vec<SessionMeta>> {
        let dir = self
            .root
            .join("areas")
            .join("daily-briefings")
            .join("sessions");
        if !dir.is_dir() {
            return Ok(vec![]);
        }
        let mut out: Vec<SessionMeta> = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if !name.ends_with(".md") {
                continue;
            }
            if name.starts_with("compacted_") || name.starts_with("README") {
                continue;
            }
            let stem = name.trim_end_matches(".md").to_string();
            out.push(SessionMeta {
                date: stem,
                rel_path: format!("areas/daily-briefings/sessions/{name}"),
            });
        }
        out.sort_by(|a, b| b.date.cmp(&a.date));
        if limit > 0 && out.len() > limit {
            out.truncate(limit);
        }
        Ok(out)
    }

    /// List people folders under `areas/one-on-ones/` grouped by
    /// relationship type. Each entry includes session count + most-recent
    /// session date so the UI can show the list pre-sorted by staleness
    /// without a second round-trip.
    pub fn list_people(&self) -> AppResult<Vec<PersonRef>> {
        let root = self.root.join("areas").join("one-on-ones");
        if !root.is_dir() {
            return Ok(vec![]);
        }

        let mut out: Vec<PersonRef> = Vec::new();
        for rel_entry in fs::read_dir(&root)? {
            let rel_entry = rel_entry?;
            let rel_path = rel_entry.path();
            if !rel_path.is_dir() {
                continue;
            }
            let relationship = match rel_path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if relationship.starts_with('.') {
                continue;
            }
            for person_entry in fs::read_dir(&rel_path)? {
                let person_entry = person_entry?;
                let p_path = person_entry.path();
                if !p_path.is_dir() {
                    continue;
                }
                let slug = match p_path.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if slug.starts_with('.') {
                    continue;
                }

                let readme = p_path.join("README.md").is_file();
                let (count, last) = session_stats(&p_path.join("sessions"));

                let rel = match p_path.strip_prefix(&self.root) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };

                // Cheap pull from person.json if present — title +
                // photo_url for the search/profile render path. Read
                // failures fall through silently (most folders won't
                // have person.json yet).
                let (title, photo_url) =
                    match fs::read_to_string(p_path.join("person.json")) {
                        Ok(text) => match serde_json::from_str::<PersonMeta>(&text) {
                            Ok(m) => (m.title, m.photo_url),
                            Err(_) => (None, None),
                        },
                        Err(_) => (None, None),
                    };

                out.push(PersonRef {
                    slug: slug.clone(),
                    label: humanize(&slug),
                    relationship: relationship.clone(),
                    rel_path: rel,
                    has_readme: readme,
                    session_count: count,
                    last_session: last,
                    title,
                    photo_url,
                });
            }
        }

        // Sort deterministically: relationship (per ORDER), then most-recent
        // session desc, then label. The UI groups on the way down so the
        // relationship ordering here drives the pane's top-to-bottom layout.
        out.sort_by(|a, b| {
            let ra = relationship_rank(&a.relationship);
            let rb = relationship_rank(&b.relationship);
            ra.cmp(&rb)
                .then_with(|| b.last_session.cmp(&a.last_session))
                .then_with(|| a.label.cmp(&b.label))
        });
        Ok(out)
    }

    /// Restore a doc to the BEFORE-state of the audit row identified
    /// by `audit_id`. Use case: the user mis-edited a session file
    /// and wants to roll back to whatever the file looked like just
    /// before that save.
    ///
    /// Returns a typed outcome so the frontend can distinguish:
    ///   - `Restored`: file replaced with the before-state, new
    ///     doc.write audit row created, here's the SaveResult.
    ///   - `NoOp`: file is already at the before-state. (Hits the
    ///     content-equal short-circuit in save_markdown — happens
    ///     when the user clicks restore twice.)
    ///   - `CreateRow`: this audit row was the file's first write;
    ///     there's no before-state to restore to. Delete the file
    ///     manually if you want it gone.
    ///   - `BlobMissing`: the audit row predates the snapshot-store
    ///     coverage (early v2 builds skipped blob capture for
    ///     git-tracked workspaces). New writes are recoverable; this
    ///     historical row isn't.
    pub fn restore_from_audit(
        &self,
        audit_id: i64,
        db: &mut Connection,
        blobs: &BlobStore,
        actor: &str,
    ) -> AppResult<RestoreOutcome> {
        let row = crate::audit::get(db, audit_id)?
            .ok_or_else(|| AppError::NotFound(format!("audit row {}", audit_id)))?;
        if row.action != "doc.write" {
            return Err(AppError::InvalidState(format!(
                "audit row {} is action {:?}; only doc.write rows can be restored",
                audit_id, row.action,
            )));
        }
        let detail: serde_json::Value = serde_json::from_str(&row.detail_json)
            .map_err(|e| {
                AppError::InvalidState(format!("audit detail_json: {e}"))
            })?;
        let before_hash = match detail.get("before_hash").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => return Ok(RestoreOutcome::CreateRow),
        };
        let bytes = match blobs.get(&before_hash)? {
            Some(b) => b,
            None => return Ok(RestoreOutcome::BlobMissing),
        };
        let content = String::from_utf8(bytes).map_err(|e| {
            AppError::InvalidState(format!("blob is not valid UTF-8: {e}"))
        })?;
        let result = self.save_markdown(&row.target_id, &content, db, blobs, actor)?;
        if result.skipped {
            Ok(RestoreOutcome::NoOp {
                rel_path: row.target_id.clone(),
            })
        } else {
            Ok(RestoreOutcome::Restored(result))
        }
    }

    /// Derive a status bucket per project for the PRD-v2-115 §6.6
    /// status grid. Two-tier source:
    ///   - **Explicit** — `data/files/projects/INDEX.md` has rows
    ///     with a Status field. If the value is one of the recognized
    ///     buckets ("active"/"on-track", "at-risk", "blocked",
    ///     "soon-done"/"near-done"/"shipping"), we use it verbatim
    ///     (mapping `active` → on-track since the INDEX format
    ///     predates 115's bucket vocabulary).
    ///   - **Derived** — for projects without an INDEX row OR with an
    ///     unrecognized status, we compute: last-touched > 21 days =
    ///     at-risk; otherwise on-track. The "blocked" derivation
    ///     (notes containing `blocked:`) and "soon-done" derivation
    ///     (target date within 7 days) ride on top.
    ///
    /// Returns one row per project found via `list_project_refs`.
    /// Archived projects are returned with status=Archived; the
    /// frontend separates them into the "Recently Archived" strip.
    pub fn compute_project_statuses(
        &self,
        today_iso: &str,
    ) -> AppResult<Vec<ProjectStatusInfo>> {
        let projects = self.list_project_refs()?;
        let index_rows = self.parse_project_index().unwrap_or_default();

        let mut out: Vec<ProjectStatusInfo> = Vec::new();
        for p in projects {
            let row = index_rows.iter().find(|r| r.slug == p.slug);
            let (status, source, note) = match row {
                Some(r) => {
                    let blocked_in_notes = r
                        .notes
                        .as_deref()
                        .map(|n| n.to_lowercase().contains("blocked:"))
                        .unwrap_or(false);
                    let soon_target = r
                        .target
                        .as_deref()
                        .and_then(|d| days_between(d, today_iso))
                        .map(|d| (0..=7).contains(&d))
                        .unwrap_or(false);
                    // Order: a "blocked:" tag in notes ALWAYS wins,
                    // even when the row's Status column says "active"
                    // (the maintainer's pattern is to keep Status as
                    // the lifecycle state and use Notes for the
                    // immediate signal). Then explicit Status, then
                    // soon-target derivation, then mtime fallback.
                    if blocked_in_notes {
                        (ProjectStatus::Blocked, "derived", r.notes.clone())
                    } else if let Some(s) = parse_index_status(&r.status_text) {
                        (s, "explicit", r.notes.clone())
                    } else if soon_target {
                        (ProjectStatus::SoonDone, "derived", r.notes.clone())
                    } else {
                        (
                            mtime_derived_status(p.last_touched.as_deref(), today_iso),
                            "derived",
                            r.notes.clone(),
                        )
                    }
                }
                None => (
                    mtime_derived_status(p.last_touched.as_deref(), today_iso),
                    "derived",
                    None,
                ),
            };
            out.push(ProjectStatusInfo {
                slug: p.slug,
                status,
                source: source.into(),
                note,
            });
        }
        Ok(out)
    }

    /// Parse the table rows under `## Active` (and `## On Hold`,
    /// `## Archived`) of `projects/INDEX.md`. Tolerant — bad rows
    /// silently skip.
    fn parse_project_index(&self) -> AppResult<Vec<IndexRow>> {
        let path = self.root.join("projects").join("INDEX.md");
        let body = match fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => return Ok(vec![]),
        };
        Ok(parse_project_index_body(&body))
    }

    /// Extract today's top priorities (PRD-v2-115 §6.1, §3.1). Logic:
    ///   1. Look for `data/files/areas/daily-briefings/sessions/<today>.md`.
    ///   2. If present, find a "## Top Priorities" (or "## Priorities",
    ///      or "## Top 3") H2 section and pull the first N bullet
    ///      items.
    ///   3. If no section / no briefing, return an empty list (caller
    ///      decides whether to fall back to overdue HIGH tasks; we
    ///      don't read the v1 SQLite task DB here because that's a
    ///      different module's responsibility).
    ///
    /// `limit` caps the returned items (the design hero shows 3).
    /// Bullets stripped of leading `- `, `* `, or numbered `1. ` markers
    /// so the frontend can render them as a consistent list.
    pub fn top_priorities_from_briefing(
        &self,
        today_iso: &str,
        limit: usize,
    ) -> AppResult<Vec<PriorityItem>> {
        let rel = format!("areas/daily-briefings/sessions/{today_iso}.md");
        let abs = self.root.join(&rel);
        if !abs.is_file() {
            return Ok(vec![]);
        }
        let body = match fs::read_to_string(&abs) {
            Ok(s) => s,
            Err(_) => return Ok(vec![]),
        };

        let bullets = extract_priority_bullets(&body, limit);
        let briefing_dir = abs.parent().map(|p| p.to_path_buf());
        Ok(bullets
            .into_iter()
            .map(|text| {
                // Try to resolve the bullet to something specific the user
                // probably meant: a project README, a session file, etc.
                // Fall back to the briefing itself with a scroll hint so
                // the user lands at the right paragraph, not the top.
                let resolved = first_relative_link(&text)
                    .and_then(|raw| {
                        resolve_to_content_path(raw, briefing_dir.as_deref(), &self.root)
                    });
                let (rel_path, scroll_to) = match resolved {
                    Some(p) => (Some(p), None),
                    None => (
                        Some(rel.clone()),
                        Some(scroll_anchor_from_bullet(&text)),
                    ),
                };
                PriorityItem {
                    text,
                    source: "briefing".into(),
                    rel_path,
                    task_id: None,
                    scroll_to,
                }
            })
            .collect())
    }

    /// Compute the "Needs your attention" set for the People hero
    /// (PRD-v2-115 §6.3). Returns one row per direct report or
    /// skip-level report with at least one reason flagging them, sorted
    /// by the strongest signal: people with no sessions or no README
    /// first, then by staleness desc.
    ///
    /// `today_iso` is `YYYY-MM-DD` in the user's local timezone — the
    /// caller computes it (Rust has no built-in TZ-aware date math
    /// without chrono, and we don't pull chrono just for this).
    /// `stale_days` is the threshold beyond which we consider a 1:1
    /// stale; defaults are passed by the IPC layer at 14.
    pub fn list_attention_people(
        &self,
        today_iso: &str,
        stale_days: i64,
    ) -> AppResult<Vec<AttentionPerson>> {
        // We only flag direct reports + skip-level reports for now.
        // Manager / peers / XFN have less rigid 1:1 cadences and
        // surfacing them as "needs attention" creates noise.
        let kinds: &[&str] = &["direct-reports", "skip-level-reports"];
        let mut out: Vec<AttentionPerson> = Vec::new();

        let people = self.list_people()?;
        for p in people.iter().filter(|p| kinds.contains(&p.relationship.as_str())) {
            let mut reasons: Vec<String> = Vec::new();
            let days = p.last_session.as_deref().and_then(|d| days_between(today_iso, d));

            if !p.has_readme {
                reasons.push("no-readme".to_string());
            }
            match (p.session_count, days) {
                (0, _) => reasons.push("no-sessions".to_string()),
                (_, Some(d)) if d > stale_days => reasons.push("stale".to_string()),
                _ => {}
            }
            // "no-prep" check: a session file exists for *today*?
            // Absence of one for an upcoming 1:1 is a useful signal,
            // but we can't see calendar invites from here. The
            // frontend can join with calendar_events and add this
            // reason on its side when it has the day's invites.

            if reasons.is_empty() {
                continue;
            }
            out.push(AttentionPerson {
                slug: p.slug.clone(),
                label: p.label.clone(),
                relationship: p.relationship.clone(),
                rel_path: p.rel_path.clone(),
                days_since_last_session: days,
                reasons,
            });
        }

        out.sort_by(|a, b| {
            // Strongest signal first: no-sessions / no-readme float to
            // top, then most-stale, then alphabetical.
            let strength = |r: &AttentionPerson| -> i64 {
                if r.reasons.iter().any(|x| x == "no-sessions") {
                    return 1_000_000;
                }
                if r.reasons.iter().any(|x| x == "no-readme") {
                    return 900_000;
                }
                r.days_since_last_session.unwrap_or(0)
            };
            strength(b)
                .cmp(&strength(a))
                .then_with(|| a.label.cmp(&b.label))
        });

        Ok(out)
    }

    /// List recurring-meeting folders under `areas/meetings/`. Same
    /// session_stats handling as people so the UI can sort by staleness.
    /// Returns sorted by most-recent session (desc), then label.
    pub fn list_meetings(&self) -> AppResult<Vec<MeetingRef>> {
        let root = self.root.join("areas").join("meetings");
        if !root.is_dir() {
            return Ok(vec![]);
        }
        let mut out: Vec<MeetingRef> = Vec::new();
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let slug = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if slug.starts_with('.') {
                continue;
            }
            let readme = path.join("README.md").is_file();
            let (count, last) = session_stats(&path.join("sessions"));
            let rel = match path.strip_prefix(&self.root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            out.push(MeetingRef {
                slug: slug.clone(),
                label: humanize(&slug),
                rel_path: rel,
                has_readme: readme,
                session_count: count,
                last_session: last,
            });
        }
        out.sort_by(|a, b| {
            b.last_session
                .cmp(&a.last_session)
                .then_with(|| a.label.cmp(&b.label))
        });
        Ok(out)
    }

    /// List session files for a single meeting (or person) folder. Same
    /// shape as `recent_sessions_for_person` but bound to any rel_path that
    /// has a `sessions/` subdir. Caller passes the folder rel_path
    /// (e.g. `areas/meetings/team-eng-leads`).
    pub fn list_sessions_in(&self, owner_rel_path: &str, limit: usize) -> AppResult<Vec<SessionMeta>> {
        let owner_abs = self.resolve(owner_rel_path)?;
        let dir = owner_abs.join("sessions");
        if !dir.is_dir() {
            return Ok(vec![]);
        }
        let mut out: Vec<SessionMeta> = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.ends_with(".md") {
                continue;
            }
            if name.starts_with("compacted_") || name.starts_with("README") {
                continue;
            }
            let date = name.trim_end_matches(".md").to_string();
            let rel = format!("{}/sessions/{}", owner_rel_path.trim_end_matches('/'), name);
            out.push(SessionMeta { date, rel_path: rel });
        }
        out.sort_by(|a, b| b.date.cmp(&a.date));
        if limit > 0 && out.len() > limit {
            out.truncate(limit);
        }
        Ok(out)
    }

    /// List active project slugs from `data/files/projects/`. Directory
    /// names only — the INDEX.md / README.md files are skipped. Sorted
    /// alphabetically. If the projects dir doesn't exist yet, returns
    /// an empty list rather than an error (fresh installs won't have it).
    pub fn list_projects(&self) -> AppResult<Vec<String>> {
        let dir = self.root.join("projects");
        if !dir.is_dir() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name.starts_with('.') {
                continue;
            }
            out.push(name.to_string());
        }
        out.sort();
        Ok(out)
    }

    /// Richer project list for the Projects surface — each entry has
    /// label, README state, count of extra notes, and last-touched
    /// timestamp so the surface can sort by recency. Returns sorted by
    /// last_touched desc (so the project the user just edited floats).
    pub fn list_project_refs(&self) -> AppResult<Vec<ProjectRef>> {
        let dir = self.root.join("projects");
        if !dir.is_dir() {
            return Ok(vec![]);
        }
        let mut out: Vec<ProjectRef> = Vec::new();
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let slug = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if slug.starts_with('.') {
                continue;
            }
            let mut extra = 0usize;
            let mut latest: Option<std::time::SystemTime> = None;
            let entries = match fs::read_dir(&path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for inner in entries.flatten() {
                let p = inner.path();
                if !p.is_file() {
                    continue;
                }
                let name = match p.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n,
                    None => continue,
                };
                if !is_user_doc(name) {
                    continue;
                }
                if let Ok(meta) = fs::metadata(&p) {
                    if let Ok(t) = meta.modified() {
                        latest = Some(latest.map_or(t, |c| c.max(t)));
                    }
                }
                if name != "README.md" {
                    extra += 1;
                }
            }
            let rel = match path.strip_prefix(&self.root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            out.push(ProjectRef {
                slug: slug.clone(),
                label: humanize(&slug),
                rel_path: rel,
                has_readme: path.join("README.md").is_file(),
                extra_md_count: extra,
                last_touched: latest.and_then(format_systemtime),
            });
        }
        out.sort_by(|a, b| {
            b.last_touched
                .cmp(&a.last_touched)
                .then_with(|| a.label.cmp(&b.label))
        });
        Ok(out)
    }

    /// List the .md files inside a single project folder. Returns
    /// README first if present, then alphabetical.
    pub fn list_project_files(&self, project_rel: &str) -> AppResult<Vec<ProjectFile>> {
        let abs = self.resolve(project_rel)?;
        if !abs.is_dir() {
            return Ok(vec![]);
        }
        let mut out: Vec<ProjectFile> = Vec::new();
        for entry in fs::read_dir(&abs)? {
            let entry = entry?;
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !is_user_doc(&name) {
                continue;
            }
            let rel = format!(
                "{}/{}",
                project_rel.trim_end_matches('/'),
                name,
            );
            out.push(ProjectFile { name, rel_path: rel });
        }
        // README first, then alpha.
        out.sort_by(|a, b| {
            let ar = a.name == "README.md";
            let br = b.name == "README.md";
            br.cmp(&ar).then_with(|| a.name.cmp(&b.name))
        });
        Ok(out)
    }

    pub fn recent_sessions(&self, limit: usize) -> AppResult<Vec<SessionRef>> {
        if !self.root.is_dir() {
            return Ok(vec![]);
        }

        let mut refs = Vec::new();
        for kind in ["one-on-ones", "meetings"] {
            let base = self.root.join("areas").join(kind);
            if !base.is_dir() {
                continue;
            }
            collect_sessions(&self.root, &base, kind, &mut refs)?;
        }

        // Sort by date desc, then owner label asc for determinism.
        refs.sort_by(|a, b| {
            b.date
                .cmp(&a.date)
                .then_with(|| a.owner_label.cmp(&b.owner_label))
        });
        refs.truncate(limit);
        Ok(refs)
    }

    /// Create a new session file at `<owner_rel>/sessions/<date>.md`
    /// using a minimal scaffolded template. Owner is a Person or
    /// Meeting folder relative path under the content root. Date is a
    /// `YYYY-MM-DD` string the caller picks (today, next Monday, etc.).
    ///
    /// Returns the rel-path of the created file. Errors if the file
    /// already exists — the caller is responsible for confirming an
    /// overwrite, since destroying notes is the worst case here.
    ///
    /// `actor` is the audit-log identity. Uses the same atomic-write +
    /// audit pipeline as save_markdown so the new file is recoverable
    /// like any other doc-write.
    pub fn create_session(
        &self,
        owner_rel: &str,
        date: &str,
        owner_label: &str,
        db: &mut Connection,
        blobs: &BlobStore,
        actor: &str,
    ) -> AppResult<String> {
        // Date format check — `save_markdown` doesn't care about the
        // filename, but every other surface does. Catching the bad
        // input here prevents writing a `2026-04-2A.md` file that the
        // session lister silently ignores forever after.
        if date.len() != 10 || !date.chars().all(|c| c.is_ascii_digit() || c == '-') {
            return Err(AppError::InvalidState(format!(
                "session date must be YYYY-MM-DD, got {date:?}"
            )));
        }
        let rel = format!(
            "{}/sessions/{}.md",
            owner_rel.trim_end_matches('/'),
            date
        );
        // Path-safety check — resolve_for_write rejects traversal.
        let abs = self.resolve_for_write(&rel)?;
        if abs.exists() {
            return Err(AppError::InvalidState(format!(
                "session already exists at {rel}"
            )));
        }
        let template = format!(
            "# {label} — {date}\n\n## Shared Agenda\n- \n\n## Notes\n\n## Action Items\n",
            label = owner_label,
            date = date,
        );
        self.save_markdown(&rel, &template, db, blobs, actor)?;
        Ok(rel)
    }

    /// Naive cross-content search. Scans every `.md` file under the
    /// content root, counts case-insensitive substring hits of `query`,
    /// and returns up to `limit` files sorted by hit-count desc.
    /// Archive folders and `compacted_*.md` are skipped because they're
    /// noise — anything that's still relevant lives in active sessions.
    /// Files larger than 256 KiB are skipped (briefings or generated
    /// docs that match everything).
    ///
    /// This is a Phase-0 implementation. The PRD-100 §4.3 spec leaves
    /// room for an FTS index later; nothing in this signature blocks
    /// swapping the backing implementation.
    pub fn search(&self, query: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let q_lower = q.to_lowercase();
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut stack: Vec<std::path::PathBuf> = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = match path.file_name().and_then(|s| s.to_str()) {
                    Some(n) => n,
                    None => continue,
                };
                if name.starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    if name == "archive" || name == "node_modules" {
                        continue;
                    }
                    stack.push(path);
                    continue;
                }
                if !is_user_doc(name) {
                    continue;
                }
                if name.starts_with("compacted_") {
                    continue;
                }
                let meta = match fs::metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.len() > 256 * 1024 {
                    continue;
                }
                let body = match fs::read_to_string(&path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let body_lower = body.to_lowercase();
                let count = body_lower.matches(&q_lower).count();
                if count == 0 {
                    continue;
                }
                let rel = match path.strip_prefix(&self.root) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                hits.push(SearchHit {
                    label: strip_doc_ext(name).to_string(),
                    context: derive_context(&rel),
                    snippet: snippet_around(&body, &body_lower, &q_lower),
                    hits: count,
                    rel_path: rel,
                });
            }
        }
        hits.sort_by(|a, b| {
            b.hits
                .cmp(&a.hits)
                .then_with(|| a.rel_path.cmp(&b.rel_path))
        });
        if limit > 0 && hits.len() > limit {
            hits.truncate(limit);
        }
        Ok(hits)
    }

    pub fn read_markdown(&self, rel_path: &str) -> AppResult<DocFile> {
        let abs = self.resolve(rel_path)?;
        let markdown = fs::read_to_string(&abs)?;
        let bytes = fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
        Ok(DocFile {
            rel_path: rel_path.to_string(),
            markdown,
            bytes,
        })
    }

    /// Write markdown to disk, protected by the per-change snapshot store +
    /// hash-chained audit log (PRD-102 §13a + §12). Sequence:
    ///   1. Read current file (if any) → `before` blob
    ///   2. Store `after` blob (content-addressed, deduped)
    ///   3. Atomic file replace (write temp + rename)
    ///   4. Commit snapshot_ref + audit row in one txn
    /// If the final content matches the existing file byte-for-byte, nothing
    /// is written and `skipped = true` is returned (no audit churn).
    pub fn save_markdown(
        &self,
        rel_path: &str,
        content: &str,
        db: &mut Connection,
        blobs: &BlobStore,
        actor: &str,
    ) -> AppResult<SaveResult> {
        let abs = self.resolve_for_write(rel_path)?;

        let (before_bytes, before_hash) = match fs::read(&abs) {
            Ok(bytes) => {
                let h = BlobStore::hash(&bytes);
                (Some(bytes.len() as i64), Some(h))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, None),
            Err(e) => return Err(e.into()),
        };

        let after_bytes = content.as_bytes();
        let after_hash = BlobStore::hash(after_bytes);

        let git_tracked = inside_git_tree(&abs);

        if before_hash.as_deref() == Some(after_hash.as_str()) {
            return Ok(SaveResult {
                rel_path: rel_path.to_string(),
                before_hash,
                after_hash,
                bytes: after_bytes.len() as u64,
                audit_id: 0,
                skipped: true,
                git_tracked,
            });
        }

        // Always capture before + after blobs. The original v2 design
        // skipped this branch when git_tracked was true on the theory
        // that `git checkout` was the recovery path. In practice the
        // user's whole workspace is one big git repo, so EVERY doc.write
        // landed in the git_tracked branch — and `audit_restore` had
        // nothing to read because no blob was ever stored. Result: the
        // restore button in Settings → Activity was a permanent no-op
        // in dev mode. Capture is content-addressed and dedupes
        // (BlobStore::put no-ops on hash collision), so the disk cost
        // is small and bounded; the recovery-from-app value is large.
        if let Some(ref _h) = before_hash {
            blobs.put(&fs::read(&abs)?)?;
        }
        blobs.put(after_bytes)?;

        // Atomic file replace.
        atomic_write(&abs, after_bytes)?;

        // Commit snapshot ref + audit in one txn.
        let tx = db.transaction()?;
        let detail = serde_json::json!({
            "before_bytes": before_bytes,
            "after_bytes": after_bytes.len(),
            "before_hash": before_hash,
            "after_hash": after_hash,
            "git_tracked": git_tracked,
        })
        .to_string();
        let audit_id = audit::append(
            &tx,
            actor,
            "doc.write",
            "file",
            rel_path,
            &detail,
        )?;
        tx.execute(
            r#"
            INSERT INTO snapshot_refs
              (at, target_kind, target_id, before_hash, after_hash,
               before_bytes, after_bytes, actor)
            VALUES
              (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'file', ?1, ?2, ?3,
               ?4, ?5, ?6)
            "#,
            rusqlite::params![
                rel_path,
                before_hash,
                after_hash,
                before_bytes,
                after_bytes.len() as i64,
                actor
            ],
        )?;
        tx.commit()?;

        Ok(SaveResult {
            rel_path: rel_path.to_string(),
            before_hash,
            after_hash,
            bytes: after_bytes.len() as u64,
            audit_id,
            skipped: false,
            git_tracked,
        })
    }

    /// Like `resolve`, but doesn't require the file to already exist —
    /// Write a binary attachment under `attachments/<slug>/<safe>` rooted
    /// at the content tree (B7-CP28). The slug derives from the doc's
    /// rel-path so attachments cluster with the doc that produced them.
    /// Returns the rel-path of the written file so the frontend can
    /// insert a markdown image link.
    ///
    /// Filename is sanitized to safe ASCII; if the sanitized name
    /// collides with an existing attachment, a `-N` disambiguator is
    /// appended.
    pub fn write_attachment(
        &self,
        doc_rel_path: &str,
        filename: &str,
        bytes: &[u8],
    ) -> AppResult<String> {
        let slug = attachment_slug_for(doc_rel_path);
        let safe = sanitize_attachment_filename(filename);
        if safe.is_empty() {
            return Err(AppError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "attachment filename empty after sanitization",
            )));
        }
        let dir_rel = format!("attachments/{slug}");
        let mut attempt = 0usize;
        loop {
            let candidate_name = if attempt == 0 {
                safe.clone()
            } else {
                let dot = safe.rfind('.');
                match dot {
                    Some(i) => format!(
                        "{}-{attempt}{}",
                        &safe[..i],
                        &safe[i..],
                    ),
                    None => format!("{}-{attempt}", safe),
                }
            };
            let rel = format!("{dir_rel}/{candidate_name}");
            let abs = self.resolve_for_write(&rel)?;
            if !abs.exists() {
                fs::write(&abs, bytes)?;
                return Ok(rel);
            }
            attempt += 1;
            if attempt > 999 {
                return Err(AppError::Io(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "too many attachment-name collisions",
                )));
            }
        }
    }

    /// walks + canonicalizes the parent dir instead so you can write new
    /// files while still guaranteeing the target is inside `self.root`.
    fn resolve_for_write(&self, rel_path: &str) -> AppResult<PathBuf> {
        let rel = Path::new(rel_path);
        for c in rel.components() {
            match c {
                Component::Normal(_) => {}
                _ => {
                    return Err(AppError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "rel_path must contain only plain components",
                    )));
                }
            }
        }
        let joined = self.root.join(rel);
        let parent = joined.parent().ok_or_else(|| {
            AppError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "rel_path has no parent directory",
            ))
        })?;
        fs::create_dir_all(parent)?;
        let canon_root = fs::canonicalize(&self.root)?;
        let canon_parent = fs::canonicalize(parent)?;
        if !canon_parent.starts_with(&canon_root) {
            return Err(AppError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "rel_path escapes content root",
            )));
        }
        let leaf = joined
            .file_name()
            .ok_or_else(|| {
                AppError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "rel_path has no filename",
                ))
            })?
            .to_owned();
        Ok(canon_parent.join(leaf))
    }

    fn resolve(&self, rel_path: &str) -> AppResult<PathBuf> {
        let rel = Path::new(rel_path);
        for c in rel.components() {
            match c {
                Component::Normal(_) => {}
                _ => {
                    return Err(AppError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "rel_path must contain only plain components",
                    )));
                }
            }
        }
        let joined = self.root.join(rel);
        let canon_root = fs::canonicalize(&self.root)?;
        let canon = fs::canonicalize(&joined)?;
        if !canon.starts_with(&canon_root) {
            return Err(AppError::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "rel_path escapes content root",
            )));
        }
        Ok(canon)
    }
}

fn collect_sessions(
    root: &Path,
    base: &Path,
    kind: &str,
    out: &mut Vec<SessionRef>,
) -> AppResult<()> {
    // Walk: base/[subgroup/]*/sessions/*.md
    // For one-on-ones: base/<subgroup>/<slug>/sessions/*.md (direct-reports, etc.)
    // For meetings:    base/<slug>/sessions/*.md
    for entry in fs::read_dir(base)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        // Case 1: this is a <slug> dir that contains sessions/ directly.
        let direct_sessions = path.join("sessions");
        if direct_sessions.is_dir() {
            let slug = file_name(&path);
            read_session_dir(root, &direct_sessions, kind, &slug, out)?;
            continue;
        }

        // Case 2: this is a subgroup (e.g. direct-reports); recurse one level.
        for inner in fs::read_dir(&path)? {
            let inner = inner?;
            let inner_path = inner.path();
            if !inner_path.is_dir() {
                continue;
            }
            let session_dir = inner_path.join("sessions");
            if session_dir.is_dir() {
                let slug = file_name(&inner_path);
                read_session_dir(root, &session_dir, kind, &slug, out)?;
            }
        }
    }
    Ok(())
}

fn read_session_dir(
    root: &Path,
    dir: &Path,
    kind: &str,
    slug: &str,
    out: &mut Vec<SessionRef>,
) -> AppResult<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".md") {
            continue;
        }
        if name.starts_with("compacted_") || name.starts_with("README") {
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let stem = name.trim_end_matches(".md").to_string();
        out.push(SessionRef {
            rel_path: rel,
            owner_kind: kind.to_string(),
            owner_slug: slug.to_string(),
            owner_label: humanize(slug),
            date: stem,
        });
    }
    Ok(())
}

/// Walks up from `path`'s parent looking for a `.git/` entry. Returns true
/// at the first hit. Path doesn't need to exist; we only read ancestors.
fn inside_git_tree(path: &Path) -> bool {
    let start = path.parent().unwrap_or(path);
    let mut dir: Option<&Path> = Some(start);
    while let Some(d) = dir {
        if d.join(".git").exists() {
            return true;
        }
        dir = d.parent();
    }
    false
}

fn atomic_write(target: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = target.parent().ok_or_else(|| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "target has no parent",
        ))
    })?;
    let tmp = parent.join(format!(
        ".{}.cos-tmp",
        target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("write")
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, target)?;
    Ok(())
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

/// Scan a `sessions/` directory and return (count, most-recent-date) where
/// date is the filename stem if it parses as `YYYY-MM-DD`. Skips archive/
/// and compacted_*.md so counts reflect active history only.
fn session_stats(dir: &Path) -> (usize, Option<String>) {
    if !dir.is_dir() {
        return (0, None);
    }
    let mut count = 0;
    let mut latest: Option<String> = None;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return (0, None),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !name.ends_with(".md") {
            continue;
        }
        if name.starts_with("compacted_") || name.starts_with("README") {
            continue;
        }
        count += 1;
        let stem = name.trim_end_matches(".md");
        if is_iso_date(stem) {
            match &latest {
                None => latest = Some(stem.to_string()),
                Some(prev) if stem > prev.as_str() => {
                    latest = Some(stem.to_string());
                }
                _ => {}
            }
        }
    }
    (count, latest)
}

fn is_iso_date(s: &str) -> bool {
    if s.len() != 10 {
        return false;
    }
    let b = s.as_bytes();
    b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|&i| b[i].is_ascii_digit())
}

/// Display order for one-on-one relationship groups. Direct reports sit at
/// the top because managers prep those most often; manager + peers next,
/// then skip-levels (up and down), then xfn, then alumni sink to the
/// bottom (they're kept for context but rarely consulted).
fn relationship_rank(kind: &str) -> u8 {
    match kind {
        "direct-reports" => 0,
        "manager" => 1,
        "peers" => 2,
        "skip-level" => 3,
        "skip-level-reports" => 4,
        "xfn" => 5,
        "alumni" => 9,
        _ => 6,
    }
}

#[derive(Debug, Clone)]
struct IndexRow {
    slug: String,
    status_text: String,
    target: Option<String>,
    notes: Option<String>,
    // Read by parser tests (alpha.section == "Active" etc.) but not by
    // non-test callers — `compute_project_statuses` derives the active/
    // archived split from filesystem layout, not the INDEX section
    // header. Kept on the row so tests can assert the section header
    // is parsed correctly.
    #[allow(dead_code)]
    section: String, // "Active" | "On Hold" | "Archived"
}

/// Parse a project INDEX.md body into rows. Recognizes pipe-separated
/// markdown tables under H2 sections. Active table columns vary:
/// either `ID | Title | Status | Started | Target | Notes` (current
/// format) or older variants — we match by header name where possible
/// so a column reorder doesn't silently mis-key everything.
fn parse_project_index_body(body: &str) -> Vec<IndexRow> {
    let mut out: Vec<IndexRow> = Vec::new();
    let mut section: Option<String> = None;
    let mut headers: Option<Vec<String>> = None;

    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(h) = trimmed.strip_prefix("## ") {
            section = Some(h.trim().to_string());
            headers = None;
            continue;
        }
        if !trimmed.starts_with('|') {
            continue;
        }
        // Skip the alignment row (---|---|...).
        if trimmed.replace([' ', '|', '-', ':'], "").is_empty() {
            continue;
        }
        let cells: Vec<String> = trimmed
            .trim_start_matches('|')
            .trim_end_matches('|')
            .split('|')
            .map(|c| c.trim().to_string())
            .collect();
        if headers.is_none() {
            headers = Some(cells.iter().map(|s| s.to_lowercase()).collect());
            continue;
        }
        let h = headers.as_ref().unwrap();
        let pick = |name: &str| -> Option<String> {
            h.iter()
                .position(|x| x == name)
                .and_then(|i| cells.get(i).cloned())
                .filter(|s| !s.is_empty() && s != "—" && s != "-")
        };
        let slug = match pick("id") {
            Some(s) => s,
            None => continue,
        };
        out.push(IndexRow {
            slug,
            status_text: pick("status").unwrap_or_default(),
            target: pick("target"),
            notes: pick("notes"),
            section: section.clone().unwrap_or_default(),
        });
    }
    out
}

/// Map a free-text "Status" field to one of our four buckets when
/// it's directly recognizable. Returns None when the field is empty
/// or in a format we don't grok — the caller falls back to mtime.
fn parse_index_status(text: &str) -> Option<ProjectStatus> {
    let t = text.trim().to_lowercase();
    match t.as_str() {
        "active" | "on track" | "on-track" | "ontrack" => Some(ProjectStatus::OnTrack),
        "at risk" | "at-risk" | "atrisk" | "yellow" => Some(ProjectStatus::AtRisk),
        "blocked" | "stuck" | "red" => Some(ProjectStatus::Blocked),
        "soon done" | "soon-done" | "near done" | "shipping" => {
            Some(ProjectStatus::SoonDone)
        }
        "archived" | "complete" | "completed" | "done" => Some(ProjectStatus::Archived),
        _ => None,
    }
}

/// Fallback when no INDEX row claims a status. Idle > 21 days = at-
/// risk; otherwise on-track. Mirrors the heuristic PRD-115 §6.6 names.
fn mtime_derived_status(last_touched: Option<&str>, today_iso: &str) -> ProjectStatus {
    let Some(t) = last_touched else {
        return ProjectStatus::AtRisk;
    };
    // last_touched is ISO-8601 UTC like "2026-04-22T10:00:00Z" — pull
    // the YYYY-MM-DD prefix.
    let day = t.get(..10).unwrap_or("");
    match days_between(today_iso, day) {
        Some(d) if d > 21 => ProjectStatus::AtRisk,
        _ => ProjectStatus::OnTrack,
    }
}

/// Walk a markdown briefing body for the top-priorities section.
/// Resolve a markdown-link URL (typically written relative to the
/// briefing file) to a content-root-relative path. Returns None when
/// the path escapes the content root or doesn't refer to anything
/// existing on disk.
///
/// Folder-style targets like `projects/<id>/` are bumped to that
/// project's README.md — that's the canonical landing doc.
fn resolve_to_content_path(
    raw: &str,
    base_dir: Option<&std::path::Path>,
    content_root: &std::path::Path,
) -> Option<String> {
    use std::path::{Component, PathBuf};

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Strip a trailing `#fragment` or `?query` — they don't affect file
    // resolution and would only confuse the path joiner.
    let path_part = trimmed
        .split_once('#')
        .map(|(p, _)| p)
        .unwrap_or(trimmed)
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or(trimmed);
    if path_part.is_empty() {
        return None;
    }

    // Resolve relative to the briefing's own directory; if that's not
    // available, treat as already content-root-relative.
    let starting = base_dir
        .map(|d| d.to_path_buf())
        .unwrap_or_else(|| content_root.to_path_buf());
    let joined = starting.join(path_part);

    // Manual normalization — std doesn't expose canonicalize without
    // touching the filesystem, and we don't want symlink resolution.
    let mut normalized = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                if !normalized.pop() {
                    return None; // escaped above filesystem root
                }
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }

    // Must stay inside the content root.
    let rel = normalized.strip_prefix(content_root).ok()?;
    let mut candidate = rel.to_path_buf();

    // Folder-style ("projects/foo/") — point at README.md inside.
    let raw_ends_with_slash = raw.ends_with('/');
    let abs_candidate = content_root.join(&candidate);
    if raw_ends_with_slash || abs_candidate.is_dir() {
        candidate.push("README.md");
    }

    let abs_candidate = content_root.join(&candidate);
    if !abs_candidate.is_file() {
        return None;
    }

    // Convert to forward-slashed string for the JSON wire format.
    let s = candidate.to_string_lossy().replace('\\', "/");
    Some(s)
}

/// Pick a short, distinctive substring from a priority bullet that the
/// editor can match to scroll to the right line. Prefer the bolded
/// title (`**...**`) when present — briefings usually lead with one;
/// otherwise fall back to the first ~60 chars of plain text.
fn scroll_anchor_from_bullet(text: &str) -> String {
    if let Some(start) = text.find("**") {
        let rest = &text[start + 2..];
        if let Some(end) = rest.find("**") {
            let inner = rest[..end].trim();
            if !inner.is_empty() {
                return inner.to_string();
            }
        }
    }
    let plain: String = text.chars().take(80).collect();
    plain.trim().to_string()
}

/// Find the first `[title](url)` markdown link in `text` and return
/// the URL portion if it looks like a relative content path (no
/// scheme, no `mailto:`, no `#`-only fragment). Used by priority
/// cards to navigate to the doc the bullet is *about* rather than
/// back to the briefing itself.
fn first_relative_link(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            // Find matching ]
            if let Some(close_bracket) = text[i + 1..].find(']') {
                let after = i + 1 + close_bracket + 1;
                if after < bytes.len() && bytes[after] == b'(' {
                    if let Some(close_paren) = text[after + 1..].find(')') {
                        let url = &text[after + 1..after + 1 + close_paren];
                        let trimmed = url.trim();
                        if !trimmed.is_empty()
                            && !trimmed.starts_with('#')
                            && !trimmed.contains("://")
                            && !trimmed.starts_with("mailto:")
                            && !trimmed.starts_with("tel:")
                        {
                            return Some(trimmed);
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Recognizes "## Top Priorities", "## Priorities", "## Top 3", case-
/// insensitive. Pulls the first `limit` bullet items below it,
/// stopping at the next H2 or the end of the document. Strips bullet
/// markers (`- `, `* `, `1. `, `1) `) and trims whitespace.
fn extract_priority_bullets(body: &str, limit: usize) -> Vec<String> {
    let target_headings: &[&str] =
        &["top priorities", "priorities", "top 3", "top three"];
    let mut in_section = false;
    let mut out: Vec<String> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim_start();
        // Section change: any new H2 ends the priority section.
        if let Some(h2) = trimmed.strip_prefix("## ") {
            let h2_lower = h2.trim().to_lowercase();
            in_section = target_headings
                .iter()
                .any(|target| h2_lower == *target || h2_lower.starts_with(target));
            // Don't emit the heading itself
            continue;
        }
        // H1 or H3+ also resets — we stay strictly under the H2.
        if trimmed.starts_with("# ") || trimmed.starts_with("### ") {
            in_section = false;
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(text) = strip_bullet_marker(trimmed) {
            if !text.is_empty() {
                out.push(text);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    out
}

/// Pull the visible text out of a bullet line. Returns None when the
/// line isn't a bullet (so blank lines and prose paragraphs don't
/// pollute the priority list).
fn strip_bullet_marker(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("- ") {
        return Some(rest.trim().to_string());
    }
    if let Some(rest) = trimmed.strip_prefix("* ") {
        return Some(rest.trim().to_string());
    }
    // Numbered: "1. text" or "1) text", up to 2 digits.
    let mut chars = trimmed.chars();
    let mut digits = String::new();
    while let Some(c) = chars.clone().next() {
        if c.is_ascii_digit() && digits.len() < 2 {
            digits.push(c);
            chars.next();
        } else {
            break;
        }
    }
    if !digits.is_empty() {
        match chars.next() {
            Some('.') | Some(')') => {
                if let Some(' ') = chars.next() {
                    let rest: String = chars.collect();
                    return Some(rest.trim().to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Compute days from `from_iso` to `to_iso` (both `YYYY-MM-DD`).
/// Positive when `from` is after `to`. Returns None on parse failure
/// or implausibly bad input — caller treats as "unknown" not "today".
///
/// Uses the same Howard Hinnant civil-from-days algorithm in reverse
/// that format_systemtime uses to render forward.
fn days_between(from_iso: &str, to_iso: &str) -> Option<i64> {
    let a = ymd_to_days(from_iso)?;
    let b = ymd_to_days(to_iso)?;
    Some(a - b)
}

fn ymd_to_days(s: &str) -> Option<i64> {
    if s.len() < 10 {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    if m == 0 || m > 12 || d == 0 || d > 31 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y / 400 } else { (y - 399) / 400 };
    let yoe = (y - era * 400) as u64;
    let doy = ((153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as u32 - 1) as u64;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe as i64 - 719_468)
}

/// Render a SystemTime as ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ` without
/// pulling chrono into the dep tree just for one timestamp. Returns
/// None if the time predates the Unix epoch (shouldn't happen, but the
/// API gives us a Result on duration_since).
fn format_systemtime(t: std::time::SystemTime) -> Option<String> {
    let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = dur.as_secs() as i64;
    // Standard Y/M/D from a Unix epoch. We accept the small Gregorian
    // limitations for our use case (post-1970 timestamps only).
    let mut days = secs / 86_400;
    let mut sod = secs - days * 86_400;
    if sod < 0 {
        sod += 86_400;
        days -= 1;
    }
    let h = sod / 3600;
    let m = (sod % 3600) / 60;
    let s = sod % 60;
    // Convert days-since-1970 to (Y, M, D) using the Howard Hinnant
    // civil-from-days algorithm — exact, branchless, no leap-second
    // wobble. https://howardhinnant.github.io/date_algorithms.html
    let (y, mo, d) = days_to_ymd(days);
    Some(format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z"))
}

fn days_to_ymd(days_since_epoch: i64) -> (i64, u32, u32) {
    // Shift epoch to 0000-03-01 (start of "civil" calendar).
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Take a forward-slash rel path and return the parent folder shape that's
/// most useful for "which file is this": last 1-2 path components above
/// the filename. So `areas/one-on-ones/direct-reports/alice/sessions/2026-04-22.md`
/// → `direct-reports/alice`.
fn derive_context(rel: &str) -> String {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() < 2 {
        return String::new();
    }
    // Drop filename + the trailing "sessions" if present.
    let mut end = parts.len() - 1;
    if parts[end - 1] == "sessions" || parts[end - 1] == "archive" {
        end -= 1;
    }
    let start = end.saturating_sub(2);
    parts[start..end].join("/")
}

/// Pull a ~120-char window around the first occurrence of `q_lower` in
/// `body_lower`. Returns the matching window from the original-case
/// `body` so the frontend can highlight without re-finding.
fn snippet_around(body: &str, body_lower: &str, q_lower: &str) -> String {
    let idx = match body_lower.find(q_lower) {
        Some(i) => i,
        None => return body.chars().take(120).collect(),
    };
    let radius = 60;
    // Convert byte indices to char-safe indices to avoid splitting a
    // UTF-8 codepoint mid-byte. body and body_lower share lengths char-wise
    // since lowercase doesn't change byte counts for ASCII; for non-ASCII
    // we fall back to a simple char-window.
    let chars: Vec<char> = body.chars().collect();
    let q_char_idx = body[..idx].chars().count();
    let start = q_char_idx.saturating_sub(radius);
    let end = (q_char_idx + q_lower.chars().count() + radius).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    if start > 0 {
        out.insert_str(0, "…");
    }
    if end < chars.len() {
        out.push('…');
    }
    // Collapse runs of whitespace so multi-line snippets read cleanly
    // in a single palette row.
    let collapsed: String = out
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    collapsed
}

/// User-authored doc files: markdown (the bulk of the corpus) and HTML
/// (designed pages like project strategy guides). Both flow through the
/// same read/write/audit pipeline; the editor surface picks the right
/// renderer by extension. Date-keyed session listings stay md-only —
/// they pre-date HTML support and their stems are dates, not free names.
pub(crate) fn is_user_doc(name: &str) -> bool {
    name.ends_with(".md") || name.ends_with(".html")
}

/// Strip the trailing `.md` or `.html` if present; otherwise return the
/// name as-is. Used by search-hit labels and palette display.
pub(crate) fn strip_doc_ext(name: &str) -> &str {
    name.strip_suffix(".md")
        .or_else(|| name.strip_suffix(".html"))
        .unwrap_or(name)
}

/// Derive an attachment-cluster slug from a doc's rel-path (B7-CP28).
///
/// "areas/one-on-ones/manager/bob/sessions/2026-04-25.md"
///   → "areas-one-on-ones-manager-bob-sessions-2026-04-25"
///
/// Drops the trailing .md if present; replaces non-alnum with "-";
/// collapses runs of "-"; trims leading/trailing "-". Stable across
/// rebuilds so attachments stay clustered with the doc.
pub fn attachment_slug_for(doc_rel_path: &str) -> String {
    let stripped = doc_rel_path
        .trim()
        .strip_suffix(".md")
        .unwrap_or(doc_rel_path);
    let mut out = String::with_capacity(stripped.len());
    let mut prev_dash = false;
    for c in stripped.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        out.push_str("untitled");
    }
    out
}

/// Sanitize an attachment filename — keep ASCII alphanumerics, single
/// dots (so file extensions survive), dashes, and underscores. Any
/// other character collapses to a "-"; consecutive dots / leading
/// path-traversal segments collapse the same way. Leading + trailing
/// dots / dashes are stripped. Empty string when nothing safe survived.
pub fn sanitize_attachment_filename(name: &str) -> String {
    // Pass 1: convert non-safe chars to "-".
    let mut step1 = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            step1.push(c);
        } else {
            step1.push('-');
        }
    }
    // Pass 2: collapse consecutive "." to "-" (so "../" becomes "-")
    // and consecutive "-" to a single "-".
    let mut step2 = String::with_capacity(step1.len());
    let mut prev: Option<char> = None;
    for c in step1.chars() {
        let collapsed = match (prev, c) {
            (Some('.'), '.') => '-',
            (Some('-'), '-') => continue,
            (Some('-'), '.') => continue, // "-." → "-"
            _ => c,
        };
        // Avoid emitting double dashes from the (.,.) → '-' rewrite.
        if collapsed == '-' && prev == Some('-') {
            continue;
        }
        step2.push(collapsed);
        prev = Some(collapsed);
    }
    let mut out = step2;
    while out.starts_with('.') || out.starts_with('-') {
        out.remove(0);
    }
    while out.ends_with('-') || out.ends_with('.') {
        out.pop();
    }
    out
}

fn humanize(slug: &str) -> String {
    slug.split('-')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn seed_content(dir: &std::path::Path) {
        let areas = dir.join("areas");
        let o = areas
            .join("one-on-ones")
            .join("direct-reports")
            .join("direct-report-a")
            .join("sessions");
        fs::create_dir_all(&o).unwrap();
        fs::write(o.join("2026-04-20.md"), "# Direct Report A\nnotes").unwrap();
        fs::write(o.join("2026-03-15.md"), "# older").unwrap();
        fs::write(o.join("compacted_2025-Q4.md"), "skip me").unwrap();
        fs::write(o.join("README.md"), "skip me").unwrap();
        let archive = o.join("archive");
        fs::create_dir_all(&archive).unwrap();
        fs::write(archive.join("2024-01-01.md"), "skip").unwrap();

        let m = areas
            .join("meetings")
            .join("team-leadership")
            .join("sessions");
        fs::create_dir_all(&m).unwrap();
        fs::write(m.join("2026-04-18.md"), "# meeting").unwrap();
    }

    #[test]
    fn humanize_splits_on_dashes_and_title_cases() {
        assert_eq!(humanize("direct-report-a"), "Direct Report A");
        assert_eq!(humanize("team-leadership"), "Team Leadership");
        assert_eq!(humanize(""), "");
    }

    fn seed_people(dir: &std::path::Path) {
        let oo = dir.join("areas").join("one-on-ones");
        // direct-report-a (direct report) with 2 sessions + a compacted file
        let report_a = oo.join("direct-reports").join("direct-report-a");
        fs::create_dir_all(report_a.join("sessions")).unwrap();
        fs::write(report_a.join("README.md"), "# Direct Report A").unwrap();
        fs::write(report_a.join("sessions").join("2026-04-20.md"), "s").unwrap();
        fs::write(report_a.join("sessions").join("2026-04-14.md"), "s").unwrap();
        fs::write(
            report_a.join("sessions").join("compacted_2026-Q1.md"),
            "skip",
        )
        .unwrap();
        // direct-report-b (direct report) with 1 session, no README yet
        let report_b = oo.join("direct-reports").join("direct-report-b");
        fs::create_dir_all(report_b.join("sessions")).unwrap();
        fs::write(report_b.join("sessions").join("2026-04-22.md"), "s").unwrap();
        // peer-a (peer) with README + 1 session
        let peer_a = oo.join("peers").join("peer-a");
        fs::create_dir_all(peer_a.join("sessions")).unwrap();
        fs::write(peer_a.join("README.md"), "# Peer A").unwrap();
        fs::write(peer_a.join("sessions").join("2026-04-18.md"), "s").unwrap();
        // my-manager (manager) with README, 0 sessions
        let my_manager = oo.join("manager").join("my-manager");
        fs::create_dir_all(&my_manager).unwrap();
        fs::write(my_manager.join("README.md"), "# My Manager").unwrap();
        // stale alumni (shouldn't block — just sinks to bottom)
        let old = oo.join("alumni").join("alumni-a");
        fs::create_dir_all(old.join("sessions")).unwrap();
        fs::write(old.join("sessions").join("2024-01-01.md"), "s").unwrap();
    }

    #[test]
    fn list_people_groups_and_orders_by_relationship_then_recency() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());

        let people = c.list_people().unwrap();
        // Expected top-to-bottom:
        //   direct-reports: direct-report-a (2026-04-20), direct-report-b (2026-04-22) — direct-report-b first since it's newer
        //   manager:        my-manager (no sessions)
        //   peers:          peer-a
        //   alumni:         alumni-a
        let slugs: Vec<&str> = people.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(
            slugs,
            vec!["direct-report-b", "direct-report-a", "my-manager", "peer-a", "alumni-a"]
        );

        let report_a = &people[1];
        assert_eq!(report_a.relationship, "direct-reports");
        assert_eq!(report_a.label, "Direct Report A");
        assert_eq!(report_a.session_count, 2);
        assert_eq!(report_a.last_session.as_deref(), Some("2026-04-20"));
        assert!(report_a.has_readme);

        let my_manager = &people[2];
        assert_eq!(my_manager.session_count, 0);
        assert!(my_manager.last_session.is_none());
        assert!(my_manager.has_readme);

        let report_b = &people[0];
        assert!(!report_b.has_readme);
    }

    #[test]
    fn read_person_profile_returns_readme_and_sessions_newest_first() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());

        let profile = c
            .read_person_profile(
                "areas/one-on-ones/direct-reports/direct-report-a",
                5,
            )
            .unwrap();
        assert_eq!(
            profile.rel_path,
            "areas/one-on-ones/direct-reports/direct-report-a"
        );
        assert!(profile.readme.unwrap().contains("Direct Report A"));
        let dates: Vec<&str> = profile
            .sessions
            .iter()
            .map(|s| s.date.as_str())
            .collect();
        assert_eq!(dates, vec!["2026-04-20", "2026-04-14"]);
        assert_eq!(
            profile.sessions[0].rel_path,
            "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md"
        );
    }

    #[test]
    fn read_person_profile_respects_limit() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let profile = c
            .read_person_profile(
                "areas/one-on-ones/direct-reports/direct-report-a",
                1,
            )
            .unwrap();
        assert_eq!(profile.sessions.len(), 1);
        assert_eq!(profile.sessions[0].date, "2026-04-20");
    }

    #[test]
    fn read_person_profile_errors_on_missing_folder() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let err = c
            .read_person_profile(
                "areas/one-on-ones/direct-reports/ghost",
                5,
            )
            .unwrap_err();
        assert!(matches!(
            err,
            AppError::NotFound(_) | AppError::Io(_)
        ));
    }

    #[test]
    fn write_person_meta_merges_into_existing_file() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());

        // First write: only title.
        let first = PersonMeta {
            title: Some("Manager, Team X".into()),
            ..Default::default()
        };
        let after_first = c
            .write_person_meta("areas/one-on-ones/direct-reports/direct-report-a", first)
            .unwrap();
        assert_eq!(after_first.title.as_deref(), Some("Manager, Team X"));
        assert!(after_first.email.is_none());

        // Second write: email only — title preserved.
        let second = PersonMeta {
            email: Some("a@example.com".into()),
            ..Default::default()
        };
        let after_second = c
            .write_person_meta("areas/one-on-ones/direct-reports/direct-report-a", second)
            .unwrap();
        assert_eq!(after_second.title.as_deref(), Some("Manager, Team X"));
        assert_eq!(after_second.email.as_deref(), Some("a@example.com"));

        // Third write: title overwritten (incoming Some wins).
        let third = PersonMeta {
            title: Some("Director, Team Y".into()),
            ..Default::default()
        };
        let after_third = c
            .write_person_meta("areas/one-on-ones/direct-reports/direct-report-a", third)
            .unwrap();
        assert_eq!(after_third.title.as_deref(), Some("Director, Team Y"));
        assert_eq!(after_third.email.as_deref(), Some("a@example.com"));
    }

    #[test]
    fn write_person_meta_skips_empty_payload() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        // No existing person.json; empty incoming → no file written.
        let got = c
            .write_person_meta(
                "areas/one-on-ones/direct-reports/direct-report-a",
                PersonMeta::default(),
            )
            .unwrap();
        assert!(got.is_empty());
        let meta_path = tmp
            .path()
            .join("areas/one-on-ones/direct-reports/direct-report-a/person.json");
        assert!(!meta_path.exists());
    }

    #[test]
    fn read_person_meta_returns_none_when_missing() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let got = c
            .read_person_meta("areas/one-on-ones/direct-reports/direct-report-a")
            .unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn recent_briefings_returns_newest_first_skipping_noise() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp
            .path()
            .join("areas")
            .join("daily-briefings")
            .join("sessions");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("2026-04-20.md"), "x").unwrap();
        fs::write(dir.join("2026-04-15.md"), "x").unwrap();
        fs::write(dir.join("2026-04-22.md"), "x").unwrap();
        fs::write(dir.join("compacted_2025-Q4.md"), "skip").unwrap();
        fs::write(dir.join("README.md"), "skip").unwrap();
        fs::create_dir_all(dir.join("archive")).unwrap();
        fs::write(dir.join("archive").join("2024-01-01.md"), "skip").unwrap();

        let c = Content::new(tmp.path().to_path_buf());
        let got = c.recent_briefings(0).unwrap();
        let dates: Vec<&str> = got.iter().map(|b| b.date.as_str()).collect();
        assert_eq!(dates, vec!["2026-04-22", "2026-04-20", "2026-04-15"]);
        assert_eq!(
            got[0].rel_path,
            "areas/daily-briefings/sessions/2026-04-22.md"
        );
    }

    #[test]
    fn recent_briefings_empty_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        assert!(c.recent_briefings(5).unwrap().is_empty());
    }

    #[test]
    fn recent_briefings_respects_limit() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp
            .path()
            .join("areas")
            .join("daily-briefings")
            .join("sessions");
        fs::create_dir_all(&dir).unwrap();
        for d in ["2026-04-20", "2026-04-21", "2026-04-22"] {
            fs::write(dir.join(format!("{d}.md")), "x").unwrap();
        }
        let c = Content::new(tmp.path().to_path_buf());
        let got = c.recent_briefings(2).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].date, "2026-04-22");
    }

    #[test]
    fn read_person_profile_works_when_readme_missing() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        // direct-report-b was seeded with 1 session but no README.
        let profile = c
            .read_person_profile(
                "areas/one-on-ones/direct-reports/direct-report-b",
                5,
            )
            .unwrap();
        assert!(profile.readme.is_none());
        assert_eq!(profile.sessions.len(), 1);
    }

    #[test]
    fn list_people_returns_empty_when_directory_missing() {
        let tmp = TempDir::new().unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        assert!(c.list_people().unwrap().is_empty());
    }

    #[test]
    fn restore_from_audit_recovers_before_blob_and_rewrites_file_on_disk() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        let rel = "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md";
        let original = fs::read_to_string(tmp.path().join(rel)).unwrap();

        // First write replaces the content.
        c.save_markdown(rel, "# tampered\nbad write", &mut db, &blobs, "local")
            .unwrap();
        assert_eq!(
            fs::read_to_string(tmp.path().join(rel)).unwrap(),
            "# tampered\nbad write",
        );

        let write_row = crate::audit::recent(&db, 5)
            .unwrap()
            .iter()
            .find(|r| r.action == "doc.write")
            .unwrap()
            .clone();

        let outcome =
            c.restore_from_audit(write_row.id, &mut db, &blobs, "local").unwrap();
        match outcome {
            RestoreOutcome::Restored(_) => {}
            other => panic!("expected Restored, got {:?}", other),
        }

        // CRITICAL: the on-disk file must actually be the pre-write
        // content. Earlier tests asserted "Ok(Some(_))" without
        // checking the file — this is what the user reported broken.
        let on_disk = fs::read_to_string(tmp.path().join(rel)).unwrap();
        assert_eq!(on_disk, original, "file should be reverted to pre-write content");

        // Second restore on the same audit row hits save_markdown's
        // content-equal short-circuit: the file is already at the
        // before-state, so save_markdown skips the write and returns
        // skipped=true. Surface that as NoOp.
        let outcome2 =
            c.restore_from_audit(write_row.id, &mut db, &blobs, "local").unwrap();
        assert!(
            matches!(outcome2, RestoreOutcome::NoOp { .. }),
            "second restore should be a NoOp, got {:?}",
            outcome2,
        );
    }

    #[test]
    fn restore_from_audit_works_inside_a_git_tracked_workspace() {
        // Regression for the original B3-CP6 design: save_markdown
        // skipped blob capture when git_tracked=true, which made
        // restore a no-op in the user's actual workspace (the whole
        // repo is one big git tree). Verify the fix: blobs ARE
        // captured even when a parent .git/ exists, and restore
        // actually rewrites the file.
        let tmp = TempDir::new().unwrap();
        // Plant a fake .git/ at the workspace root so inside_git_tree
        // walks up and finds it for any file beneath.
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        let rel = "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md";
        let original = fs::read_to_string(tmp.path().join(rel)).unwrap();

        // Save_markdown sets git_tracked=true on the audit row.
        let result = c
            .save_markdown(rel, "# overwritten", &mut db, &blobs, "local")
            .unwrap();
        assert!(result.git_tracked, "expected git_tracked=true");

        let write_row = crate::audit::recent(&db, 5)
            .unwrap()
            .iter()
            .find(|r| r.action == "doc.write")
            .unwrap()
            .clone();

        // Despite git_tracked=true, restore should now succeed
        // because we always capture blobs.
        let outcome =
            c.restore_from_audit(write_row.id, &mut db, &blobs, "local").unwrap();
        assert!(
            matches!(outcome, RestoreOutcome::Restored(_)),
            "expected Restored in git-tracked workspace, got {:?}",
            outcome,
        );
        assert_eq!(
            fs::read_to_string(tmp.path().join(rel)).unwrap(),
            original,
            "file should be reverted",
        );
    }

    #[test]
    fn restore_from_audit_returns_create_row_for_first_write() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        fs::create_dir_all(tmp.path().join("areas/x")).unwrap();
        c.save_markdown("areas/x/new-file.md", "# new", &mut db, &blobs, "local")
            .unwrap();

        let row = crate::audit::recent(&db, 5).unwrap()[0].clone();
        let outcome = c
            .restore_from_audit(row.id, &mut db, &blobs, "local")
            .unwrap();
        assert!(
            matches!(outcome, RestoreOutcome::CreateRow),
            "expected CreateRow, got {:?}",
            outcome,
        );
    }

    #[test]
    fn restore_from_audit_returns_blob_missing_when_snapshot_purged() {
        // Simulate a historical audit row that points at a blob
        // which is no longer on disk (e.g., user wiped .blobs/
        // manually, or the row predates snapshot capture).
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        let rel = "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md";
        c.save_markdown(rel, "# v2", &mut db, &blobs, "local").unwrap();

        // Wipe the blob store. The audit row still references the
        // before_hash but the blob is gone.
        fs::remove_dir_all(tmp.path().join(".blobs")).unwrap();
        let blobs = crate::snapshots::BlobStore::open(
            &tmp.path().join(".blobs"),
        )
        .unwrap();

        let row = crate::audit::recent(&db, 5)
            .unwrap()
            .iter()
            .find(|r| r.action == "doc.write")
            .unwrap()
            .clone();
        let outcome = c.restore_from_audit(row.id, &mut db, &blobs, "local").unwrap();
        assert!(
            matches!(outcome, RestoreOutcome::BlobMissing),
            "expected BlobMissing, got {:?}",
            outcome,
        );
    }

    #[test]
    fn restore_from_audit_rejects_non_doc_write_action() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        // Synthesize an audit row with a different action.
        crate::audit::append(
            &db,
            "local",
            "task.complete",
            "task",
            "t1",
            "{}",
        )
        .unwrap();
        let row = crate::audit::recent(&db, 1).unwrap()[0].clone();
        let err =
            c.restore_from_audit(row.id, &mut db, &blobs, "local").unwrap_err();
        assert!(format!("{err}").contains("only doc.write"));
    }

    #[test]
    fn parse_index_status_recognizes_common_forms() {
        assert_eq!(parse_index_status("active"), Some(ProjectStatus::OnTrack));
        assert_eq!(parse_index_status("On Track"), Some(ProjectStatus::OnTrack));
        assert_eq!(parse_index_status("at-risk"), Some(ProjectStatus::AtRisk));
        assert_eq!(parse_index_status("yellow"), Some(ProjectStatus::AtRisk));
        assert_eq!(parse_index_status("blocked"), Some(ProjectStatus::Blocked));
        assert_eq!(
            parse_index_status("near done"),
            Some(ProjectStatus::SoonDone),
        );
        assert_eq!(parse_index_status(""), None);
        assert_eq!(parse_index_status("???"), None);
    }

    #[test]
    fn parse_project_index_body_handles_active_and_archived() {
        let body = "\
# Projects Index

## Active

| ID | Title | Status | Started | Target | Notes |
|----|-------|--------|---------|--------|-------|
| alpha | Alpha | active | 2026-04-01 | 2026-04-30 | Some note |
| beta | Beta | blocked | 2026-04-05 | — | blocked: vendor SLA |

## Archived

| ID | Title | Completed | Notes |
|----|-------|-----------|-------|
| gamma | Gamma | 2026-03-15 | done |
";
        let rows = parse_project_index_body(body);
        assert_eq!(rows.len(), 3);
        let alpha = rows.iter().find(|r| r.slug == "alpha").unwrap();
        assert_eq!(alpha.status_text, "active");
        assert_eq!(alpha.target.as_deref(), Some("2026-04-30"));
        assert_eq!(alpha.notes.as_deref(), Some("Some note"));
        assert_eq!(alpha.section, "Active");
        let beta = rows.iter().find(|r| r.slug == "beta").unwrap();
        assert_eq!(beta.status_text, "blocked");
        assert!(beta.target.is_none(), "em-dash target should be filtered");
        let gamma = rows.iter().find(|r| r.slug == "gamma").unwrap();
        assert_eq!(gamma.section, "Archived");
    }

    #[test]
    fn compute_project_statuses_uses_explicit_then_blocked_then_mtime() {
        let tmp = TempDir::new().unwrap();
        // alpha: active in INDEX, fresh mtime → on-track explicit
        fs::create_dir_all(tmp.path().join("projects/alpha")).unwrap();
        fs::write(tmp.path().join("projects/alpha/README.md"), "alpha").unwrap();
        // beta: active in INDEX but notes contain "blocked: …" → blocked derived
        fs::create_dir_all(tmp.path().join("projects/beta")).unwrap();
        fs::write(tmp.path().join("projects/beta/README.md"), "beta").unwrap();
        // gamma: not in INDEX, fresh → on-track derived
        fs::create_dir_all(tmp.path().join("projects/gamma")).unwrap();
        fs::write(tmp.path().join("projects/gamma/README.md"), "gamma").unwrap();
        // delta: not in INDEX, no files → at-risk derived
        fs::create_dir_all(tmp.path().join("projects/delta")).unwrap();

        fs::write(
            tmp.path().join("projects/INDEX.md"),
            "# Projects Index\n\
            \n\
            ## Active\n\
            \n\
            | ID | Title | Status | Started | Target | Notes |\n\
            |----|-------|--------|---------|--------|-------|\n\
            | alpha | Alpha | active | 2026-04-01 | — | normal |\n\
            | beta | Beta | active | 2026-04-01 | — | blocked: waiting on legal |\n\
            ",
        )
        .unwrap();

        let c = Content::new(tmp.path().to_path_buf());
        let out = c.compute_project_statuses("2026-04-25").unwrap();
        let by_slug: std::collections::HashMap<&str, &ProjectStatusInfo> =
            out.iter().map(|r| (r.slug.as_str(), r)).collect();

        assert_eq!(by_slug["alpha"].status, ProjectStatus::OnTrack);
        assert_eq!(by_slug["alpha"].source, "explicit");
        assert_eq!(by_slug["beta"].status, ProjectStatus::Blocked);
        assert_eq!(by_slug["beta"].source, "derived");
        assert_eq!(by_slug["gamma"].status, ProjectStatus::OnTrack);
        assert_eq!(by_slug["gamma"].source, "derived");
        assert_eq!(by_slug["delta"].status, ProjectStatus::AtRisk);
        assert_eq!(by_slug["delta"].source, "derived");
    }

    #[test]
    fn compute_project_statuses_marks_soon_done_for_target_within_7_days() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("projects/imminent")).unwrap();
        fs::write(tmp.path().join("projects/imminent/README.md"), "x").unwrap();
        fs::write(
            tmp.path().join("projects/INDEX.md"),
            "## Active\n\n\
            | ID | Title | Status | Started | Target | Notes |\n\
            |----|-------|--------|---------|--------|-------|\n\
            | imminent | Imminent | TBD | 2026-04-01 | 2026-04-30 | x |\n",
        )
        .unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        let out = c.compute_project_statuses("2026-04-25").unwrap();
        let row = out.iter().find(|r| r.slug == "imminent").unwrap();
        assert_eq!(row.status, ProjectStatus::SoonDone);
        assert_eq!(row.source, "derived");
    }

    #[test]
    fn strip_bullet_marker_handles_dash_star_and_numbered() {
        assert_eq!(
            strip_bullet_marker("- buy milk").as_deref(),
            Some("buy milk"),
        );
        assert_eq!(
            strip_bullet_marker("* item").as_deref(),
            Some("item"),
        );
        assert_eq!(
            strip_bullet_marker("1. first").as_deref(),
            Some("first"),
        );
        assert_eq!(
            strip_bullet_marker("12) twelve").as_deref(),
            Some("twelve"),
        );
        // Indented bullets still parse
        assert_eq!(
            strip_bullet_marker("    - nested").as_deref(),
            Some("nested"),
        );
        // Non-bullets return None
        assert!(strip_bullet_marker("plain text").is_none());
        assert!(strip_bullet_marker("").is_none());
        // Bare digit without punctuation isn't a bullet
        assert!(strip_bullet_marker("123 not a bullet").is_none());
    }

    #[test]
    fn extract_priority_bullets_takes_first_n_under_heading() {
        let body = "\
# Briefing

intro paragraph

## Top Priorities

- one
- two
- three
- four

## Calendar

- ignored

## Priorities

- also ignored (we already exited)
";
        let got = extract_priority_bullets(body, 3);
        assert_eq!(got, vec!["one", "two", "three"]);
    }

    #[test]
    fn extract_priority_bullets_recognizes_alt_headings() {
        for h in &["Priorities", "Top 3", "Top three"] {
            let body = format!("# t\n\n## {h}\n\n- alpha\n- beta\n");
            let got = extract_priority_bullets(&body, 5);
            assert_eq!(got, vec!["alpha", "beta"], "heading {h} failed");
        }
    }

    #[test]
    fn extract_priority_bullets_returns_empty_when_section_missing() {
        let body = "# briefing\n\n## Calendar\n\n- not a priority\n";
        assert!(extract_priority_bullets(body, 3).is_empty());
    }

    #[test]
    fn top_priorities_from_briefing_loads_today_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("areas/daily-briefings/sessions");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("2026-04-25.md"),
            "# Friday April 25\n\n## Top Priorities\n\n- ship cp4\n- review aaron prep\n- send the slack update\n",
        )
        .unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        let got = c.top_priorities_from_briefing("2026-04-25", 3).unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].text, "ship cp4");
        assert_eq!(got[0].source, "briefing");
        assert_eq!(
            got[0].rel_path.as_deref(),
            Some("areas/daily-briefings/sessions/2026-04-25.md"),
        );
    }

    #[test]
    fn top_priorities_from_briefing_resolves_links() {
        let tmp = TempDir::new().unwrap();
        // Mimic production layout: briefing in areas/daily-briefings/sessions,
        // a project README the bullet links to, and a session file.
        let briefing_dir = tmp.path().join("areas/daily-briefings/sessions");
        fs::create_dir_all(&briefing_dir).unwrap();
        let project_dir = tmp.path().join("projects/leadership-shift");
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(project_dir.join("README.md"), "# Leadership shift\n").unwrap();
        let session_dir =
            tmp.path().join("areas/one-on-ones/direct-reports/aaron-salls/sessions");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(session_dir.join("2026-04-25.md"), "# Aaron 4/25\n").unwrap();

        fs::write(
            briefing_dir.join("2026-04-25.md"),
            "## Top Priorities\n\n\
             1. **Aaron transition** — see [aaron 4/25](../../one-on-ones/direct-reports/aaron-salls/sessions/2026-04-25.md)\n\
             2. **Bob leadership shift** — [project](../../../projects/leadership-shift/) — HIGH, due 4/22.\n\
             3. **Churn model use cases for Avik** — HIGH, due today.\n",
        ).unwrap();

        let c = Content::new(tmp.path().to_path_buf());
        let got = c.top_priorities_from_briefing("2026-04-25", 3).unwrap();
        assert_eq!(got.len(), 3);

        // (1) relative-from-briefing link → resolved to content path,
        //     no scroll hint (we have a precise target).
        assert_eq!(
            got[0].rel_path.as_deref(),
            Some("areas/one-on-ones/direct-reports/aaron-salls/sessions/2026-04-25.md"),
        );
        assert_eq!(got[0].scroll_to, None);

        // (2) folder-style project link → resolved to projects/<id>/README.md.
        assert_eq!(
            got[1].rel_path.as_deref(),
            Some("projects/leadership-shift/README.md"),
        );
        assert_eq!(got[1].scroll_to, None);

        // (3) no link → fall back to briefing + scroll anchor (the
        //     bolded title).
        assert_eq!(
            got[2].rel_path.as_deref(),
            Some("areas/daily-briefings/sessions/2026-04-25.md"),
        );
        assert_eq!(
            got[2].scroll_to.as_deref(),
            Some("Churn model use cases for Avik"),
        );
    }

    #[test]
    fn first_relative_link_skips_external_and_anchors() {
        assert_eq!(first_relative_link("[x](rel/path.md)"), Some("rel/path.md"));
        assert_eq!(first_relative_link("[x](https://a.com)"), None);
        assert_eq!(first_relative_link("[x](mailto:a@b)"), None);
        assert_eq!(first_relative_link("[x](#anchor)"), None);
        assert_eq!(first_relative_link("no link here"), None);
        assert_eq!(
            first_relative_link("[**bold**](first.md) and [other](second.md)"),
            Some("first.md"),
            "first link wins",
        );
    }

    #[test]
    fn top_priorities_from_briefing_returns_empty_when_no_file() {
        let tmp = TempDir::new().unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        let got = c.top_priorities_from_briefing("2026-04-25", 3).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn days_between_matches_expected_dates() {
        assert_eq!(days_between("2026-04-25", "2026-04-25"), Some(0));
        assert_eq!(days_between("2026-04-25", "2026-04-24"), Some(1));
        assert_eq!(days_between("2026-04-25", "2026-04-11"), Some(14));
        assert_eq!(days_between("2026-05-01", "2026-04-30"), Some(1));
        assert_eq!(days_between("2027-01-01", "2026-12-31"), Some(1));
        // Leap day handling
        assert_eq!(days_between("2024-03-01", "2024-02-29"), Some(1));
        // Bad input
        assert_eq!(days_between("not-a-date", "2026-04-25"), None);
        assert_eq!(days_between("2026-13-01", "2026-04-25"), None);
    }

    #[test]
    fn list_attention_people_flags_stale_no_readme_and_no_sessions() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        // Direct report A — has README + recent session 5 days ago
        let a = root.join("areas/one-on-ones/direct-reports/alice");
        fs::create_dir_all(a.join("sessions")).unwrap();
        fs::write(a.join("README.md"), "# Alice").unwrap();
        fs::write(a.join("sessions/2026-04-20.md"), "# session").unwrap();
        // Direct report B — no README, has session 5 days ago
        let b = root.join("areas/one-on-ones/direct-reports/bob");
        fs::create_dir_all(b.join("sessions")).unwrap();
        fs::write(b.join("sessions/2026-04-20.md"), "# session").unwrap();
        // Direct report C — has README, last session 30 days ago (stale)
        let c = root.join("areas/one-on-ones/direct-reports/carol");
        fs::create_dir_all(c.join("sessions")).unwrap();
        fs::write(c.join("README.md"), "# Carol").unwrap();
        fs::write(c.join("sessions/2026-03-26.md"), "# session").unwrap();
        // Direct report D — has README but no sessions yet
        let d = root.join("areas/one-on-ones/direct-reports/dan");
        fs::create_dir_all(d.join("sessions")).unwrap();
        fs::write(d.join("README.md"), "# Dan").unwrap();
        // Peer — should NEVER be flagged even if stale (kind filter)
        let p = root.join("areas/one-on-ones/peers/peer-x");
        fs::create_dir_all(p.join("sessions")).unwrap();

        let c_obj = Content::new(root.to_path_buf());
        let attn = c_obj.list_attention_people("2026-04-25", 14).unwrap();

        let slugs: Vec<&str> = attn.iter().map(|a| a.slug.as_str()).collect();
        // Alice not flagged (5 days ago + has README)
        assert!(!slugs.contains(&"alice"));
        // Bob flagged (no-readme)
        assert!(slugs.contains(&"bob"));
        // Carol flagged (stale)
        assert!(slugs.contains(&"carol"));
        // Dan flagged (no-sessions)
        assert!(slugs.contains(&"dan"));
        // Peer never flagged
        assert!(!slugs.contains(&"peer-x"));

        // Strongest signal sorts first: no-sessions > no-readme > stale
        let dan = attn.iter().find(|a| a.slug == "dan").unwrap();
        assert!(dan.reasons.iter().any(|r| r == "no-sessions"));
        assert_eq!(attn[0].slug, "dan");

        let bob = attn.iter().find(|a| a.slug == "bob").unwrap();
        assert!(bob.reasons.iter().any(|r| r == "no-readme"));

        let carol = attn.iter().find(|a| a.slug == "carol").unwrap();
        assert_eq!(carol.days_since_last_session, Some(30));
        assert!(carol.reasons.iter().any(|r| r == "stale"));
    }

    #[test]
    fn list_attention_people_returns_empty_when_no_signals() {
        let tmp = TempDir::new().unwrap();
        let a = tmp.path().join("areas/one-on-ones/direct-reports/alice");
        fs::create_dir_all(a.join("sessions")).unwrap();
        fs::write(a.join("README.md"), "# Alice").unwrap();
        // 5 days ago — under the 14-day threshold
        fs::write(a.join("sessions/2026-04-20.md"), "ok").unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        assert_eq!(
            c.list_attention_people("2026-04-25", 14).unwrap().len(),
            0,
        );
    }

    #[test]
    fn list_project_refs_returns_label_readme_and_extras() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        // alpha-project: README + one extra
        fs::create_dir_all(tmp.path().join("projects/alpha-project")).unwrap();
        fs::write(
            tmp.path().join("projects/alpha-project/README.md"),
            "# alpha\n",
        ).unwrap();
        fs::write(
            tmp.path().join("projects/alpha-project/notes.md"),
            "# notes\n",
        ).unwrap();
        // bare-project: no README, just one note
        fs::create_dir_all(tmp.path().join("projects/bare-project")).unwrap();
        fs::write(
            tmp.path().join("projects/bare-project/sketch.md"),
            "draft",
        ).unwrap();
        // ignored dotfile dir
        fs::create_dir_all(tmp.path().join("projects/.cache")).unwrap();

        let c = Content::new(tmp.path().to_path_buf());
        let refs = c.list_project_refs().unwrap();
        let slugs: Vec<&str> = refs.iter().map(|r| r.slug.as_str()).collect();
        assert!(slugs.contains(&"alpha-project"));
        assert!(slugs.contains(&"bare-project"));
        assert!(!slugs.contains(&".cache"));

        let alpha = refs.iter().find(|r| r.slug == "alpha-project").unwrap();
        assert_eq!(alpha.label, "Alpha Project");
        assert_eq!(alpha.rel_path, "projects/alpha-project");
        assert!(alpha.has_readme);
        assert_eq!(alpha.extra_md_count, 1);
        assert!(alpha.last_touched.is_some());
        assert!(
            alpha
                .last_touched
                .as_deref()
                .unwrap()
                .starts_with("20"),
            "expected ISO timestamp, got {:?}",
            alpha.last_touched,
        );

        let bare = refs.iter().find(|r| r.slug == "bare-project").unwrap();
        assert!(!bare.has_readme);
        assert_eq!(bare.extra_md_count, 1);
    }

    #[test]
    fn list_project_files_orders_readme_first() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let dir = tmp.path().join("projects/x");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("README.md"), "r").unwrap();
        fs::write(dir.join("a.md"), "a").unwrap();
        fs::write(dir.join("z.md"), "z").unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        let files = c.list_project_files("projects/x").unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["README.md", "a.md", "z.md"]);
    }

    #[test]
    fn list_project_refs_returns_empty_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        assert_eq!(c.list_project_refs().unwrap().len(), 0);
    }

    #[test]
    fn list_projects_returns_dir_names_only() {
        let tmp = TempDir::new().unwrap();
        let projects = tmp.path().join("projects");
        fs::create_dir_all(projects.join("alpha")).unwrap();
        fs::create_dir_all(projects.join("beta")).unwrap();
        fs::create_dir_all(projects.join(".hidden")).unwrap();
        fs::write(projects.join("INDEX.md"), "# Projects").unwrap();
        fs::write(projects.join("README.md"), "# Readme").unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        assert_eq!(
            c.list_projects().unwrap(),
            vec!["alpha".to_string(), "beta".to_string()]
        );
    }

    #[test]
    fn list_projects_returns_empty_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let c = Content::new(tmp.path().to_path_buf());
        assert!(c.list_projects().unwrap().is_empty());
    }

    #[test]
    fn recent_sessions_sorts_by_date_desc_skipping_archive_and_compacted() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());

        let refs = c.recent_sessions(10).unwrap();
        let dates: Vec<&str> = refs.iter().map(|r| r.date.as_str()).collect();
        assert_eq!(dates, vec!["2026-04-20", "2026-04-18", "2026-03-15"]);
        // owner label humanized
        let report_a = refs.iter().find(|r| r.owner_slug == "direct-report-a").unwrap();
        assert_eq!(report_a.owner_label, "Direct Report A");
        assert_eq!(report_a.owner_kind, "one-on-ones");
    }

    #[test]
    fn recent_sessions_respects_limit() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        assert_eq!(c.recent_sessions(1).unwrap().len(), 1);
        assert_eq!(c.recent_sessions(2).unwrap().len(), 2);
    }

    #[test]
    fn read_markdown_within_root_succeeds() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let doc = c
            .read_markdown(
                "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md",
            )
            .unwrap();
        assert!(doc.markdown.contains("Direct Report A"));
    }

    #[test]
    fn read_markdown_rejects_parent_escape() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        // Relative path with `..` → rejected by Component validation.
        let err = c.read_markdown("../outside.md").unwrap_err();
        assert!(format!("{err}").contains("plain components"));
    }

    #[test]
    fn read_markdown_rejects_absolute_path() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let err = c.read_markdown("/etc/passwd").unwrap_err();
        assert!(format!("{err}").contains("plain components"));
    }

    #[test]
    fn missing_root_returns_empty_session_list() {
        let tmp = TempDir::new().unwrap();
        let c = Content::new(tmp.path().join("does-not-exist"));
        assert_eq!(c.recent_sessions(5).unwrap().len(), 0);
        assert!(!c.status().found);
    }

    // --- CP7 write-path tests ---

    fn open_mem_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::Db::init_schema_for_test(&conn).unwrap();
        conn
    }

    #[test]
    #[test]
    fn attachment_slug_for_uses_doc_path_with_dashes() {
        assert_eq!(
            attachment_slug_for(
                "areas/one-on-ones/manager/bob/sessions/2026-04-25.md",
            ),
            "areas-one-on-ones-manager-bob-sessions-2026-04-25",
        );
        assert_eq!(
            attachment_slug_for("projects/alpha-launch/README.md"),
            "projects-alpha-launch-readme",
        );
        // Trim leading/trailing dashes; collapse runs.
        assert_eq!(attachment_slug_for("///foo///bar.md"), "foo-bar");
        // Empty / pure-special input falls back to "untitled".
        assert_eq!(attachment_slug_for(""), "untitled");
        assert_eq!(attachment_slug_for("///"), "untitled");
    }

    #[test]
    fn sanitize_attachment_filename_keeps_safe_chars_only() {
        assert_eq!(
            sanitize_attachment_filename("Screenshot 2026-04-25.png"),
            "Screenshot-2026-04-25.png",
        );
        assert_eq!(
            sanitize_attachment_filename("../../etc/passwd"),
            "etc-passwd",
        );
        assert_eq!(sanitize_attachment_filename(".hidden.png"), "hidden.png");
        assert_eq!(
            sanitize_attachment_filename("a / b / c.jpg"),
            "a-b-c.jpg",
        );
    }

    #[test]
    fn write_attachment_writes_under_attachments_dir_and_returns_rel_path() {
        let tmp = TempDir::new().unwrap();
        let content = Content::new(tmp.path().to_path_buf());
        let bytes: &[u8] = b"PNG-bytes";
        let rel = content
            .write_attachment(
                "areas/one-on-ones/peers/aaron/sessions/2026-04-25.md",
                "screenshot.png",
                bytes,
            )
            .unwrap();
        assert!(rel.starts_with("attachments/"));
        assert!(rel.ends_with("screenshot.png"));
        let abs = tmp.path().join(&rel);
        assert!(abs.is_file());
        let read = fs::read(&abs).unwrap();
        assert_eq!(read, bytes);
    }

    #[test]
    fn write_attachment_disambiguates_collisions_with_dash_n() {
        let tmp = TempDir::new().unwrap();
        let content = Content::new(tmp.path().to_path_buf());
        let rel1 = content
            .write_attachment("projects/alpha/README.md", "img.png", b"v1")
            .unwrap();
        let rel2 = content
            .write_attachment("projects/alpha/README.md", "img.png", b"v2")
            .unwrap();
        assert_ne!(rel1, rel2);
        assert!(rel1.ends_with("img.png"));
        // Second write should land on img-1.png next to the first.
        assert!(rel2.ends_with("img-1.png"));
        assert_eq!(fs::read(tmp.path().join(&rel1)).unwrap(), b"v1");
        assert_eq!(fs::read(tmp.path().join(&rel2)).unwrap(), b"v2");
    }

    #[test]
    fn write_attachment_rejects_empty_after_sanitization() {
        let tmp = TempDir::new().unwrap();
        let content = Content::new(tmp.path().to_path_buf());
        // "..." sanitizes to "" → InvalidInput.
        let r = content.write_attachment(
            "projects/alpha/README.md",
            "...",
            b"x",
        );
        assert!(r.is_err());
    }

    #[test]
    fn save_markdown_writes_file_and_records_audit() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blob_dir = tmp.path().join(".blobs");
        let blobs = crate::snapshots::BlobStore::open(&blob_dir).unwrap();
        let mut db = open_mem_db();

        let rel =
            "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md";
        let result = c
            .save_markdown(rel, "# updated\ncontent", &mut db, &blobs, "local")
            .unwrap();

        assert!(!result.skipped);
        assert_eq!(result.bytes, "# updated\ncontent".len() as u64);
        assert!(!result.git_tracked);

        // File updated on disk.
        let got = fs::read_to_string(tmp.path().join(rel)).unwrap();
        assert_eq!(got, "# updated\ncontent");

        // Audit row exists.
        let rows = crate::audit::recent(&db, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "doc.write");
        assert_eq!(rows[0].target_id, rel);

        // Chain verifies.
        assert_eq!(crate::audit::verify_chain(&db).unwrap(), None);

        // snapshot_refs row exists (git_tracked=false ⇒ blobs captured).
        let refs_count: i64 = db
            .query_row("SELECT COUNT(*) FROM snapshot_refs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(refs_count, 1);

        // Blobs were stored on disk (before + after).
        let mut blob_count = 0;
        for entry in fs::read_dir(&blob_dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                for inner in fs::read_dir(entry.path()).unwrap() {
                    let inner = inner.unwrap();
                    if inner.file_type().unwrap().is_file() {
                        blob_count += 1;
                    }
                }
            }
        }
        assert_eq!(blob_count, 2, "expected before+after blobs on disk");
    }

    #[test]
    fn create_session_writes_template_and_audit() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        let rel = c
            .create_session(
                "areas/one-on-ones/direct-reports/direct-report-a",
                "2026-05-01",
                "Direct Report A",
                &mut db,
                &blobs,
                "local",
            )
            .unwrap();
        assert_eq!(
            rel,
            "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-05-01.md",
        );
        let body = fs::read_to_string(tmp.path().join(&rel)).unwrap();
        assert!(body.contains("# Direct Report A — 2026-05-01"));
        assert!(body.contains("## Shared Agenda"));
        assert!(body.contains("## Notes"));
        assert!(body.contains("## Action Items"));

        // Audit row written.
        let rows = crate::audit::recent(&db, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "doc.write");
    }

    #[test]
    fn create_session_rejects_existing_file() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        // The seed already has 2026-04-20.md for direct-report-a.
        let err = c
            .create_session(
                "areas/one-on-ones/direct-reports/direct-report-a",
                "2026-04-20",
                "Direct Report A",
                &mut db,
                &blobs,
                "local",
            )
            .unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("already exists"), "got {msg}");
    }

    #[test]
    fn create_session_rejects_bad_date_format() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        for bad in ["2026-4-1", "tomorrow", "2026/04/01", "2026-04-XX", ""] {
            let err = c
                .create_session(
                    "areas/one-on-ones/direct-reports/direct-report-a",
                    bad,
                    "Direct Report A",
                    &mut db,
                    &blobs,
                    "local",
                )
                .unwrap_err();
            let msg = format!("{err}");
            assert!(
                msg.contains("YYYY-MM-DD"),
                "expected format error for {bad:?}, got {msg}",
            );
        }
    }

    #[test]
    fn save_markdown_captures_blobs_even_inside_git_tree() {
        // Inverse of the original behavior. The "skip blobs in git
        // tree" branch made restore unusable in the user's actual
        // workspace (which is one big git repo). Verify the fix:
        // git_tracked is still recorded on the audit row for
        // diagnostic purposes, but blobs ARE captured.
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".git")).unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blob_dir = tmp.path().join(".blobs");
        let blobs = crate::snapshots::BlobStore::open(&blob_dir).unwrap();
        let mut db = open_mem_db();

        let rel =
            "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md";
        let result = c
            .save_markdown(rel, "# updated\ncontent", &mut db, &blobs, "local")
            .unwrap();

        assert!(result.git_tracked);
        assert!(!result.skipped);

        let got = fs::read_to_string(tmp.path().join(rel)).unwrap();
        assert_eq!(got, "# updated\ncontent");
        assert_eq!(crate::audit::recent(&db, 10).unwrap().len(), 1);

        // Both before + after blobs are on disk.
        let mut blob_count = 0;
        for entry in fs::read_dir(&blob_dir).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                for inner in fs::read_dir(entry.path()).unwrap() {
                    if inner.unwrap().file_type().unwrap().is_file() {
                        blob_count += 1;
                    }
                }
            }
        }
        assert_eq!(
            blob_count, 2,
            "blob store should capture before+after even in git-tracked workspace",
        );
    }

    #[test]
    fn save_markdown_skips_when_content_unchanged() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        let rel =
            "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md";
        let original = fs::read_to_string(tmp.path().join(rel)).unwrap();
        let result = c
            .save_markdown(rel, &original, &mut db, &blobs, "local")
            .unwrap();

        assert!(result.skipped);
        assert_eq!(result.audit_id, 0);

        // No audit churn.
        let rows = crate::audit::recent(&db, 10).unwrap();
        assert_eq!(rows.len(), 0);
    }

    #[test]
    fn save_markdown_rejects_path_escape() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        let err = c
            .save_markdown("../outside.md", "pwn", &mut db, &blobs, "local")
            .unwrap_err();
        assert!(format!("{err}").contains("plain components"));
    }

    #[test]
    fn audit_chain_detects_tamper() {
        let tmp = TempDir::new().unwrap();
        seed_content(tmp.path());
        let c = Content::new(tmp.path().to_path_buf());
        let blobs =
            crate::snapshots::BlobStore::open(&tmp.path().join(".blobs")).unwrap();
        let mut db = open_mem_db();

        let rel =
            "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md";
        c.save_markdown(rel, "one", &mut db, &blobs, "local").unwrap();
        c.save_markdown(rel, "two", &mut db, &blobs, "local").unwrap();
        c.save_markdown(rel, "three", &mut db, &blobs, "local").unwrap();

        assert_eq!(crate::audit::verify_chain(&db).unwrap(), None);

        // Tamper: rewrite a middle row's detail_json, leaving its hash intact.
        // Triggers forbid UPDATE normally; drop the trigger for the test.
        db.execute_batch("DROP TRIGGER audit_no_update").unwrap();
        db.execute(
            "UPDATE audit SET detail_json = '{\"pwn\": true}' WHERE id = 2",
            [],
        )
        .unwrap();

        let broken = crate::audit::verify_chain(&db).unwrap();
        assert_eq!(broken, Some(2));
    }

    #[test]
    fn root_choice_round_trips() {
        let data_dir = TempDir::new().unwrap();
        let chosen = TempDir::new().unwrap();
        // Initially empty.
        assert!(read_root_choice(data_dir.path()).is_none());
        write_root_choice(data_dir.path(), chosen.path()).unwrap();
        // The on-disk choice resolves back.
        let read = read_root_choice(data_dir.path()).unwrap();
        assert_eq!(
            fs::canonicalize(&read).unwrap(),
            fs::canonicalize(chosen.path()).unwrap(),
        );
    }

    #[test]
    fn read_root_choice_returns_none_when_target_missing() {
        let data_dir = TempDir::new().unwrap();
        // Write a choice pointing at a path that doesn't exist.
        let payload = "{\"root\":\"/does/not/exist\"}";
        fs::write(data_dir.path().join(ROOT_CHOICE_FILE), payload).unwrap();
        // The reader filters this out so the resolver falls through
        // to the default rather than returning a stale path.
        assert!(read_root_choice(data_dir.path()).is_none());
    }

    #[test]
    fn read_root_choice_returns_none_when_file_corrupt() {
        let data_dir = TempDir::new().unwrap();
        fs::write(data_dir.path().join(ROOT_CHOICE_FILE), "{not json").unwrap();
        assert!(read_root_choice(data_dir.path()).is_none());
    }

    #[test]
    fn resolve_root_with_data_dir_honors_persisted_choice() {
        let data_dir = TempDir::new().unwrap();
        let chosen = TempDir::new().unwrap();
        write_root_choice(data_dir.path(), chosen.path()).unwrap();
        // Run from a cwd that has no data/files/ to be sure the
        // persisted choice wins over the cwd-walk fallback.
        let pwd_guard = TempDir::new().unwrap();
        let prev_cwd = std::env::current_dir().unwrap();
        std::env::set_current_dir(pwd_guard.path()).unwrap();
        // Make sure the env override is off.
        let prev_env = std::env::var("COS_CONTENT_ROOT").ok();
        std::env::remove_var("COS_CONTENT_ROOT");

        let resolved = resolve_root_with_data_dir(data_dir.path());

        // Restore env + cwd before asserting so a panic doesn't leak.
        if let Some(v) = prev_env {
            std::env::set_var("COS_CONTENT_ROOT", v);
        }
        std::env::set_current_dir(prev_cwd).unwrap();

        assert_eq!(
            fs::canonicalize(resolved).unwrap(),
            fs::canonicalize(chosen.path()).unwrap(),
        );
    }

    #[test]
    fn resolve_root_with_data_dir_env_overrides_choice() {
        let data_dir = TempDir::new().unwrap();
        let chosen = TempDir::new().unwrap();
        let override_dir = TempDir::new().unwrap();
        write_root_choice(data_dir.path(), chosen.path()).unwrap();
        let prev_env = std::env::var("COS_CONTENT_ROOT").ok();
        std::env::set_var(
            "COS_CONTENT_ROOT",
            override_dir.path().to_string_lossy().to_string(),
        );

        let resolved = resolve_root_with_data_dir(data_dir.path());

        if let Some(v) = prev_env {
            std::env::set_var("COS_CONTENT_ROOT", v);
        } else {
            std::env::remove_var("COS_CONTENT_ROOT");
        }
        assert_eq!(resolved, override_dir.path());
    }

    #[test]
    fn default_content_root_lands_in_documents() {
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", "/var/empty");
        let p = default_content_root();
        if let Some(v) = prev {
            std::env::set_var("HOME", v);
        }
        assert_eq!(
            p,
            PathBuf::from("/var/empty/Documents/Chief of Staff/data/files"),
        );
    }

    fn build_fake_starter(at: &Path) {
        // Mirrors the real starter-data/ layout: areas/.../README.md,
        // projects/INDEX.md, style-guide.md, .claude/commands/*.md.
        fs::create_dir_all(at.join("areas/one-on-ones")).unwrap();
        fs::write(
            at.join("areas/one-on-ones/README.md"),
            "# 1:1s template",
        )
        .unwrap();
        fs::create_dir_all(at.join("projects")).unwrap();
        fs::write(at.join("projects/INDEX.md"), "# Projects").unwrap();
        fs::write(at.join("style-guide.md"), "# Style").unwrap();
        fs::create_dir_all(at.join(".claude/commands")).unwrap();
        fs::write(
            at.join(".claude/commands/morning-briefing.md"),
            "---\ndescription: brief\n---\n",
        )
        .unwrap();
    }

    #[test]
    fn seed_starter_content_populates_empty_root() {
        let data_root_parent = TempDir::new().unwrap();
        let content_root = data_root_parent.path().join("data").join("files");
        let bundle = TempDir::new().unwrap();
        build_fake_starter(bundle.path());

        let did_seed = seed_starter_content(bundle.path(), &content_root).unwrap();
        assert!(did_seed);

        // Content tree got copied.
        assert!(content_root.join("areas/one-on-ones/README.md").is_file());
        assert!(content_root.join("projects/INDEX.md").is_file());
        assert!(content_root.join("style-guide.md").is_file());
        // Skills land at the *parent* of content_root (matches
        // the dev-workflow repo layout).
        assert!(content_root
            .parent()
            .unwrap()
            .join(".claude/commands/morning-briefing.md")
            .is_file());
    }

    #[test]
    fn seed_starter_content_is_idempotent_when_areas_exists() {
        let data_root_parent = TempDir::new().unwrap();
        let content_root = data_root_parent.path().join("data").join("files");
        let bundle = TempDir::new().unwrap();
        build_fake_starter(bundle.path());

        // Seed once.
        seed_starter_content(bundle.path(), &content_root).unwrap();
        // User edits the seeded README.
        let user_edited = "# Custom note from user";
        fs::write(
            content_root.join("areas/one-on-ones/README.md"),
            user_edited,
        )
        .unwrap();
        // Re-seed should be a no-op.
        let did_seed = seed_starter_content(bundle.path(), &content_root).unwrap();
        assert!(!did_seed);
        let after = fs::read_to_string(
            content_root.join("areas/one-on-ones/README.md"),
        )
        .unwrap();
        assert_eq!(after, user_edited);
    }

    #[test]
    fn seed_starter_content_returns_false_when_bundle_missing() {
        let data_root_parent = TempDir::new().unwrap();
        let content_root = data_root_parent.path().join("data").join("files");
        let nonexistent_bundle = data_root_parent.path().join("no-such-bundle");
        let did_seed = seed_starter_content(&nonexistent_bundle, &content_root).unwrap();
        assert!(!did_seed);
        // No tree got created.
        assert!(!content_root.join("areas").exists());
    }

    #[test]
    fn seed_starter_content_skip_existing_preserves_user_overrides() {
        // Edge case where the user has a partially-populated content
        // root (e.g., they pre-created `style-guide.md` with their
        // own content) and the seed runs because `areas/` is still
        // missing. Their existing files must not be clobbered.
        let data_root_parent = TempDir::new().unwrap();
        let content_root = data_root_parent.path().join("data").join("files");
        fs::create_dir_all(&content_root).unwrap();
        let user_style = "# My style";
        fs::write(content_root.join("style-guide.md"), user_style).unwrap();

        let bundle = TempDir::new().unwrap();
        build_fake_starter(bundle.path());

        seed_starter_content(bundle.path(), &content_root).unwrap();

        // areas/ was missing, so we seeded — but style-guide.md
        // was already there and the SkipExisting mode preserved it.
        assert!(content_root.join("areas/one-on-ones/README.md").is_file());
        let style = fs::read_to_string(content_root.join("style-guide.md")).unwrap();
        assert_eq!(style, user_style);
    }
}

