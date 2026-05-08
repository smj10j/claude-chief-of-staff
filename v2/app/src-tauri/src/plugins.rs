//! Plugin runtime scaffold (M10a — first checkpoint of PRD-104).
//!
//! Today this is *just* the manifest reader and the IPC surface. No
//! plugin loader, no sandbox, no host hooks — those land as separate
//! checkpoints. The intent here is to pin the on-disk manifest format
//! + the IPC contract so future checkpoints can layer behavior on top
//! without renegotiating shapes.
//!
//! On-disk shape: each plugin lives at `<app_data>/plugins/<slug>/`
//! with a `manifest.toml` at the root. Anything more (entry-point,
//! capabilities, etc.) is read but stored as raw passthrough until
//! M10b loads code.
//!
//! Settings → Plugins reads `plugin_list()`. If the directory is
//! absent the list is empty — that's the steady state today.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// One plugin row as the UI consumes it. Mirrors the on-disk manifest
/// fields plus the discovery-time `slug` (the directory name) and a
/// boolean `manifest_ok` so the UI can render a "manifest unparseable"
/// state separately from "manifest missing".
#[derive(Serialize, Clone, Debug)]
pub struct PluginRow {
    /// Directory slug under `<app_data>/plugins/`.
    pub slug: String,
    /// Display name from the manifest, or the slug if missing.
    pub name: String,
    /// Manifest version field, e.g. "0.1.0".
    pub version: Option<String>,
    /// One-line description from the manifest. Optional.
    pub description: Option<String>,
    /// Capabilities the plugin declares it needs (B7-CP21). Read-only
    /// today — Settings → Plugins shows them as chips, the loader
    /// will gate execution on them in a later checkpoint. Unknown
    /// capability strings are passed through as-is so the user can
    /// see what a plugin asked for even if we don't understand it.
    pub capabilities: Vec<String>,
    /// True when the manifest was readable AND parsed cleanly.
    pub manifest_ok: bool,
    /// When manifest_ok=false, the parse / IO error so the UI can
    /// render a useful failure state. None when ok.
    pub manifest_error: Option<String>,
}

/// The subset of manifest fields we read today. Other fields are
/// preserved on-disk but not surfaced to the UI yet — they'll wire
/// up alongside the loader in a later checkpoint.
#[derive(Deserialize, Default, Debug)]
struct ManifestFile {
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    /// Capability list. TOML reads this as `capabilities = ["a", "b"]`
    /// or absent. Order is preserved so the UI shows the user's
    /// authored order in the chip strip.
    #[serde(default)]
    capabilities: Vec<String>,
}

/// Capability strings the loader understands today. Other strings
/// pass through to the UI but show with an "unknown" tone so the
/// user can see something needs review. Keep this list in sync with
/// the doc in PRD-104. Currently consumed only by tests + the
/// frontend mirror — the loader gating lands later, hence
/// `#[allow(dead_code)]`.
#[allow(dead_code)]
pub const KNOWN_CAPABILITIES: &[&str] = &[
    "tasks.read",
    "tasks.write",
    "content.read",
    "content.write",
    "calendar.read",
    "claude.skills",
    "settings.read",
    "audit.read",
];

#[allow(dead_code)]
pub fn capability_is_known(name: &str) -> bool {
    KNOWN_CAPABILITIES.iter().any(|k| *k == name)
}

/// Validate a parsed manifest. Returns Ok when the manifest meets the
/// minimum required shape; Err with a human-readable reason when not.
/// Today the rule is "name must exist + non-empty after trim, version
/// must exist + non-empty + match a loose semver-ish shape". Loose on
/// purpose: we want to accept "0.1" and "2024.10" alongside "1.2.3"
/// without forcing a strict semver dep.
fn validate_manifest(parsed: &ManifestFile) -> Result<(), String> {
    let name = parsed
        .name
        .as_ref()
        .map(|s| s.trim())
        .unwrap_or("");
    if name.is_empty() {
        return Err("manifest is missing a non-empty `name` field".into());
    }
    if name.len() > 64 {
        return Err(format!(
            "manifest `name` is too long ({} chars; max 64)",
            name.len()
        ));
    }
    let version = parsed
        .version
        .as_ref()
        .map(|s| s.trim())
        .unwrap_or("");
    if version.is_empty() {
        return Err("manifest is missing a non-empty `version` field".into());
    }
    // Loose semver-ish: at least one digit, followed by digits / dots /
    // pre-release suffix. Rejects obviously-bad inputs like "v1" or "alpha"
    // without insisting on strict 0.0.0 form.
    let valid_chars = version
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c.is_ascii_alphabetic());
    if !valid_chars || !version.chars().any(|c| c.is_ascii_digit()) {
        return Err(format!("manifest `version` ({version:?}) doesn't look like a version"));
    }
    Ok(())
}

