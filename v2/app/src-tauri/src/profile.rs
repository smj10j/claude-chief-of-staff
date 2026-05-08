//! User profile (PRD-103 Phase 0.5.2). Captures the identity bits
//! the assistant needs to feel personal — name, role, team, manager,
//! direct reports — and persists them at `<content_root>/profile.json`
//! so they live with the user's other content (and ride along when
//! they switch data folders).
//!
//! Every field is optional. The wizard nudges the user to fill it in
//! but never blocks. The schema is stable v1; adding a v2 field later
//! is a backward-compatible JSON addition.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

const PROFILE_FILENAME: &str = "profile.json";

/// Persisted user profile. Defaults to all-empty so the wizard can
/// surface a blank form when no profile.json exists yet.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UserProfile {
    /// Display name. Pre-filled from `~/.gitconfig` user.name when
    /// the wizard runs and no profile is on disk.
    pub name: String,
    /// Work email. Pre-filled from `~/.gitconfig` user.email.
    pub email: String,
    /// Free-form role title — "Senior Engineering Manager", "Staff
    /// PM", etc. Used in skill prompts to set the assistant's
    /// frame.
    pub role: String,
    /// Team / org context — "Payments at ExampleCorp", "Operations", whatever
    /// the user finds natural to say to a new colleague.
    pub team: String,
    /// Manager's name. Optional. Drives the
    /// `areas/one-on-ones/manager/<slug>/` folder if the user
    /// accepts the offer in Phase 0.5.5.
    pub manager: Option<NamedPerson>,
    /// Direct reports the user manages. Each row drives a folder
    /// at `areas/one-on-ones/direct-reports/<slug>/` if the user
    /// accepts the offer in Phase 0.5.5.
    pub direct_reports: Vec<NamedPerson>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct NamedPerson {
    pub name: String,
    /// Optional one-liner about the person — "M1 manager, Core
    /// team," "PM lead." Surfaces in 1:1 prep prompts as context.
    pub role: String,
}

impl Default for NamedPerson {
    fn default() -> Self {
        Self {
            name: String::new(),
            role: String::new(),
        }
    }
}

/// Read the profile from disk. Returns a default when:
///   - the file is missing (fresh install — wizard pre-fills
///     from `~/.gitconfig`)
///   - the file is unreadable or malformed (we don't want a corrupt
///     profile to crash the wizard)
pub fn read(content_root: &Path) -> UserProfile {
    let path = content_root.join(PROFILE_FILENAME);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return UserProfile::default(),
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Persist the profile, overwriting any existing one. The content
/// root is created on demand so the wizard can call this even on a
/// totally fresh install where the directory hasn't been seeded.
pub fn write(content_root: &Path, profile: &UserProfile) -> AppResult<()> {
    fs::create_dir_all(content_root)?;
    let path = content_root.join(PROFILE_FILENAME);
    let serialized = serde_json::to_string_pretty(profile)?;
    fs::write(path, serialized)?;
    Ok(())
}

/// "Slugify" a name for use as a folder name. Lowercase, hyphenated,
/// strips non-alphanumeric runs to single hyphens. "Alice Smith" →
/// "alice-smith"; "O'Donnell, Pat" → "o-donnell-pat".
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = true; // suppress leading dashes
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Relationship {
    DirectReports,
    Manager,
    Peers,
    SkipLevel,
    SkipLevelReports,
    Xfn,
}

impl Relationship {
    fn folder(self) -> &'static str {
        match self {
            Self::DirectReports => "direct-reports",
            Self::Manager => "manager",
            Self::Peers => "peers",
            Self::SkipLevel => "skip-level",
            Self::SkipLevelReports => "skip-level-reports",
            Self::Xfn => "xfn",
        }
    }
}

/// Phase 0.5.5 scaffolding spec — the wizard sends this when the
/// user clicks "create folders for these people."
#[derive(Debug, Clone, Deserialize)]
pub struct PersonScaffold {
    pub name: String,
    pub role: String,
    pub relationship: Relationship,
}

#[derive(Debug, Serialize)]
pub struct ScaffoldResult {
    /// Slug-named folders the wizard actually created (skipping ones
    /// that already existed). The frontend uses this list to render
    /// "we set up N people" in the next step.
    pub created: Vec<String>,
    /// Slugs that were skipped because the folder already exists —
    /// surfaces in a "we left these as-is" line so the user knows
    /// nothing was overwritten.
    pub skipped: Vec<String>,
}

