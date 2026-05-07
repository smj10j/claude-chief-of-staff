//! Paging-provider integration. Powers the Ops → On-call tab, the
//! Home on-call strip, and the per-service-on-call panel on Health.
//!
//! Design (PRD-108 §11). v2 ships a single PagerDuty REST API
//! provider here and dispatches to it directly. The trait sketch
//! below describes what a second impl (Opsgenie / FireHydrant /
//! org-specific) would need to fill — kept as documentation, not
//! enforced via a trait object, until a second impl exists. YAGNI
//! says don't build the dispatch table for one path.
//!
//! ```rust,ignore
//! pub trait Provider {
//!     fn whoami(&self) -> AppResult<String>;
//!     fn oncall_now(&self) -> AppResult<Vec<OncallEntry>>;
//!     fn for_service(&self, service_id: &str) -> AppResult<Vec<OncallEntry>>;
//!     fn user_shifts(&self, user_id: &str, days: u32) -> AppResult<Vec<Shift>>;
//! }
//! ```

// ============================================================
// Adding a second provider (Opsgenie / FireHydrant / org-specific)
// ============================================================
//
// Step 1: implement these four functions in a new module
// `src/paging_<vendor>.rs`. Match the OncallEntry / Shift shapes
// defined here — the IPC layer shouldn't have to negotiate.
//
// Step 2: introduce a `Provider` trait *only* once a second impl
// exists. Until then, don't preemptively dispatch through a trait
// object — it adds boilerplate without payoff. Pattern when you do:
//
//     pub trait Provider {
//         fn whoami(&self) -> AppResult<String>;
//         fn oncall_now(&self) -> AppResult<Vec<OncallEntry>>;
//         fn for_service(&self, sid: &str) -> AppResult<Vec<OncallEntry>>;
//         fn user_shifts(&self, uid: &str, days: u32) -> AppResult<Vec<Shift>>;
//     }
//
//     pub fn provider() -> Box<dyn Provider> {
//         match settings::paging_provider() {
//             "pagerduty" => Box::new(PagerDuty::new(read_token()?)),
//             "opsgenie"  => Box::new(Opsgenie::new(read_token()?)),
//             _           => Box::new(NullProvider),
//         }
//     }
//
// Step 3: lift the IPC functions in lib.rs to call `provider()`
// and dispatch through the trait. The Settings UI (PagingSettings)
// already has a provider dropdown; populate its options from a
// constant in this module so the dropdown stays in sync with the
// available impls.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::secrets;

/// Keychain account for the PagerDuty API token. Personal-scope
/// tokens are fine; nothing here requires admin scope.
const PD_TOKEN_KEY: &str = "pagerduty-api-token";

/// Read the PagerDuty API token. Token resolution priority:
///   1. `PAGERDUTY_API_TOKEN` env var (developer + CI override)
///   2. macOS Keychain entry `<bundle-id>/pagerduty-api-token`
/// Returns `None` when neither is set.
pub fn read_token() -> AppResult<Option<String>> {
    if let Ok(env) = std::env::var("PAGERDUTY_API_TOKEN") {
        let trimmed = env.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
    secrets::get(PD_TOKEN_KEY)
}

pub fn write_token(token: &str) -> AppResult<()> {
    secrets::set(PD_TOKEN_KEY, token.trim())
}

pub fn clear_token() -> AppResult<()> {
    secrets::delete(PD_TOKEN_KEY)
}

/// One on-call entry, normalised for the v2 surface. The PD payload
/// joins `oncall` rows with `users`, `schedules`, and `escalation_policies`
/// when `include[]` is passed; we flatten those into one shape so
/// the UI doesn't have to negotiate.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OncallEntry {
    /// Escalation policy id (stable across renames). Used as the
    /// grouping key for the On-call tab.
    pub policy_id: String,
    pub policy_name: String,
    /// 1 = primary, 2 = secondary, etc. PagerDuty's escalation level.
    pub level: u32,
    pub user_id: String,
    pub user_name: String,
    /// Schedule that produced the on-call (may be null when override
    /// is in place). Carries through for "why is X on-call?".
    pub schedule_id: Option<String>,
    pub schedule_name: Option<String>,
    /// RFC 3339; the on-call entry is valid until this time.
    pub end: Option<String>,
    /// Direct deep-link to the user's PD profile. Lets the UI route
    /// a click without re-resolving the id.
    pub user_url: String,
}

