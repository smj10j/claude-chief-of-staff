//! ICS subscription fetcher + minimal parser for the Calendar surface.
//!
//! This is intentionally tiny: real iCalendar feeds we care about (Google
//! Calendar, Outlook, Notion, Cal.com) all emit a strict-enough subset that
//! a line-folded VEVENT walk is sufficient. We don't try to be a full
//! RFC 5545 implementation — recurring events are exploded by the upstream
//! exporter for subscription URLs, which is what User's Google Calendar
//! does.
//!
//! Output shape is deliberately UI-shaped (one event per occurrence within
//! the requested window) so the frontend doesn't need to expand RRULEs.
//! Window filtering happens in `events_in_range`.
//!
//! When EventKit lands (M7b), this module remains the fallback transport
//! and the user-facing API stays the same.

use std::fs;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CalendarEvent {
    /// VEVENT UID (stable across refreshes; survives time-edits).
    pub uid: String,
    pub summary: String,
    /// RFC 3339 timestamp in UTC. Date-only events emit T00:00:00Z so the
    /// frontend can sort uniformly without branching on type.
    pub start: String,
    pub end: String,
    /// True when DTSTART had a `VALUE=DATE` qualifier (no time-of-day).
    pub all_day: bool,
    pub location: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<String>,
    pub attendees: Vec<String>,
    /// Free-text `STATUS:` (CONFIRMED / TENTATIVE / CANCELLED). Lowercased.
    pub status: Option<String>,
}

/// Fetch + parse an ICS feed by URL or read it from disk if `source` is
/// a `file://` URL or a bare path. The reason we accept either is that
/// during development you frequently want to point at a saved test fixture
/// before flipping the live URL on; saves a round-trip through the network
/// every reload.
pub fn fetch(source: &str) -> AppResult<Vec<CalendarEvent>> {
    let text = if let Some(path) = source.strip_prefix("file://") {
        std::fs::read_to_string(path).map_err(AppError::Io)?
    } else if source.starts_with("https://") || source.starts_with("http://") {
        let resp = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .build()
            .get(source)
            // Google Calendar's `/ical/.../basic.ics` endpoint 403s without
            // a UA; mimicking a browser-ish UA is the standard workaround
            // for ICS subscription endpoints. Identifying ourselves
            // honestly afterwards keeps server logs informative.
            .set("User-Agent", "Mozilla/5.0 ChiefOfStaff/v2 (ical-fetcher)")
            .call()
            .map_err(|e| AppError::InvalidState(format!("ics fetch: {e}")))?;
        resp.into_string().map_err(AppError::Io)?
    } else {
        std::fs::read_to_string(source).map_err(AppError::Io)?
    };
    Ok(parse(&text))
}

/// Resolve the EventKit script path.
///
/// In dev runs, `<repo_root>/bin/calendar/eventkit.sh` lives next to
/// the source tree. In packaged builds the script + Swift source ride
/// along as Tauri bundle resources but the bundle is read-only (it's
/// signed); the script needs a writable directory because it caches a
/// compiled `.eventkit-bin` next to itself on first run.
///
/// This function, given the app data dir + (optional) bundle resource
/// dir + (optional) repo root, picks the right source and extracts to
/// `<app_data>/calendar/` on first call. Returns the path to the
/// extracted script. Idempotent: on subsequent calls it reuses the
/// extracted copy unless the bundled source is newer.
pub fn resolve_eventkit_script(
    app_data_dir: &std::path::Path,
    bundle_resource_dir: Option<&std::path::Path>,
    repo_root: Option<&std::path::Path>,
) -> AppResult<std::path::PathBuf> {
    // 1. Dev path wins when the repo's bin/calendar/eventkit.sh is
    //    reachable — keeps the dev workflow unchanged + lets edits
    //    flow without a rebuild.
    if let Some(rr) = repo_root {
        let dev_script = rr.join("bin").join("calendar").join("eventkit.sh");
        if dev_script.is_file() {
            return Ok(dev_script);
        }
    }

    // 2. Packaged path: extract the bundled script + swift source to
    //    <app_data>/calendar/ where it's writable.
    let Some(rd) = bundle_resource_dir else {
        return Err(AppError::NotFound(
            "eventkit adapter unavailable: no repo root and no bundle resources".into(),
        ));
    };
    let bundled_script = rd.join("bin").join("calendar").join("eventkit.sh");
    let bundled_swift = rd.join("bin").join("calendar").join("eventkit.swift");
    if !bundled_script.is_file() {
        return Err(AppError::NotFound(format!(
            "eventkit adapter not in bundle resources at {}",
            bundled_script.display()
        )));
    }

    let extract_dir = app_data_dir.join("calendar");
    let extracted_script = extract_dir.join("eventkit.sh");
    let extracted_swift = extract_dir.join("eventkit.swift");

    fs::create_dir_all(&extract_dir)?;

    // Copy if the bundled version is newer (or extracted doesn't
    // exist yet). Catches the upgrade case where a newer .dmg ships
    // an updated script — the extracted copy gets refreshed.
    let needs_copy = !extracted_script.is_file()
        || file_newer(&bundled_script, &extracted_script).unwrap_or(true);
    if needs_copy {
        fs::copy(&bundled_script, &extracted_script)?;
        // Mark executable. fs::copy preserves the source mode on
        // most platforms but explicit chmod doesn't hurt.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&extracted_script)?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&extracted_script, perms)?;
        }
    }
    if bundled_swift.is_file() {
        let needs_copy_swift = !extracted_swift.is_file()
            || file_newer(&bundled_swift, &extracted_swift).unwrap_or(true);
        if needs_copy_swift {
            fs::copy(&bundled_swift, &extracted_swift)?;
        }
    }

    Ok(extracted_script)
}