/// Starter project templates the bootstrap step can scaffold. Each
/// kind drops a `projects/<id>/README.md` with prompts the user can
/// fill in. The list is intentionally diverse — projects in the
/// Chief of Staff sense aren't just code or Jira epics; they're
/// any time-bound thing that benefits from durable notes.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StarterProjectKind {
    CareerDevelopment,
    HiringPipeline,
    Mentorship,
    PresentationPrep,
    QuarterlyPlanning,
    NewTeamMember,
}

impl StarterProjectKind {
    fn slug(self) -> &'static str {
        match self {
            Self::CareerDevelopment => "career-development",
            Self::HiringPipeline => "hiring-pipeline",
            Self::Mentorship => "mentorship",
            Self::PresentationPrep => "presentation-prep",
            Self::QuarterlyPlanning => "quarterly-planning",
            Self::NewTeamMember => "new-team-member-onboarding",
        }
    }

    fn template(self) -> &'static str {
        match self {
            Self::CareerDevelopment => include_str!(
                "starter-project-templates/career-development.md"
            ),
            Self::HiringPipeline => include_str!(
                "starter-project-templates/hiring-pipeline.md"
            ),
            Self::Mentorship => include_str!(
                "starter-project-templates/mentorship.md"
            ),
            Self::PresentationPrep => include_str!(
                "starter-project-templates/presentation-prep.md"
            ),
            Self::QuarterlyPlanning => include_str!(
                "starter-project-templates/quarterly-planning.md"
            ),
            Self::NewTeamMember => include_str!(
                "starter-project-templates/new-team-member.md"
            ),
        }
    }
}

/// Create starter project READMEs at `<content_root>/projects/<slug>/`
/// for each kind. Idempotent — existing folders are left alone.
/// Returns the slugs that were actually created (skipped ones are
/// silently dropped because the user already has them).
pub fn scaffold_starter_projects(
    content_root: &Path,
    kinds: &[StarterProjectKind],
) -> AppResult<Vec<String>> {
    let projects_dir = content_root.join("projects");
    fs::create_dir_all(&projects_dir)?;
    let mut created = Vec::new();
    for kind in kinds {
        let slug = kind.slug();
        let dir = projects_dir.join(slug);
        let readme = dir.join("README.md");
        if readme.exists() {
            continue;
        }
        fs::create_dir_all(&dir)?;
        fs::write(&readme, kind.template())?;
        created.push(slug.to_string());
    }
    Ok(created)
}

/// Create starter `<content_root>/areas/one-on-ones/<relationship>/<slug>/README.md`
/// folders for each person. Idempotent: if a folder already exists,
/// the spec is added to the `skipped` list and the existing README
/// is left untouched.
pub fn scaffold_people(
    content_root: &Path,
    people: &[PersonScaffold],
) -> AppResult<ScaffoldResult> {
    let oo = content_root
        .join("areas")
        .join("one-on-ones");
    fs::create_dir_all(&oo)?;

    let mut created = Vec::new();
    let mut skipped = Vec::new();

    for spec in people {
        let trimmed = spec.name.trim();
        if trimmed.is_empty() {
            continue;
        }
        let slug = slugify(trimmed);
        if slug.is_empty() {
            continue;
        }
        let person_dir = oo.join(spec.relationship.folder()).join(&slug);
        let readme = person_dir.join("README.md");
        if readme.exists() {
            skipped.push(slug);
            continue;
        }
        fs::create_dir_all(person_dir.join("sessions"))?;
        let template = render_person_readme(&spec.name, &spec.role);
        fs::write(&readme, template)?;
        created.push(slug);
    }

    Ok(ScaffoldResult { created, skipped })
}