/// Minimal upcoming-shift row used by Person Profile (B9-CP33).
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Shift {
    pub schedule_id: String,
    pub schedule_name: String,
    pub start: String,
    pub end: String,
    pub level: u32,
}

const PD_BASE: &str = "https://api.pagerduty.com";
const PD_USER_AGENT: &str = "ChiefOfStaff/v2 (paging integration)";
const PD_ACCEPT: &str = "application/vnd.pagerduty+json;version=2";

/// `whoami` — round-trip the token through `/users/me`. Returns the
/// user's email so Settings → Ops → On-call can confirm the token
/// works without exposing the raw value.
pub fn whoami(token: &str) -> AppResult<String> {
    let resp = pd_get(token, "/users/me", &[])?;
    parse_whoami(&resp)
}

pub fn parse_whoami(raw: &str) -> AppResult<String> {
    #[derive(Deserialize)]
    struct Outer {
        user: User,
    }
    #[derive(Deserialize)]
    struct User {
        email: String,
    }
    let outer: Outer = serde_json::from_str(raw).map_err(|e| {
        AppError::InvalidState(format!("pd whoami parse: {e}"))
    })?;
    Ok(outer.user.email)
}

/// `oncall_now` — single round-trip listing every on-call across all
/// schedules visible to the token. Cached at the IPC layer for 60 s.
pub fn oncall_now(token: &str) -> AppResult<Vec<OncallEntry>> {
    // include[] flattens the nested user / schedule / policy refs
    // so the response is self-contained.
    let resp = pd_get(
        token,
        "/oncalls",
        &[
            ("limit", "100"),
            ("include[]", "users"),
            ("include[]", "schedules"),
            ("include[]", "escalation_policies"),
        ],
    )?;
    parse_oncalls(&resp)
}

pub fn parse_oncalls(raw: &str) -> AppResult<Vec<OncallEntry>> {
    #[derive(Deserialize)]
    struct Outer {
        oncalls: Vec<RawOncall>,
    }
    #[derive(Deserialize)]
    struct RawOncall {
        escalation_policy: PolicyRef,
        #[serde(default)]
        escalation_level: u32,
        user: UserRef,
        #[serde(default)]
        schedule: Option<ScheduleRef>,
        #[serde(default)]
        end: Option<String>,
    }
    #[derive(Deserialize)]
    struct PolicyRef {
        id: String,
        #[serde(default)]
        summary: String,
    }
    #[derive(Deserialize)]
    struct UserRef {
        id: String,
        #[serde(default)]
        summary: String,
        #[serde(default)]
        html_url: String,
    }
    #[derive(Deserialize)]
    struct ScheduleRef {
        id: String,
        #[serde(default)]
        summary: String,
    }
    let outer: Outer = serde_json::from_str(raw).map_err(|e| {
        AppError::InvalidState(format!("pd oncalls parse: {e}"))
    })?;
    Ok(outer
        .oncalls
        .into_iter()
        .map(|o| OncallEntry {
            policy_id: o.escalation_policy.id,
            policy_name: o.escalation_policy.summary,
            level: o.escalation_level,
            user_id: o.user.id,
            user_name: o.user.summary,
            schedule_id: o.schedule.as_ref().map(|s| s.id.clone()),
            schedule_name: o.schedule.as_ref().map(|s| s.summary.clone()),
            end: o.end,
            user_url: o.user.html_url,
        })
        .collect())
}