fn file_newer(a: &std::path::Path, b: &std::path::Path) -> Option<bool> {
    let ma = fs::metadata(a).ok()?;
    let mb = fs::metadata(b).ok()?;
    Some(ma.modified().ok()? > mb.modified().ok()?)
}

/// Run the EventKit adapter (`bin/calendar/eventkit.sh list --from … --to …`)
/// and parse its JSON output. Returns events directly — no ICS in this
/// path. The caller decides between this and `fetch` based on user
/// preference + macOS availability.
///
/// `repo_root` is the directory containing `bin/calendar/eventkit.sh`.
/// We fail soft with InvalidState if the script isn't there or the
/// subprocess exits non-zero so the caller can fall through to ICS.
pub fn fetch_eventkit_at(
    script: &std::path::Path,
    from_iso_day: &str,
    to_iso_day: &str,
) -> AppResult<Vec<CalendarEvent>> {
    if !script.is_file() {
        return Err(AppError::NotFound(format!(
            "eventkit adapter not found at {}",
            script.display()
        )));
    }
    let out = std::process::Command::new(script)
        .args(["list", "--from", from_iso_day, "--to", to_iso_day])
        .output()
        .map_err(|e| AppError::InvalidState(format!("spawn {}: {e}", script.display())))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        return Err(AppError::InvalidState(format!(
            "eventkit adapter exited {}: {}",
            out.status,
            stderr.trim()
        )));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let events: Vec<CalendarEvent> = serde_json::from_str(stdout.trim())
        .map_err(|e| AppError::InvalidState(format!("eventkit json: {e}")))?;
    Ok(events)
}

/// Filter `events` to those whose `start..end` window overlaps the given
/// inclusive day range. Dates are `YYYY-MM-DD` strings interpreted in UTC
/// (a small lie: events are UTC-normalized so the user-facing day boundary
/// can drift by a few hours for DTSTART:DATE-only items, but for the
/// "today's meetings" use case this is fine and we get to keep the parser
/// timezone-free).
pub fn events_in_range(
    events: &[CalendarEvent],
    from_iso_day: &str,
    to_iso_day: &str,
) -> Vec<CalendarEvent> {
    let from = format!("{from_iso_day}T00:00:00Z");
    let to_excl = day_after(to_iso_day);
    let mut out: Vec<CalendarEvent> = events
        .iter()
        .filter(|e| e.start.as_str() < to_excl.as_str() && e.end.as_str() > from.as_str())
        .cloned()
        .collect();
    out.sort_by(|a, b| a.start.cmp(&b.start).then(a.summary.cmp(&b.summary)));
    out
}