fn render_person_readme(name: &str, role: &str) -> String {
    let role_line = if role.trim().is_empty() {
        String::new()
    } else {
        format!("\n_{role}_\n", role = role.trim())
    };
    format!(
        r#"# {name}
{role_line}
## Context

_(Capture: how long they've been in role, what they care about, the through-line of your working relationship. Update over time — `/digest-meeting` and `/prep-1on1` will append themes here as you go.)_

## Themes I'm tracking

- _(open)_

## Recent threads

- _(latest sessions land here as bullet links — auto-generated by `/compact-sessions`)_

## Sessions

See [`sessions/`](./sessions/). New file per 1:1, ISO date (`2026-04-22.md`).
"#,
    )
}

/// Best-effort `~/.gitconfig` parse for `user.name` + `user.email`.
/// Used as a pre-fill for the wizard. Returns empty strings when
/// the file is missing or doesn't have a `[user]` section — the
/// wizard handles empty strings as "show a blank input."
pub fn read_gitconfig_defaults() -> (String, String) {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.is_empty() => h,
        _ => return (String::new(), String::new()),
    };
    let path = Path::new(&home).join(".gitconfig");
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return (String::new(), String::new()),
    };
    parse_gitconfig_user(&raw)
}

/// Pure helper for `read_gitconfig_defaults` — parses a gitconfig
/// blob and returns `(name, email)`. We don't depend on the `git2`
/// or `gitconfig` crates because gitconfig syntax is simple enough
/// that a 30-line parser handles every case we care about, and
/// pulling in a crate for one launch-time read is overkill.
pub fn parse_gitconfig_user(raw: &str) -> (String, String) {
    let mut name = String::new();
    let mut email = String::new();
    let mut in_user_section = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if let Some(section) = trimmed
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
        {
            // The section name might be "user" or `user "alias"`;
            // we only care about the bare `[user]` block.
            in_user_section = section.trim().eq_ignore_ascii_case("user");
            continue;
        }
        if !in_user_section {
            continue;
        }
        if let Some((k, v)) = trimmed.split_once('=') {
            let key = k.trim().to_ascii_lowercase();
            let mut value = v.trim().to_string();
            // Strip surrounding quotes if present.
            if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
                || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
            {
                value = value[1..value.len() - 1].to_string();
            }
            match key.as_str() {
                "name" => name = value,
                "email" => email = value,
                _ => {}
            }
        }
    }
    (name, email)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn read_returns_default_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        let p = read(tmp.path());
        assert_eq!(p.name, "");
        assert_eq!(p.email, "");
        assert!(p.direct_reports.is_empty());
    }

    #[test]
    fn read_returns_default_when_file_corrupt() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(PROFILE_FILENAME), "{not json").unwrap();
        let p = read(tmp.path());
        assert_eq!(p.name, "");
    }

    #[test]
    fn round_trip_preserves_fields() {
        let tmp = TempDir::new().unwrap();
        let p = UserProfile {
            name: "Alice".into(),
            email: "alice@example.com".into(),
            role: "Engineering Manager".into(),
            team: "Platform".into(),
            manager: Some(NamedPerson {
                name: "Bob".into(),
                role: "Director".into(),
            }),
            direct_reports: vec![
                NamedPerson {
                    name: "Carla".into(),
                    role: "Senior SWE".into(),
                },
                NamedPerson {
                    name: "Dan".into(),
                    role: "".into(),
                },
            ],
        };
        write(tmp.path(), &p).unwrap();
        let back = read(tmp.path());
        assert_eq!(back.name, "Alice");
        assert_eq!(back.email, "alice@example.com");
        assert_eq!(back.role, "Engineering Manager");
        assert_eq!(back.team, "Platform");
        assert_eq!(back.manager.as_ref().unwrap().name, "Bob");
        assert_eq!(back.direct_reports.len(), 2);
        assert_eq!(back.direct_reports[1].name, "Dan");
    }

    #[test]
    fn write_creates_content_root_if_missing() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("does/not/exist");
        let mut p = UserProfile::default();
        p.name = "Alice".into();
        write(&nested, &p).unwrap();
        assert!(nested.join(PROFILE_FILENAME).is_file());
    }

    #[test]
    fn parse_gitconfig_pulls_user_section() {
        let raw = r#"
[core]
    autocrlf = false
[user]
    name = Alice Smith
    email = alice@example.com
[alias]
    co = checkout
"#;
        let (name, email) = parse_gitconfig_user(raw);
        assert_eq!(name, "Alice Smith");
        assert_eq!(email, "alice@example.com");
    }

    #[test]
    fn parse_gitconfig_handles_quoted_values() {
        let raw = "[user]\n  name = \"Alice Smith\"\n  email = \'alice@example.com\'\n";
        let (name, email) = parse_gitconfig_user(raw);
        assert_eq!(name, "Alice Smith");
        assert_eq!(email, "alice@example.com");
    }

    #[test]
    fn parse_gitconfig_skips_unrelated_sections() {
        let raw = "[branch \"main\"]\n  name = pretend\n[user]\n  name = real\n";
        let (name, _) = parse_gitconfig_user(raw);
        assert_eq!(name, "real");
    }

    #[test]
    fn parse_gitconfig_handles_missing_user_section() {
        let raw = "[core]\n  autocrlf = false\n";
        let (name, email) = parse_gitconfig_user(raw);
        assert_eq!(name, "");
        assert_eq!(email, "");
    }

    #[test]
    fn slugify_handles_common_cases() {
        assert_eq!(slugify("Alice Smith"), "alice-smith");
        assert_eq!(slugify("O'Donnell, Pat"), "o-donnell-pat");
        assert_eq!(slugify("  Jean-Luc  "), "jean-luc");
        // Non-ASCII runs collapse to dashes; the surrounding ASCII
        // letters survive: "Renée" → "ren-e". Imperfect for Unicode
        // names but predictable, and the user can rename the folder
        // by hand if it's not what they wanted.
        assert_eq!(slugify("Renée"), "ren-e");
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("---"), "");
        assert_eq!(slugify("Alice 2.0"), "alice-2-0");
    }

    #[test]
    fn scaffold_creates_readmes_for_each_person() {
        let tmp = TempDir::new().unwrap();
        let people = vec![
            PersonScaffold {
                name: "Alice Smith".into(),
                role: "Senior SWE".into(),
                relationship: Relationship::DirectReports,
            },
            PersonScaffold {
                name: "Bob Jones".into(),
                role: "".into(),
                relationship: Relationship::Manager,
            },
        ];
        let result = scaffold_people(tmp.path(), &people).unwrap();
        assert_eq!(result.created, vec!["alice-smith", "bob-jones"]);
        assert!(result.skipped.is_empty());
        assert!(tmp
            .path()
            .join("areas/one-on-ones/direct-reports/alice-smith/README.md")
            .is_file());
        assert!(tmp
            .path()
            .join("areas/one-on-ones/direct-reports/alice-smith/sessions")
            .is_dir());
        assert!(tmp
            .path()
            .join("areas/one-on-ones/manager/bob-jones/README.md")
            .is_file());
        // Role appears in the rendered README when present.
        let alice = fs::read_to_string(
            tmp.path()
                .join("areas/one-on-ones/direct-reports/alice-smith/README.md"),
        )
        .unwrap();
        assert!(alice.contains("# Alice Smith"));
        assert!(alice.contains("_Senior SWE_"));
    }

    #[test]
    fn scaffold_skips_existing_readmes() {
        let tmp = TempDir::new().unwrap();
        // Pre-create a person so the scaffold should leave it alone.
        let existing = tmp
            .path()
            .join("areas/one-on-ones/direct-reports/alice-smith");
        fs::create_dir_all(&existing).unwrap();
        let original_readme = "# Alice — already here";
        fs::write(existing.join("README.md"), original_readme).unwrap();

        let people = vec![PersonScaffold {
            name: "Alice Smith".into(),
            role: "(new role)".into(),
            relationship: Relationship::DirectReports,
        }];
        let result = scaffold_people(tmp.path(), &people).unwrap();
        assert!(result.created.is_empty());
        assert_eq!(result.skipped, vec!["alice-smith"]);
        // Original content preserved.
        let after = fs::read_to_string(existing.join("README.md")).unwrap();
        assert_eq!(after, original_readme);
    }

    #[test]
    fn scaffold_skips_blank_or_unsluggable_names() {
        let tmp = TempDir::new().unwrap();
        let people = vec![
            PersonScaffold {
                name: "".into(),
                role: "".into(),
                relationship: Relationship::Peers,
            },
            PersonScaffold {
                name: "---".into(),
                role: "".into(),
                relationship: Relationship::Peers,
            },
        ];
        let result = scaffold_people(tmp.path(), &people).unwrap();
        assert!(result.created.is_empty());
        assert!(result.skipped.is_empty());
    }
}