/// `for_service` — who is on-call for this service id, right now.
/// Reuses oncall_now then filters by escalation policy via a one-shot
/// service lookup. Two round-trips total.
pub fn for_service(token: &str, service_id: &str) -> AppResult<Vec<OncallEntry>> {
    let svc_resp = pd_get(token, &format!("/services/{service_id}"), &[])?;
    let policy_id = parse_service_policy(&svc_resp)?;
    let mut all = oncall_now(token)?;
    all.retain(|o| o.policy_id == policy_id);
    Ok(all)
}

pub fn parse_service_policy(raw: &str) -> AppResult<String> {
    #[derive(Deserialize)]
    struct Outer {
        service: Service,
    }
    #[derive(Deserialize)]
    struct Service {
        escalation_policy: PolicyRef,
    }
    #[derive(Deserialize)]
    struct PolicyRef {
        id: String,
    }
    let outer: Outer = serde_json::from_str(raw).map_err(|e| {
        AppError::InvalidState(format!("pd service parse: {e}"))
    })?;
    Ok(outer.service.escalation_policy.id)
}

/// `user_shifts` — upcoming shifts in the next `days`. Used by Person
/// Profile (B9-CP33). Driven by `/users/{id}/oncalls` with a
/// `since`/`until` window.
pub fn user_shifts(token: &str, user_id: &str, days: u32) -> AppResult<Vec<Shift>> {
    let now = chrono_like_now_iso();
    let until = chrono_like_offset_iso(days);
    let resp = pd_get(
        token,
        &format!("/users/{user_id}/oncalls"),
        &[
            ("since", now.as_str()),
            ("until", until.as_str()),
            ("limit", "100"),
        ],
    )?;
    parse_user_shifts(&resp)
}

pub fn parse_user_shifts(raw: &str) -> AppResult<Vec<Shift>> {
    #[derive(Deserialize)]
    struct Outer {
        oncalls: Vec<RawShift>,
    }
    #[derive(Deserialize)]
    struct RawShift {
        #[serde(default)]
        schedule: Option<ScheduleRef>,
        #[serde(default)]
        escalation_level: u32,
        #[serde(default)]
        start: String,
        #[serde(default)]
        end: String,
    }
    #[derive(Deserialize)]
    struct ScheduleRef {
        id: String,
        #[serde(default)]
        summary: String,
    }
    let outer: Outer = serde_json::from_str(raw).map_err(|e| {
        AppError::InvalidState(format!("pd shifts parse: {e}"))
    })?;
    Ok(outer
        .oncalls
        .into_iter()
        .filter_map(|s| {
            let sched = s.schedule?;
            Some(Shift {
                schedule_id: sched.id,
                schedule_name: sched.summary,
                start: s.start,
                end: s.end,
                level: s.escalation_level,
            })
        })
        .collect())
}

/// One PD GET. Adds the auth header, format header, and 15 s
/// timeout. Errors fold the response body into AppError so the
/// Settings UI can surface the actual reason.
fn pd_get(
    token: &str,
    path: &str,
    query: &[(&str, &str)],
) -> AppResult<String> {
    let url = format!("{PD_BASE}{path}");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .build();
    let mut req = agent
        .get(&url)
        .set("Authorization", &format!("Token token={token}"))
        .set("Accept", PD_ACCEPT)
        .set("User-Agent", PD_USER_AGENT);
    for (k, v) in query {
        req = req.query(k, v);
    }
    match req.call() {
        Ok(resp) => Ok(resp.into_string().map_err(AppError::Io)?),
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Err(AppError::InvalidState(format!(
                "pagerduty {code}: {}",
                body.chars().take(300).collect::<String>()
            )))
        }
        Err(e) => Err(AppError::InvalidState(format!("pagerduty request: {e}"))),
    }
}