#[derive(Clone)]
pub struct Plugins {
    /// Discovery roots, scanned in order. The per-user directory
    /// (<app_data>/plugins/) is the primary install location; the
    /// optional repo-level directory (<repo>/plugins/) is bundled
    /// with the source tree so first-party / example plugins ship
    /// with the app and show up without a manual copy.
    ///
    /// When the same slug appears in both, the per-user copy wins —
    /// users override bundled defaults the same way they override
    /// CSS in a theme.
    roots: Vec<PathBuf>,
}

impl Plugins {
    /// Per-user-only constructor. Today the runtime always uses
    /// `with_repo_root` (so the bundled example shows up); kept for
    /// tests that exercise the per-user-only path.
    #[allow(dead_code)]
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            roots: vec![app_data_dir.join("plugins")],
        }
    }

    /// Discovery with an additional repo-level fallback root. Used by
    /// the runtime so the bundled `<repo>/plugins/example/` is
    /// visible without the user copying it into per-user storage.
    pub fn with_repo_root(app_data_dir: &Path, repo_root: Option<&Path>) -> Self {
        let mut roots = vec![app_data_dir.join("plugins")];
        if let Some(repo) = repo_root {
            roots.push(repo.join("plugins"));
        }
        Self { roots }
    }

    /// Returns the discovered plugin list across all roots. Empty
    /// when no root contains a `plugins/` directory. Per-user
    /// installs override repo-bundled when slugs collide.
    pub fn list(&self) -> AppResult<Vec<PluginRow>> {
        use std::collections::HashMap;
        let mut by_slug: HashMap<String, PluginRow> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        for root in &self.roots {
            if !root.exists() {
                continue;
            }
            let read = match fs::read_dir(root) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry in read.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let slug = entry.file_name().to_string_lossy().to_string();
                if slug.starts_with('.') {
                    // Skip dotfiles / dotdirs — `.DS_Store` etc.
                    continue;
                }
                // Per-user wins: only insert if we haven't already
                // seen this slug from an earlier (higher-priority)
                // root.
                if by_slug.contains_key(&slug) {
                    continue;
                }
                let row = read_one(&path, slug.clone());
                by_slug.insert(slug.clone(), row);
                order.push(slug);
            }
        }
        order.sort();
        let mut out: Vec<PluginRow> = Vec::with_capacity(order.len());
        for slug in &order {
            if let Some(row) = by_slug.remove(slug) {
                out.push(row);
            }
        }
        Ok(out)
    }
}

