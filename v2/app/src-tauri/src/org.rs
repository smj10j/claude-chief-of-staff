//! Org views — the hand-editable / generator-populated hierarchy of
//! people the user works with. Lives on disk at
//! `data/files/areas/org/org.json` so it's git-tracked alongside the
//! one-on-one folders that back it.
//!
//! A single file holds N views. Each view has a `hierarchy` (tree by
//! parent pointer) for reporting chains, plus a `partners` list for
//! flat XFN / advisor entries. The structure is intentionally small —
//! the Settings-editable JSON plus a future generator skill both have
//! to produce it, and a terse schema keeps both manageable.
//!
//! Every node can reference a 1:1 folder via `slug`. On load we enrich
//! each node with whether that folder actually exists so the UI can
//! render clickable vs grayed-out people without a second round-trip.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::claude::{self, ClaudeCliConfig};
use crate::content::{self, PersonRef};
use crate::error::{AppError, AppResult};

pub fn org_file(content_root: &Path) -> PathBuf {
    content_root.join("areas").join("org").join("org.json")
}

/// On-disk shape. `#[serde(default)]` on every list so a minimal edit
/// (like one view with no partners) still round-trips cleanly.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct OrgFile {
    #[serde(default)]
    pub views: Vec<OrgView>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrgView {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub hierarchy: Vec<OrgNode>,
    #[serde(default)]
    pub partners: Vec<OrgNode>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OrgNode {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Matches `<relationship>/<slug>/` under `data/files/areas/one-on-ones/`.
    /// Empty string or missing means "no 1:1 folder expected"; we still show
    /// the person, just grayed out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    /// Parent node id within the same view's hierarchy. None = root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_self: bool,
    /// Curated out of the visible org view: the node stays in the file (so the
    /// person still counts as "in the org" — no orphan-panel entry — and their
    /// 1:1 folder is untouched) but the UI renders it nowhere. Persisted, not
    /// computed: it survives save (`strip_computed` leaves it alone).
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,

    // --- Computed on load, stripped before save ---
    // Each is deserialized-optional (default if absent) and
    // serialized-if-set. The save path resets these to defaults so
    // they never land in the git-tracked JSON, while IPC responses
    // still carry them to the UI.
    /// True when a 1:1 folder matching `slug` exists under
    /// `areas/one-on-ones/**`. Drives the UI's clickable-vs-grayed state.
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_folder: bool,
    /// Relationship bucket ("direct-reports", "peers", …) when the folder
    /// exists. Useful for the UI to route to the right profile view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relationship: Option<String>,
    /// Path relative to the content root when the folder exists. Empty
    /// otherwise. UI uses this to open the latest session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel_path: Option<String>,
    /// Most recent session date (YYYY-MM-DD) when folder + sessions exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session: Option<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Read the org file + enrich each node with 1:1-folder info. Missing
/// file returns an empty OrgFile rather than an error — a fresh install
/// has no org views until the user edits the file or runs the generator.
pub fn load(content_root: &Path) -> AppResult<OrgFile> {
    let path = org_file(content_root);
    let mut file = if path.is_file() {
        let text = fs::read_to_string(&path)?;
        let parsed: OrgFile = serde_json::from_str(&text).map_err(|e| {
            AppError::InvalidState(format!("org.json parse: {e}"))
        })?;
        parsed
    } else {
        OrgFile::default()
    };

    // Enrich against the real 1:1 folder tree. Build a slug lookup so we
    // don't re-walk the tree per node.
    let content = content::Content::new(content_root.to_path_buf());
    let people = content.list_people().unwrap_or_default();
    let by_slug: HashMap<String, &PersonRef> =
        people.iter().map(|p| (p.slug.clone(), p)).collect();

    for view in file.views.iter_mut() {
        enrich(&mut view.hierarchy, &by_slug);
        enrich(&mut view.partners, &by_slug);
    }
    Ok(file)
}

fn enrich(nodes: &mut [OrgNode], by_slug: &HashMap<String, &PersonRef>) {
    for n in nodes {
        let slug = match &n.slug {
            Some(s) if !s.is_empty() => s.clone(),
            _ => continue,
        };
        if let Some(p) = by_slug.get(&slug) {
            n.has_folder = true;
            n.relationship = Some(p.relationship.clone());
            n.rel_path = Some(p.rel_path.clone());
            n.last_session = p.last_session.clone();
        }
    }
}

/// Replace the on-disk file. Used by the Settings editor + generator.
/// Strips computed fields (`has_folder`, `relationship`, …) so the
/// git-tracked JSON stays minimal — they'll be recomputed on next load.
pub fn save(content_root: &Path, file: &OrgFile) -> AppResult<()> {
    let path = org_file(content_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut clean = file.clone();
    for view in clean.views.iter_mut() {
        strip_computed(&mut view.hierarchy);
        strip_computed(&mut view.partners);
    }
    fs::write(&path, serde_json::to_string_pretty(&clean)?)?;
    Ok(())
}

fn strip_computed(nodes: &mut [OrgNode]) {
    for n in nodes {
        n.has_folder = false;
        n.relationship = None;
        n.rel_path = None;
        n.last_session = None;
    }
}

/// Drive the `/org-generate` slash command. The command itself owns the
/// research + write logic (see `.claude/commands/org-generate.md`):
/// it reads the existing `org.json` and `person.json` files, queries
/// MCPs, and writes the updated files directly. v2 just kicks off the
/// subprocess and reloads from disk.
///
/// Skills are slash commands by principle (BUILD-PLAN §3) — both the v2
/// UI's "Regenerate" button and a direct `/org-generate` invocation in
/// the maintainer's REPL land at the same outcome.
pub fn generate(content_root: &Path, cfg: &ClaudeCliConfig) -> AppResult<OrgFile> {
    let repo_root = content_root.parent().map(|p| p.to_path_buf());
    // Skill writes the files; we don't need its stdout summary other than
    // for diagnostic logging on failure. Discard the OK case.
    let _summary = claude::run_skill(cfg, repo_root.as_deref(), "org-generate", "")?;
    // Reload from disk so the UI sees exactly what landed (computed
    // fields re-derived against the current 1:1 folder tree).
    load(content_root)
}


#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn seed_people(dir: &Path) {
        let oo = dir.join("areas").join("one-on-ones");
        let report_a = oo.join("direct-reports").join("direct-report-a");
        fs::create_dir_all(report_a.join("sessions")).unwrap();
        fs::write(report_a.join("README.md"), "# Direct Report A").unwrap();
        fs::write(report_a.join("sessions").join("2026-04-20.md"), "s").unwrap();
        let manager = oo.join("manager").join("manager");
        fs::create_dir_all(&manager).unwrap();
        fs::write(manager.join("README.md"), "# Manager").unwrap();
    }

    fn sample_org() -> OrgFile {
        OrgFile {
            views: vec![OrgView {
                id: "primary".into(),
                label: "Primary".into(),
                description: "My org".into(),
                hierarchy: vec![
                    OrgNode {
                        id: "manager".into(),
                        label: "Manager".into(),
                        title: Some("Director".into()),
                        slug: Some("manager".into()),
                        parent: None,
                        is_self: false,
                        ..Default::default()
                    },
                    OrgNode {
                        id: "user".into(),
                        label: "User".into(),
                        title: Some("SEM".into()),
                        slug: None,
                        parent: Some("manager".into()),
                        is_self: true,
                        ..Default::default()
                    },
                    OrgNode {
                        id: "direct-report-a".into(),
                        label: "Direct Report A".into(),
                        title: Some("Manager".into()),
                        slug: Some("direct-report-a".into()),
                        parent: Some("user".into()),
                        is_self: false,
                        ..Default::default()
                    },
                    OrgNode {
                        id: "mystery".into(),
                        label: "Mystery".into(),
                        title: Some("IC".into()),
                        slug: Some("mystery".into()),
                        parent: Some("direct-report-a".into()),
                        is_self: false,
                        ..Default::default()
                    },
                ],
                partners: vec![OrgNode {
                    id: "peer-a".into(),
                    label: "Peer A".into(),
                    title: Some("Head of Product".into()),
                    slug: None,
                    parent: None,
                    is_self: false,
                    ..Default::default()
                }],
            }],
        }
    }

    impl Default for OrgNode {
        fn default() -> Self {
            Self {
                id: String::new(),
                label: String::new(),
                title: None,
                slug: None,
                parent: None,
                is_self: false,
                hidden: false,
                has_folder: false,
                relationship: None,
                rel_path: None,
                last_session: None,
            }
        }
    }

    #[test]
    fn load_returns_empty_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let got = load(tmp.path()).unwrap();
        assert!(got.views.is_empty());
    }

    #[test]
    fn save_and_load_round_trips_and_strips_computed_fields() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        save(tmp.path(), &sample_org()).unwrap();

        let raw = fs::read_to_string(org_file(tmp.path())).unwrap();
        // Computed fields must not appear in the on-disk JSON.
        assert!(!raw.contains("has_folder"));
        assert!(!raw.contains("relationship"));
        assert!(!raw.contains("rel_path"));
        // is_self=false elided, is_self=true kept.
        assert!(raw.contains("\"is_self\": true"));
        // Manager and direct-report-a keep their slugs.
        assert!(raw.contains("\"slug\": \"manager\""));
    }

    #[test]
    fn hidden_flag_persists_through_save() {
        // `hidden` is user-curated state, not a computed field — it must
        // survive the save round-trip (unlike has_folder/rel_path).
        let tmp = TempDir::new().unwrap();
        let file = OrgFile {
            views: vec![OrgView {
                id: "primary".into(),
                label: "Primary".into(),
                description: String::new(),
                hierarchy: vec![
                    OrgNode { id: "a".into(), label: "A".into(), slug: Some("a".into()), hidden: true, ..Default::default() },
                    OrgNode { id: "b".into(), label: "B".into(), slug: Some("b".into()), ..Default::default() },
                ],
                partners: vec![],
            }],
        };
        save(tmp.path(), &file).unwrap();
        let raw = fs::read_to_string(org_file(tmp.path())).unwrap();
        assert!(raw.contains("\"hidden\": true"), "hidden:true must persist");
        assert_eq!(raw.matches("\"hidden\"").count(), 1, "hidden:false must be elided");

        let got = load(tmp.path()).unwrap();
        let h = &got.views[0].hierarchy;
        assert!(h.iter().find(|n| n.id == "a").unwrap().hidden);
        assert!(!h.iter().find(|n| n.id == "b").unwrap().hidden);
    }

    #[test]
    fn load_enriches_nodes_with_folder_match() {
        let tmp = TempDir::new().unwrap();
        seed_people(tmp.path());
        save(tmp.path(), &sample_org()).unwrap();

        let got = load(tmp.path()).unwrap();
        let view = &got.views[0];
        let by_id: HashMap<&str, &OrgNode> =
            view.hierarchy.iter().map(|n| (n.id.as_str(), n)).collect();

        // direct-report-a has a folder → enriched.
        let report_a = by_id["direct-report-a"];
        assert!(report_a.has_folder);
        assert_eq!(report_a.relationship.as_deref(), Some("direct-reports"));
        assert_eq!(report_a.last_session.as_deref(), Some("2026-04-20"));

        // Manager folder exists but has no sessions yet → has_folder true,
        // last_session None.
        let manager = by_id["manager"];
        assert!(manager.has_folder);
        assert!(manager.last_session.is_none());

        // User has no slug → not enriched, rendered as self.
        let user = by_id["user"];
        assert!(!user.has_folder);
        assert!(user.is_self);

        // Mystery references a slug that doesn't exist on disk → gray out.
        let mystery = by_id["mystery"];
        assert!(!mystery.has_folder);
    }

    #[test]
    fn load_errors_on_invalid_json() {
        let tmp = TempDir::new().unwrap();
        let path = org_file(tmp.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not valid").unwrap();
        let err = load(tmp.path()).unwrap_err();
        assert!(matches!(err, AppError::InvalidState(_)));
    }
}