/// Lightweight "now in RFC3339 UTC" without pulling in chrono. We
/// don't need calendar arithmetic — just a `since` / `until` pair
/// the API accepts.
fn chrono_like_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    iso_from_unix(now as i64)
}

fn chrono_like_offset_iso(days_ahead: u32) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    iso_from_unix(now + (days_ahead as i64) * 86_400)
}

/// Unix → "YYYY-MM-DDTHH:MM:SSZ". Approximate calendar math
/// sufficient for PD's `since`/`until` window. Hand-rolled because
/// pulling in chrono just for this is overkill.
fn iso_from_unix(t: i64) -> String {
    let secs_in_day: i64 = 86_400;
    let mut days = t / secs_in_day;
    let s = t.rem_euclid(secs_in_day);
    let hour = s / 3600;
    let min = (s % 3600) / 60;
    let sec = s % 60;

    // Civil-from-days algorithm (Hinnant). Constant-time.
    days += 719_468;
    let era = days.div_euclid(146_097);
    let doe = days - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hour, min, sec
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_whoami_extracts_email() {
        let raw = r#"{"user":{"id":"U1","email":"steve@example.com","name":"Steve"}}"#;
        assert_eq!(parse_whoami(raw).unwrap(), "steve@example.com");
    }

    #[test]
    fn parse_oncalls_flattens_nested_refs() {
        // Trimmed but real-shape PD payload.
        let raw = r#"{"oncalls":[{
            "escalation_policy":{"id":"P1","summary":"Payments Core"},
            "escalation_level":1,
            "user":{"id":"U1","summary":"Alice","html_url":"https://example.pagerduty.com/users/U1"},
            "schedule":{"id":"S1","summary":"Payments Core Primary"},
            "end":"2026-04-30T00:00:00Z"
        },{
            "escalation_policy":{"id":"P1","summary":"Payments Core"},
            "escalation_level":2,
            "user":{"id":"U2","summary":"Carol","html_url":"https://example.pagerduty.com/users/U2"},
            "schedule":null,
            "end":null
        }]}"#;
        let rows = parse_oncalls(raw).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].policy_id, "P1");
        assert_eq!(rows[0].user_name, "Alice");
        assert_eq!(rows[0].level, 1);
        assert_eq!(rows[0].schedule_id.as_deref(), Some("S1"));
        assert_eq!(rows[1].schedule_id, None);
    }

    #[test]
    fn parse_service_policy_extracts_policy_id() {
        let raw = r#"{"service":{"id":"PS1","escalation_policy":{"id":"P42"}}}"#;
        assert_eq!(parse_service_policy(raw).unwrap(), "P42");
    }

    #[test]
    fn parse_user_shifts_drops_entries_without_schedule() {
        let raw = r#"{"oncalls":[
            {"schedule":{"id":"S1","summary":"Primary"},"escalation_level":1,"start":"2026-04-25T00:00:00Z","end":"2026-04-26T00:00:00Z"},
            {"schedule":null,"escalation_level":1,"start":"x","end":"y"}
        ]}"#;
        let shifts = parse_user_shifts(raw).unwrap();
        assert_eq!(shifts.len(), 1);
        assert_eq!(shifts[0].schedule_name, "Primary");
    }

    #[test]
    fn iso_from_unix_round_trips_known_instants() {
        // 2026-04-25T12:00:00Z = 1777118400 (computed: 20568 days *
        // 86400 + 12h offset; manually verified via `date -u -d`).
        assert_eq!(iso_from_unix(1_777_118_400), "2026-04-25T12:00:00Z");
        // Epoch
        assert_eq!(iso_from_unix(0), "1970-01-01T00:00:00Z");
        // A leap-day boundary (2024-02-29 → 2024-03-01) to exercise
        // the civil-from-days month rollover.
        assert_eq!(iso_from_unix(1_709_251_200), "2024-03-01T00:00:00Z");
    }
}
