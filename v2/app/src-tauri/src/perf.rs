//! Lightweight perf logger. PRD-101 calls for view-switch /
//! palette-open / editor-input timings to gate "no regression" claims.
//! This module is the storage tier — a fixed-size in-memory ring of
//! recorded samples, persisted to a small JSON file on each write so a
//! crash doesn't lose the run history. Reads from JSON on startup.
//!
//! Design choices kept deliberately small:
//!   - No daemon, no async writer. The set is small (default 256
//!     entries) and writes happen on user-driven IPC calls, so
//!     synchronous fs::write won't block anything user-perceptible.
//!   - One file: `<app_data>/perf.json`. Trivial to inspect by hand.
//!   - Frontend records its own timings (the only side that knows
//!     when "view-switch" started); we just store them.
//!
//! Numbers are stored as `duration_ms` (f64) because the frontend
//! emits via `performance.now()` which is sub-millisecond precision.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// One recorded sample. `kind` is free-text but the frontend uses a
/// small fixed set: "view-switch", "palette-open", "editor-input",
/// "ipc". The verbose `meta` field is JSON the caller can store
/// (which IPC, which surface, etc.) — we don't interpret it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PerfSample {
    pub kind: String,
    pub duration_ms: f64,
    /// Wall-clock ISO-8601 UTC timestamp when the sample was recorded
    /// on the frontend. Used by the Diagnostics panel to plot trends.
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// Aggregate summary for one `kind` bucket — used by the Diagnostics
/// panel (and PRD-115 success-criterion #8) to read "p99 < 50ms" at a
/// glance. p50 / p95 / p99 are computed from the in-memory ring on
/// demand; we don't pre-aggregate.
#[derive(Serialize, Clone, Debug)]
pub struct PerfSummary {
    pub kind: String,
    pub count: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    /// Most-recent N samples for the panel's mini-list. Frontend caps
    /// the rendered list separately; this just bounds the payload size.
    pub recent: Vec<PerfSample>,
}

const RING_CAP: usize = 256;

pub struct PerfLog {
    path: PathBuf,
    samples: Mutex<VecDeque<PerfSample>>,
}

impl PerfLog {
    /// Open or create the perf log under `<app_data>/perf.json`.
    /// Missing file = empty log; malformed JSON also = empty log
    /// (no point preventing the app from running over a bad cache).
    pub fn open(app_data_dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join("perf.json");
        let samples = if path.is_file() {
            match fs::read_to_string(&path) {
                Ok(body) => serde_json::from_str::<VecDeque<PerfSample>>(&body)
                    .unwrap_or_default(),
                Err(_) => VecDeque::new(),
            }
        } else {
            VecDeque::new()
        };
        Ok(Self {
            path,
            samples: Mutex::new(samples),
        })
    }

    pub fn record(&self, sample: PerfSample) -> AppResult<()> {
        let mut g = self.samples.lock().map_err(|_| AppError::Poisoned)?;
        g.push_back(sample);
        while g.len() > RING_CAP {
            g.pop_front();
        }
        let snapshot: Vec<PerfSample> = g.iter().cloned().collect();
        drop(g);
        // Persist outside the lock so a slow disk doesn't pin
        // recorders. The race window is tiny — last write wins, which
        // is fine for a perf log.
        let body = serde_json::to_string(&snapshot)?;
        fs::write(&self.path, body)?;
        Ok(())
    }

    /// Group samples by kind, return one summary per kind sorted by
    /// kind name for deterministic UI rendering.
    pub fn summaries(&self, recent_per_kind: usize) -> AppResult<Vec<PerfSummary>> {
        let g = self.samples.lock().map_err(|_| AppError::Poisoned)?;
        let mut by_kind: std::collections::BTreeMap<String, Vec<PerfSample>> =
            std::collections::BTreeMap::new();
        for s in g.iter() {
            by_kind.entry(s.kind.clone()).or_default().push(s.clone());
        }
        drop(g);

        let mut out: Vec<PerfSummary> = Vec::new();
        for (kind, mut samples) in by_kind {
            // Sort durations ascending for percentile picks, but keep
            // the recent list time-ordered (insertion order).
            let mut durations: Vec<f64> =
                samples.iter().map(|s| s.duration_ms).collect();
            durations.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let p = |frac: f64| -> f64 {
                if durations.is_empty() {
                    return 0.0;
                }
                let idx = ((durations.len() as f64) * frac)
                    .ceil() as usize;
                let idx = idx.saturating_sub(1).min(durations.len() - 1);
                durations[idx]
            };

            // recent: last N in time-order — VecDeque iter order is
            // already chronological. Keep that.
            let take_n = recent_per_kind.min(samples.len());
            let recent_idx_start = samples.len() - take_n;
            let recent = samples.split_off(recent_idx_start);

            out.push(PerfSummary {
                kind,
                count: durations.len(),
                p50_ms: p(0.50),
                p95_ms: p(0.95),
                p99_ms: p(0.99),
                recent,
            });
        }
        Ok(out)
    }