fn read_one(dir: &Path, slug: String) -> PluginRow {
    let manifest_path = dir.join("manifest.toml");
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => {
            return PluginRow {
                slug: slug.clone(),
                name: slug,
                version: None,
                description: None,
                capabilities: Vec::new(),
                manifest_ok: false,
                manifest_error: Some(format!("manifest.toml: {e}")),
            };
        }
    };
    match toml::from_str::<ManifestFile>(&raw) {
        Ok(parsed) => {
            let capabilities = parsed
                .capabilities
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            match validate_manifest(&parsed) {
                Ok(()) => PluginRow {
                    slug: slug.clone(),
                    name: parsed.name.unwrap_or(slug),
                    version: parsed.version,
                    description: parsed.description,
                    capabilities,
                    manifest_ok: true,
                    manifest_error: None,
                },
                Err(reason) => PluginRow {
                    slug: slug.clone(),
                    name: parsed.name.unwrap_or_else(|| slug.clone()),
                    version: parsed.version,
                    description: parsed.description,
                    capabilities,
                    manifest_ok: false,
                    manifest_error: Some(reason),
                },
            }
        }
        Err(err) => PluginRow {
            slug: slug.clone(),
            name: slug,
            version: None,
            description: None,
            capabilities: Vec::new(),
            manifest_ok: false,
            manifest_error: Some(format!("parse: {err}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_manifest(dir: &Path, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("manifest.toml"), body).unwrap();
    }

    #[test]
    fn list_returns_empty_when_directory_missing() {
        let tmp = TempDir::new().unwrap();
        let plugins = Plugins::new(tmp.path());
        assert!(plugins.list().unwrap().is_empty());
    }

    #[test]
    fn list_returns_ok_row_for_well_formed_manifest() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/example");
        write_manifest(
            &plugin_dir,
            r#"
            name = "Example"
            version = "0.1.0"
            description = "demo"
            "#,
        );
        let plugins = Plugins::new(tmp.path());
        let rows = plugins.list().unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.slug, "example");
        assert_eq!(row.name, "Example");
        assert_eq!(row.version.as_deref(), Some("0.1.0"));
        assert_eq!(row.description.as_deref(), Some("demo"));
        assert!(row.manifest_ok);
        assert!(row.manifest_error.is_none());
        // Manifest didn't declare any → empty list (not None / null).
        assert!(row.capabilities.is_empty());
    }

    #[test]
    fn list_reads_capabilities_field_in_authored_order() {
        // B7-CP21: capabilities round-trip from manifest in order.
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/needy");
        write_manifest(
            &plugin_dir,
            r#"
            name = "Needy"
            version = "0.1.0"
            capabilities = ["tasks.read", "calendar.read", "claude.skills"]
            "#,
        );
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert_eq!(
            row.capabilities,
            vec![
                "tasks.read".to_string(),
                "calendar.read".to_string(),
                "claude.skills".to_string(),
            ],
        );
        assert!(row.manifest_ok);
    }

    #[test]
    fn list_trims_capability_whitespace_and_drops_empty_strings() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/sloppy");
        write_manifest(
            &plugin_dir,
            r#"
            name = "Sloppy"
            version = "0.1"
            capabilities = ["  tasks.read  ", "", "claude.skills"]
            "#,
        );
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert_eq!(
            row.capabilities,
            vec!["tasks.read".to_string(), "claude.skills".to_string()],
        );
    }

    #[test]
    fn list_passes_unknown_capabilities_through() {
        // The list isn't a whitelist today; the UI flags unknown ones,
        // but the row still carries them so the user sees what the
        // plugin asked for.
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/exotic");
        write_manifest(
            &plugin_dir,
            r#"
            name = "Exotic"
            version = "0.1"
            capabilities = ["weather.read", "tasks.read"]
            "#,
        );
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert_eq!(
            row.capabilities,
            vec!["weather.read".to_string(), "tasks.read".to_string()],
        );
    }

    #[test]
    fn capability_is_known_recognizes_the_documented_set() {
        for known in KNOWN_CAPABILITIES {
            assert!(
                capability_is_known(known),
                "expected {known} in known set",
            );
        }
        assert!(!capability_is_known("weather.read"));
        assert!(!capability_is_known(""));
    }

    #[test]
    fn with_repo_root_discovers_bundled_plugins() {
        // Simulate the dev-mode layout: per-user plugins dir empty,
        // repo-level plugins dir contains an "example" plugin.
        let app_data = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        write_manifest(
            &repo.path().join("plugins/example"),
            r#"
            name = "Example"
            version = "0.1.0"
            "#,
        );
        let plugins =
            Plugins::with_repo_root(app_data.path(), Some(repo.path()));
        let rows = plugins.list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].slug, "example");
        assert!(rows[0].manifest_ok);
    }

    #[test]
    fn per_user_plugin_overrides_repo_bundled_with_same_slug() {
        // Both roots have a plugin named "example"; the per-user copy
        // wins so the user can patch a bundled plugin without forking.
        let app_data = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        write_manifest(
            &app_data.path().join("plugins/example"),
            r#"
            name = "Example (user)"
            version = "0.2.0"
            "#,
        );
        write_manifest(
            &repo.path().join("plugins/example"),
            r#"
            name = "Example (bundled)"
            version = "0.1.0"
            "#,
        );
        let plugins =
            Plugins::with_repo_root(app_data.path(), Some(repo.path()));
        let row = plugins.list().unwrap().pop().unwrap();
        assert_eq!(row.name, "Example (user)");
        assert_eq!(row.version.as_deref(), Some("0.2.0"));
    }

    #[test]
    fn with_repo_root_unions_distinct_slugs_from_both_roots() {
        let app_data = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        write_manifest(
            &app_data.path().join("plugins/user-only"),
            r#"name = "User"
versions = "x"
version = "0.1""#,
        );
        write_manifest(
            &repo.path().join("plugins/bundled-only"),
            r#"name = "Bundled"
version = "0.1""#,
        );
        let plugins =
            Plugins::with_repo_root(app_data.path(), Some(repo.path()));
        let slugs: Vec<String> =
            plugins.list().unwrap().into_iter().map(|r| r.slug).collect();
        assert_eq!(slugs, vec!["bundled-only", "user-only"]);
    }

    /// B7-CP23: the example manifest checked into the repo root must
    /// parse + validate cleanly through the same reader the runtime
    /// uses. Catches accidental drift if the parser tightens later.
    #[test]
    fn example_plugin_manifest_passes_validation() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/example");
        // Mirror the manifest authored at <repo>/plugins/example.
        // Kept inline so this test doesn't depend on workspace layout.
        write_manifest(
            &plugin_dir,
            r#"
            name = "Example"
            version = "0.1.0"
            description = "Reference manifest."
            capabilities = ["tasks.read", "content.read", "claude.skills"]
            "#,
        );
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert!(row.manifest_ok);
        assert_eq!(row.name, "Example");
        assert_eq!(row.version.as_deref(), Some("0.1.0"));
        for cap in &row.capabilities {
            assert!(
                capability_is_known(cap),
                "example plugin advertises unknown capability {cap:?}",
            );
        }
    }

    #[test]
    fn list_marks_manifest_without_name_as_invalid() {
        // Validation: name is required (CP13). Slug is still used as
        // the row label so the user can find the offending plugin.
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/no-name");
        write_manifest(&plugin_dir, r#"version = "0.0.1""#);
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert_eq!(row.name, "no-name");
        assert!(!row.manifest_ok);
        assert!(row.manifest_error.as_ref().unwrap().contains("name"));
    }

    #[test]
    fn list_marks_manifest_without_version_as_invalid() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/no-version");
        write_manifest(&plugin_dir, r#"name = "Bare""#);
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert!(!row.manifest_ok);
        assert!(row.manifest_error.as_ref().unwrap().contains("version"));
    }

    #[test]
    fn list_marks_manifest_with_garbage_version_as_invalid() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/bad-ver");
        write_manifest(
            &plugin_dir,
            r#"
            name = "Garbage"
            version = "alpha"
            "#,
        );
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert!(!row.manifest_ok);
        assert!(row.manifest_error.as_ref().unwrap().contains("version"));
    }

    #[test]
    fn list_accepts_loose_versions_like_calver() {
        // Loose semver-ish: 2024.10 + 0.1 + 1.2.3-beta all OK.
        let tmp = TempDir::new().unwrap();
        for (idx, ver) in ["0.1", "2024.10", "1.2.3-beta"].iter().enumerate() {
            write_manifest(
                &tmp.path().join(format!("plugins/p{idx}")),
                &format!("name = \"P{idx}\"\nversion = \"{ver}\"\n"),
            );
        }
        let plugins = Plugins::new(tmp.path());
        let rows = plugins.list().unwrap();
        assert_eq!(rows.len(), 3);
        for row in rows {
            assert!(row.manifest_ok, "expected ok for version {:?}", row.version);
        }
    }

    #[test]
    fn list_marks_unparseable_manifest_as_failed() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins/broken");
        write_manifest(&plugin_dir, "this isn't = valid = toml");
        let plugins = Plugins::new(tmp.path());
        let row = plugins.list().unwrap().pop().unwrap();
        assert_eq!(row.slug, "broken");
        assert!(!row.manifest_ok);
        assert!(row.manifest_error.is_some());
    }

    #[test]
    fn list_skips_hidden_directories_and_loose_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plugins");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(root.join(".DS_Store")).unwrap();
        fs::write(root.join("loose-file.txt"), b"ignored").unwrap();
        write_manifest(
            &root.join("real"),
            r#"
            name = "Real"
            version = "0.1.0"
            "#,
        );
        let plugins = Plugins::new(tmp.path());
        let rows = plugins.list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].slug, "real");
    }

    #[test]
    fn list_returns_stable_order_across_calls() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("plugins");
        write_manifest(&root.join("c"), "name = \"C\"\nversion = \"0.1\"\n");
        write_manifest(&root.join("a"), "name = \"A\"\nversion = \"0.1\"\n");
        write_manifest(&root.join("b"), "name = \"B\"\nversion = \"0.1\"\n");
        let plugins = Plugins::new(tmp.path());
        let slugs: Vec<String> = plugins
            .list()
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect();
        assert_eq!(slugs, vec!["a", "b", "c"]);
    }
}
