//! Per-document annotations. Stored next to each markdown file as a
//! sibling JSON file: `<doc>.annotations.json`. Each annotation is a
//! span-with-comment plus enough surrounding text that the UI can
//! re-anchor it after edits without relying on character offsets.
//!
//! Matches the v1 UI shape so the existing annotation corpus remains
//! readable. Source: `ui/server.js` and `ui/src/annotations*.js`.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// One annotation. `text` is the verbatim selected span; `textBefore`
/// and `textAfter` are short surrounding excerpts the UI uses to
/// reposition the highlight after the document changes. `comment` is
/// the note the user left for Claude.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Annotation {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub comment: String,
    #[serde(rename = "textBefore", default)]
    pub text_before: String,
    #[serde(rename = "textAfter", default)]
    pub text_after: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: String,
    /// Set when the user has run `/process-ui-annotations` and Claude
    /// applied the suggested edit. UI uses this to dim the highlight.
    #[serde(rename = "processedAt", default, skip_serializing_if = "Option::is_none")]
    pub processed_at: Option<String>,
}

/// Resolve `<rel_path>.annotations.json` under `content_root`. Same
/// path-traversal guard as content::resolve.
fn resolve(content_root: &Path, rel_path: &str) -> AppResult<PathBuf> {
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
    let joined = content_root.join(format!("{rel_path}.annotations.json"));
    let parent = joined.parent().ok_or_else(|| {
        AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "rel_path has no parent directory",
        ))
    })?;
    fs::create_dir_all(parent)?;
    let canon_root = fs::canonicalize(content_root)?;
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

pub fn list(content_root: &Path, rel_path: &str) -> AppResult<Vec<Annotation>> {
    let abs = resolve(content_root, rel_path)?;
    if !abs.is_file() {
        return Ok(vec![]);
    }
    let text = fs::read_to_string(&abs)?;
    let parsed: Vec<Annotation> = serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidState(format!("annotations json: {e}")))?;
    Ok(parsed)
}

/// One row in the Annotations dashboard — points at a doc that has at
/// least one un-processed annotation. Surface fields are:
///   - rel_path: the doc itself (without `.annotations.json` suffix)
///   - label: filename stem for the headline
///   - context: 1-2 path segments above the filename for disambiguation
///   - pending_count: number of annotations whose processedAt is unset
///   - latest_comment: most-recent annotation's user comment (truncated)
#[derive(serde::Serialize, Clone, Debug)]
pub struct PendingDoc {
    pub rel_path: String,
    pub label: String,
    pub context: String,
    pub pending_count: usize,
    pub latest_comment: String,
}