    pub fn clear(&self) -> AppResult<()> {
        let mut g = self.samples.lock().map_err(|_| AppError::Poisoned)?;
        g.clear();
        drop(g);
        if self.path.is_file() {
            let _ = fs::remove_file(&self.path);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample(kind: &str, ms: f64) -> PerfSample {
        PerfSample {
            kind: kind.into(),
            duration_ms: ms,
            at: "2026-04-25T10:00:00Z".into(),
            meta: None,
        }
    }

    #[test]
    fn record_persists_and_round_trips() {
        let tmp = TempDir::new().unwrap();
        {
            let log = PerfLog::open(tmp.path()).unwrap();
            log.record(sample("view-switch", 12.5)).unwrap();
            log.record(sample("view-switch", 18.0)).unwrap();
        }
        // Re-open: data should survive.
        let reopened = PerfLog::open(tmp.path()).unwrap();
        let summaries = reopened.summaries(10).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].kind, "view-switch");
        assert_eq!(summaries[0].count, 2);
    }

    #[test]
    fn ring_caps_at_RING_CAP() {
        let tmp = TempDir::new().unwrap();
        let log = PerfLog::open(tmp.path()).unwrap();
        for i in 0..(RING_CAP + 50) {
            log.record(sample("ipc", i as f64)).unwrap();
        }
        let summaries = log.summaries(5).unwrap();
        assert_eq!(summaries[0].count, RING_CAP);
        // Oldest ones are dropped — first sample remaining should be
        // the (50)th we pushed (since we dropped the first 50).
        let recents = &summaries[0].recent;
        assert_eq!(recents.len(), 5);
        // Last recorded duration was RING_CAP+49.
        assert_eq!(
            recents.last().unwrap().duration_ms,
            (RING_CAP + 49) as f64,
        );
    }

    #[test]
    fn summaries_compute_percentiles() {
        let tmp = TempDir::new().unwrap();
        let log = PerfLog::open(tmp.path()).unwrap();
        for i in 1..=100 {
            log.record(sample("editor-input", i as f64)).unwrap();
        }
        let summaries = log.summaries(3).unwrap();
        let s = &summaries[0];
        // 100 samples 1..100. p50 ~= 50, p95 ~= 95, p99 ~= 99.
        assert!((s.p50_ms - 50.0).abs() < 1.5, "p50={}", s.p50_ms);
        assert!((s.p95_ms - 95.0).abs() < 1.5, "p95={}", s.p95_ms);
        assert!((s.p99_ms - 99.0).abs() < 1.5, "p99={}", s.p99_ms);
        // Recent picks the last 3 in time-order (98, 99, 100).
        let recent_durations: Vec<f64> =
            s.recent.iter().map(|x| x.duration_ms).collect();
        assert_eq!(recent_durations, vec![98.0, 99.0, 100.0]);
    }

    #[test]
    fn clear_empties_log_and_removes_file() {
        let tmp = TempDir::new().unwrap();
        let log = PerfLog::open(tmp.path()).unwrap();
        log.record(sample("ipc", 1.0)).unwrap();
        assert!(tmp.path().join("perf.json").is_file());
        log.clear().unwrap();
        assert!(!tmp.path().join("perf.json").is_file());
        assert!(log.summaries(5).unwrap().is_empty());
    }

    #[test]
    fn malformed_json_yields_empty_log_not_error() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("perf.json"), "{not valid json").unwrap();
        let log = PerfLog::open(tmp.path()).unwrap();
        assert!(log.summaries(5).unwrap().is_empty());
    }
}