/// Add 24h to `YYYY-MM-DD` and return `YYYY-MM-DDT00:00:00Z` for the next
/// day. Naively bumps the day field, then normalizes month/year with the
/// usual 28/29/30/31 rule. Intentionally avoids pulling in chrono just for
/// this — the format is fixed.
fn day_after(iso_day: &str) -> String {
    let parts: Vec<&str> = iso_day.split('-').collect();
    if parts.len() != 3 {
        // Garbage in → return a sentinel that excludes everything; the
        // caller's range filter then yields no events.
        return "0000-00-00T00:00:00Z".into();
    }
    let mut y: i32 = parts[0].parse().unwrap_or(2000);
    let mut m: u32 = parts[1].parse().unwrap_or(1);
    let mut d: u32 = parts[2].parse().unwrap_or(1);
    d += 1;
    if d > days_in_month(y, m) {
        d = 1;
        m += 1;
        if m > 12 {
            m = 1;
            y += 1;
        }
    }
    format!("{y:04}-{m:02}-{d:02}T00:00:00Z")
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap =
                (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
            if leap {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Parse an ICS document. Folded continuation lines (RFC 5545 §3.1: a
/// single character of whitespace at the start means "continuation of the
/// previous logical line") are unfolded first. Then we walk top-to-bottom
/// collecting events between BEGIN:VEVENT/END:VEVENT.
pub fn parse(text: &str) -> Vec<CalendarEvent> {
    let unfolded = unfold(text);
    let mut events: Vec<CalendarEvent> = Vec::new();
    let mut cur: Option<EventBuilder> = None;
    for line in unfolded.lines() {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.eq_ignore_ascii_case("BEGIN:VEVENT") {
            cur = Some(EventBuilder::default());
            continue;
        }
        if trimmed.eq_ignore_ascii_case("END:VEVENT") {
            if let Some(b) = cur.take() {
                if let Some(e) = b.build() {
                    events.push(e);
                }
            }
            continue;
        }
        if let Some(b) = cur.as_mut() {
            absorb_line(b, trimmed);
        }
    }
    events
}

/// Apply RFC 5545 line unfolding: whenever a line starts with a single
/// space or tab, append it (sans leading whitespace) to the previous line.
fn unfold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split('\n') {
        let stripped = line.trim_end_matches('\r');
        if let Some(rest) = stripped.strip_prefix(' ') {
            out.push_str(rest);
        } else if let Some(rest) = stripped.strip_prefix('\t') {
            out.push_str(rest);
        } else {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(stripped);
        }
    }
    out
}

#[derive(Default, Debug)]
struct EventBuilder {
    uid: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    status: Option<String>,
    organizer: Option<String>,
    attendees: Vec<String>,
    dtstart: Option<(String, bool)>, // (utc_iso, all_day)
    dtend: Option<(String, bool)>,
}

impl EventBuilder {
    fn build(self) -> Option<CalendarEvent> {
        let (start, all_day) = self.dtstart?;
        // ICS spec lets DTEND be omitted for date-only events; default to
        // the same start (the UI treats that as a 0-length placeholder).
        let (end, _) = self.dtend.clone().unwrap_or_else(|| (start.clone(), all_day));
        Some(CalendarEvent {
            uid: self.uid.unwrap_or_else(|| start.clone()),
            summary: self.summary.unwrap_or_else(|| "(no title)".to_string()),
            start,
            end,
            all_day,
            location: self.location,
            description: self.description,
            organizer: self.organizer,
            attendees: self.attendees,
            status: self.status,
        })
    }
}

fn absorb_line(b: &mut EventBuilder, line: &str) {
    // Property line shape: `NAME[;PARAMS]:VALUE`. Split on the first ':'
    // outside of a quoted parameter — but ICS quoting only matters inside
    // params, and our usage doesn't put colons in params, so a plain
    // first-colon split suffices.
    let colon_idx = match line.find(':') {
        Some(i) => i,
        None => return,
    };
    let head = &line[..colon_idx];
    let value = &line[colon_idx + 1..];
    // Split off params on the head: `NAME;PARAM1=...;PARAM2=...`
    let (name, params) = match head.find(';') {
        Some(i) => (&head[..i], Some(&head[i + 1..])),
        None => (head, None),
    };
    let name_upper = name.to_ascii_uppercase();
    match name_upper.as_str() {
        "UID" => b.uid = Some(value.to_string()),
        "SUMMARY" => b.summary = Some(unescape(value)),
        "DESCRIPTION" => b.description = Some(unescape(value)),
        "LOCATION" => b.location = Some(unescape(value)),
        "STATUS" => b.status = Some(value.to_ascii_lowercase()),
        "ORGANIZER" => b.organizer = Some(extract_addr(value)),
        "ATTENDEE" => b.attendees.push(extract_addr(value)),
        "DTSTART" => b.dtstart = Some(parse_dt(params, value)),
        "DTEND" => b.dtend = Some(parse_dt(params, value)),
        _ => {}
    }
}

fn extract_addr(value: &str) -> String {
    // ORGANIZER is typically `mailto:name@host`. Strip the schema if so.
    value
        .strip_prefix("mailto:")
        .or_else(|| value.strip_prefix("MAILTO:"))
        .unwrap_or(value)
        .to_string()
}

/// Convert ICS escapes back to literal characters. `\n` → newline, `\,`/
/// `\;` → comma/semicolon, `\\` → backslash.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut iter = s.chars().peekable();
    while let Some(c) = iter.next() {
        if c == '\\' {
            match iter.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse `DTSTART:value` (or with params like `;TZID=America/Chicago` or
/// `;VALUE=DATE`). Returns (iso_utc, all_day).
fn parse_dt(params: Option<&str>, value: &str) -> (String, bool) {
    let value_only_date = params
        .map(|p| p.split(';').any(|kv| kv.eq_ignore_ascii_case("VALUE=DATE")))
        .unwrap_or(false);
    if value_only_date || (value.len() == 8 && value.chars().all(|c| c.is_ascii_digit())) {
        // YYYYMMDD → YYYY-MM-DDT00:00:00Z
        let y = &value[..4];
        let m = &value[4..6];
        let d = &value[6..8];
        return (format!("{y}-{m}-{d}T00:00:00Z"), true);
    }
    // Either YYYYMMDDTHHMMSS (floating) or YYYYMMDDTHHMMSSZ. We treat the
    // floating variant as if it were UTC; if the user's calendar emits
    // floating times we'll show them as UTC and the frontend can re-localize.
    let raw = value.trim_end_matches('Z');
    if raw.len() < 15 {
        // Malformed; fall back to date-only at the head.
        let y = raw.get(..4).unwrap_or("0000");
        let m = raw.get(4..6).unwrap_or("01");
        let d = raw.get(6..8).unwrap_or("01");
        return (format!("{y}-{m}-{d}T00:00:00Z"), false);
    }
    let y = &raw[..4];
    let m = &raw[4..6];
    let d = &raw[6..8];
    let h = &raw[9..11];
    let mi = &raw[11..13];
    let s = &raw[13..15];
    (format!("{y}-{m}-{d}T{h}:{mi}:{s}Z"), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//Test//EN\r\n\
BEGIN:VEVENT\r\n\
UID:abc-123\r\n\
SUMMARY:Team Eng Leads\r\n\
DTSTART:20260424T180000Z\r\n\
DTEND:20260424T185000Z\r\n\
LOCATION:Zoom\r\n\
ORGANIZER;CN=User:mailto:example.user@example.com\r\n\
ATTENDEE;CN=Bob:mailto:bob@example.com\r\n\
ATTENDEE:mailto:ian@example.com\r\n\
STATUS:CONFIRMED\r\n\
DESCRIPTION:Discuss roadmap;\\n new hires\r\n\
END:VEVENT\r\n\
BEGIN:VEVENT\r\n\
UID:def-456\r\n\
SUMMARY:Travel home\r\n\
DTSTART;VALUE=DATE:20260424\r\n\
DTEND;VALUE=DATE:20260425\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn parses_two_events_with_all_fields() {
        let events = parse(SAMPLE);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].uid, "abc-123");
        assert_eq!(events[0].summary, "Team Eng Leads");
        assert_eq!(events[0].start, "2026-04-24T18:00:00Z");
        assert_eq!(events[0].end, "2026-04-24T18:50:00Z");
        assert!(!events[0].all_day);
        assert_eq!(events[0].location.as_deref(), Some("Zoom"));
        assert_eq!(events[0].organizer.as_deref(), Some("example.user@example.com"));
        assert_eq!(events[0].attendees, vec!["bob@example.com", "ian@example.com"]);
        assert_eq!(events[0].status.as_deref(), Some("confirmed"));
        assert!(events[0].description.as_deref().unwrap_or("").contains("\n"));

        assert!(events[1].all_day);
        assert_eq!(events[1].start, "2026-04-24T00:00:00Z");
        assert_eq!(events[1].end, "2026-04-25T00:00:00Z");
    }

    #[test]
    fn unfolds_continuation_lines() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Long\r\n  title that wraps\r\nDTSTART:20260101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse(text);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].summary, "Long title that wraps");
    }

    #[test]
    fn events_in_range_filters_inclusive() {
        let events = parse(SAMPLE);
        let same = events_in_range(&events, "2026-04-24", "2026-04-24");
        assert_eq!(same.len(), 2);
        let next = events_in_range(&events, "2026-04-25", "2026-04-25");
        // The all-day event ends at 04-25T00:00:00 (exclusive end), so
        // it should NOT appear in the 04-25 day range. The timed event
        // is on 04-24, so also out.
        assert_eq!(next.len(), 0);
        let prior = events_in_range(&events, "2026-04-23", "2026-04-23");
        assert_eq!(prior.len(), 0);
    }

    #[test]
    fn day_after_handles_month_rollover() {
        assert_eq!(day_after("2026-01-31"), "2026-02-01T00:00:00Z");
        assert_eq!(day_after("2026-12-31"), "2027-01-01T00:00:00Z");
        assert_eq!(day_after("2024-02-28"), "2024-02-29T00:00:00Z"); // leap
        assert_eq!(day_after("2025-02-28"), "2025-03-01T00:00:00Z");
    }

    #[test]
    fn missing_dtstart_is_dropped() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:no time\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse(text);
        assert_eq!(events.len(), 0);
    }
}