/// Walk `content_root` for every `*.md.annotations.json` sidecar and
/// return one PendingDoc per file with at least one un-processed
/// annotation. Skipped: `archive/`, hidden directories, anything whose
/// JSON we can't parse (silently — the user shouldn't be blocked
/// because one sidecar is malformed).
///
/// Sorted by pending_count desc, then rel_path asc for determinism.
pub fn list_pending(content_root: &Path) -> AppResult<Vec<PendingDoc>> {
    if !content_root.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<PendingDoc> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![content_root.to_path_buf()];
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
            if !name.ends_with(".md.annotations.json") {
                continue;
            }
            let body = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let parsed: Vec<Annotation> = match serde_json::from_str(&body) {
                Ok(a) => a,
                Err(_) => continue,
            };
            let pending: Vec<&Annotation> = parsed
                .iter()
                .filter(|a| a.processed_at.is_none())
                .collect();
            if pending.is_empty() {
                continue;
            }
            // Doc rel-path is the sidecar minus `.annotations.json`.
            let doc_abs = path.with_extension("");
            // path.with_extension("") only strips the trailing `.json`,
            // leaving `<doc>.md.annotations` — strip the `.annotations`
            // segment off the file name as well.
            let doc_abs = match doc_abs
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_suffix(".annotations"))
            {
                Some(stem) => {
                    let parent = doc_abs.parent().unwrap_or_else(|| Path::new(""));
                    parent.join(stem)
                }
                None => continue,
            };
            let rel = match doc_abs.strip_prefix(content_root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            let doc_name = doc_abs
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("(unknown)")
                .trim_end_matches(".md")
                .to_string();
            // Latest comment: prefer the highest createdAt, fall back to
            // the last entry in the file.
            let latest = pending
                .iter()
                .max_by(|a, b| a.created_at.cmp(&b.created_at))
                .copied()
                .unwrap_or(pending[pending.len() - 1]);
            let mut comment = latest.comment.replace('\n', " ").trim().to_string();
            if comment.chars().count() > 80 {
                comment = comment.chars().take(77).collect::<String>() + "…";
            }
            out.push(PendingDoc {
                rel_path: rel.clone(),
                label: doc_name,
                context: derive_context(&rel),
                pending_count: pending.len(),
                latest_comment: comment,
            });
        }
    }
    out.sort_by(|a, b| {
        b.pending_count
            .cmp(&a.pending_count)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(out)
}

fn derive_context(rel: &str) -> String {
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.len() < 2 {
        return String::new();
    }
    let mut end = parts.len() - 1;
    if end > 0 && (parts[end - 1] == "sessions" || parts[end - 1] == "archive")
    {
        end -= 1;
    }
    let start = end.saturating_sub(2);
    parts[start..end].join("/")
}

pub fn save(
    content_root: &Path,
    rel_path: &str,
    annotations: &[Annotation],
) -> AppResult<()> {
    let abs = resolve(content_root, rel_path)?;
    if annotations.is_empty() {
        // Empty list → remove the sidecar file rather than leaving an
        // empty `[]` stub. Matches v1 UI's behavior so a directory
        // round-trips clean.
        if abs.is_file() {
            fs::remove_file(&abs)?;
        }
        return Ok(());
    }
    let text = serde_json::to_string_pretty(annotations)?;
    fs::write(&abs, text)?;
    Ok(())
}

/// Remove annotations whose `id` matches any in `ids` from the sidecar.
/// If the sidecar ends up empty (or never existed), it's deleted.
/// Returns the count actually removed — handy for telemetry and for
/// the safety net to log "skill output claimed N processed but only M
/// were still present."
///
/// The /process-ui-annotations skill is *supposed* to clean its own
/// sidecar, but Claude occasionally forgets the last step. This makes
/// `annotations_process` deterministic regardless of whether the
/// cleanup landed in the skill output: we parse the PROCESSED: line
/// the skill emits and call this to scrub the listed IDs.
pub fn remove_by_ids(
    content_root: &Path,
    rel_path: &str,
    ids: &[String],
) -> AppResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let abs = resolve(content_root, rel_path)?;
    if !abs.is_file() {
        return Ok(0);
    }
    let text = fs::read_to_string(&abs)?;
    let parsed: Vec<Annotation> = serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidState(format!("annotations json: {e}")))?;
    let before = parsed.len();
    let kept: Vec<Annotation> = parsed
        .into_iter()
        .filter(|a| !ids.iter().any(|id| id == &a.id))
        .collect();
    let removed = before - kept.len();
    if kept.is_empty() {
        fs::remove_file(&abs)?;
    } else {
        let out = serde_json::to_string_pretty(&kept)?;
        fs::write(&abs, out)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn seed_doc(root: &Path, rel: &str) {
        let abs = root.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(&abs, "# title\n\nbody text").unwrap();
    }

    #[test]
    fn list_returns_empty_when_sidecar_missing() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/x/y.md");
        let got = list(tmp.path(), "areas/x/y.md").unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn save_then_list_round_trips_v1_shape() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/x/y.md");
        let anns = vec![Annotation {
            id: "ca547bdz".into(),
            text: "Tom's return".into(),
            comment: "Confirmed".into(),
            text_before: "yesterday — ".into(),
            text_after: "\nbody text".into(),
            created_at: "2026-04-20T18:23:21.159Z".into(),
            processed_at: None,
        }];
        save(tmp.path(), "areas/x/y.md", &anns).unwrap();
        let got = list(tmp.path(), "areas/x/y.md").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "ca547bdz");
        assert_eq!(got[0].text, "Tom's return");
        assert_eq!(got[0].comment, "Confirmed");
        assert_eq!(got[0].text_before, "yesterday — ");

        // On-disk JSON uses v1 camelCase keys.
        let raw = fs::read_to_string(
            tmp.path().join("areas/x/y.md.annotations.json"),
        )
        .unwrap();
        assert!(raw.contains("\"textBefore\""));
        assert!(raw.contains("\"createdAt\""));
        assert!(!raw.contains("text_before"));
    }

    #[test]
    fn save_empty_removes_existing_file() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/x/y.md");
        save(
            tmp.path(),
            "areas/x/y.md",
            &[Annotation {
                id: "a".into(),
                text: "x".into(),
                comment: String::new(),
                text_before: String::new(),
                text_after: String::new(),
                created_at: String::new(),
                processed_at: None,
            }],
        )
        .unwrap();
        let path = tmp.path().join("areas/x/y.md.annotations.json");
        assert!(path.exists());
        save(tmp.path(), "areas/x/y.md", &[]).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn list_pending_walks_tree_and_skips_archive_dotfiles() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/a/x.md");
        seed_doc(tmp.path(), "areas/b/y.md");
        seed_doc(tmp.path(), "areas/archive/z.md");
        seed_doc(tmp.path(), ".hidden/h.md");

        // x: 2 pending, 1 processed
        let now = "2026-04-24T18:00:00Z";
        save(
            tmp.path(),
            "areas/a/x.md",
            &[
                Annotation {
                    id: "1".into(),
                    text: "T1".into(),
                    comment: "fix this".into(),
                    text_before: String::new(),
                    text_after: String::new(),
                    created_at: now.into(),
                    processed_at: None,
                },
                Annotation {
                    id: "2".into(),
                    text: "T2".into(),
                    comment: "and this too — make it shorter".into(),
                    text_before: String::new(),
                    text_after: String::new(),
                    created_at: "2026-04-24T19:00:00Z".into(),
                    processed_at: None,
                },
                Annotation {
                    id: "3".into(),
                    text: "T3".into(),
                    comment: "done".into(),
                    text_before: String::new(),
                    text_after: String::new(),
                    created_at: now.into(),
                    processed_at: Some("2026-04-25T00:00:00Z".into()),
                },
            ],
        )
        .unwrap();

        // y: 1 pending
        save(
            tmp.path(),
            "areas/b/y.md",
            &[Annotation {
                id: "4".into(),
                text: "T4".into(),
                comment: "tiny".into(),
                text_before: String::new(),
                text_after: String::new(),
                created_at: now.into(),
                processed_at: None,
            }],
        )
        .unwrap();

        // archive: 1 pending — should be skipped
        save(
            tmp.path(),
            "areas/archive/z.md",
            &[Annotation {
                id: "5".into(),
                text: "T5".into(),
                comment: "in archive".into(),
                text_before: String::new(),
                text_after: String::new(),
                created_at: now.into(),
                processed_at: None,
            }],
        )
        .unwrap();

        let pending = list_pending(tmp.path()).unwrap();
        // archive + dotdir excluded. x has 2, y has 1 — sort puts x first.
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].rel_path, "areas/a/x.md");
        assert_eq!(pending[0].pending_count, 2);
        // Latest comment is the highest createdAt — "and this too…"
        assert!(pending[0].latest_comment.starts_with("and this too"));
        assert_eq!(pending[1].rel_path, "areas/b/y.md");
        assert_eq!(pending[1].pending_count, 1);
    }

    #[test]
    fn list_pending_skips_docs_where_all_processed() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/a/x.md");
        save(
            tmp.path(),
            "areas/a/x.md",
            &[Annotation {
                id: "1".into(),
                text: "T".into(),
                comment: "done".into(),
                text_before: String::new(),
                text_after: String::new(),
                created_at: "2026-04-24T18:00:00Z".into(),
                processed_at: Some("2026-04-25T00:00:00Z".into()),
            }],
        )
        .unwrap();
        assert_eq!(list_pending(tmp.path()).unwrap().len(), 0);
    }

    #[test]
    fn list_pending_truncates_long_comments() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/a/x.md");
        let long = "x".repeat(200);
        save(
            tmp.path(),
            "areas/a/x.md",
            &[Annotation {
                id: "1".into(),
                text: "T".into(),
                comment: long,
                text_before: String::new(),
                text_after: String::new(),
                created_at: "2026-04-24T18:00:00Z".into(),
                processed_at: None,
            }],
        )
        .unwrap();
        let pending = list_pending(tmp.path()).unwrap();
        assert_eq!(pending[0].latest_comment.chars().count(), 78);
        assert!(pending[0].latest_comment.ends_with("…"));
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = TempDir::new().unwrap();
        let err = list(tmp.path(), "../escape.md").unwrap_err();
        assert!(format!("{err}").contains("plain components"));
    }

    #[test]
    fn remove_by_ids_strips_only_matching_entries() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/a/x.md");
        save(
            tmp.path(),
            "areas/a/x.md",
            &[
                Annotation {
                    id: "keep".into(),
                    text: "T1".into(),
                    comment: "still pending".into(),
                    text_before: String::new(),
                    text_after: String::new(),
                    created_at: "2026-04-24T18:00:00Z".into(),
                    processed_at: None,
                },
                Annotation {
                    id: "drop".into(),
                    text: "T2".into(),
                    comment: "applied".into(),
                    text_before: String::new(),
                    text_after: String::new(),
                    created_at: "2026-04-24T19:00:00Z".into(),
                    processed_at: None,
                },
            ],
        )
        .unwrap();

        let removed = remove_by_ids(
            tmp.path(),
            "areas/a/x.md",
            &["drop".to_string(), "missing".to_string()],
        )
        .unwrap();
        assert_eq!(removed, 1);

        let remaining = list(tmp.path(), "areas/a/x.md").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "keep");
    }

    #[test]
    fn remove_by_ids_deletes_sidecar_when_empty() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/a/x.md");
        save(
            tmp.path(),
            "areas/a/x.md",
            &[Annotation {
                id: "only".into(),
                text: "T".into(),
                comment: "applied".into(),
                text_before: String::new(),
                text_after: String::new(),
                created_at: "2026-04-24T18:00:00Z".into(),
                processed_at: None,
            }],
        )
        .unwrap();
        let sidecar = tmp.path().join("areas/a/x.md.annotations.json");
        assert!(sidecar.exists());

        remove_by_ids(tmp.path(), "areas/a/x.md", &["only".to_string()]).unwrap();
        assert!(!sidecar.exists());
    }

    #[test]
    fn remove_by_ids_is_a_noop_when_sidecar_missing() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/a/x.md");
        let n = remove_by_ids(tmp.path(), "areas/a/x.md", &["x".to_string()])
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn remove_by_ids_empty_id_list_is_a_noop() {
        let tmp = TempDir::new().unwrap();
        seed_doc(tmp.path(), "areas/a/x.md");
        save(
            tmp.path(),
            "areas/a/x.md",
            &[Annotation {
                id: "a".into(),
                text: "T".into(),
                comment: String::new(),
                text_before: String::new(),
                text_after: String::new(),
                created_at: String::new(),
                processed_at: None,
            }],
        )
        .unwrap();
        let n = remove_by_ids(tmp.path(), "areas/a/x.md", &[]).unwrap();
        assert_eq!(n, 0);
        assert_eq!(list(tmp.path(), "areas/a/x.md").unwrap().len(), 1);
    }
}
