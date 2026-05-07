/**
 * Epic health (PRD-110 §3 #2 / B8-CP25).
 *
 * Three inputs, one output. Pure so the Roadmap UI can render the
 * dot without an extra round-trip and the test pins the policy.
 */

export type EpicHealthInput = {
  tickets_total?: number;
  tickets_done?: number;
  tickets_blocked?: number;
  due?: string | null;
  updated?: string;
};

export type EpicHealth = "green" | "amber" | "red" | "unknown";

export function epicHealth(
  e: EpicHealthInput,
  now: number = Date.now(),
): EpicHealth {
  // No data → unknown. Keep this honest; do not pretend an epic
  // without tickets is green.
  const total = e.tickets_total ?? 0;
  if (total === 0 && !e.due) return "unknown";

  // Red conditions:
  //   - any blocked tickets
  //   - past due date
  //   - no update in 21 days
  const updateAgeDays = e.updated ? daysSince(e.updated, now) : 0;
  if ((e.tickets_blocked ?? 0) > 0) return "red";
  if (e.due && Date.parse(e.due) < now) return "red";
  if (e.updated && updateAgeDays > 21) return "red";

  // Amber:
  //   - <70% done with due in <14 days
  //   - no update in 14 days
  //   - <30% done in general
  const pctDone = total > 0 ? (e.tickets_done ?? 0) / total : 1;
  const dueSoon =
    e.due && Date.parse(e.due) - now < 14 * 24 * 60 * 60 * 1000;
  if (dueSoon && pctDone < 0.7) return "amber";
  if (e.updated && updateAgeDays > 14) return "amber";
  if (total > 0 && pctDone < 0.3) return "amber";

  // Otherwise green.
  return "green";
}

/** Stale-epic flag (B8-CP27). >14 days no activity. */
export function isEpicStale(updated?: string, now: number = Date.now()): boolean {
  if (!updated) return false;
  return daysSince(updated, now) >= 14;
}

function daysSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (now - t) / (1000 * 60 * 60 * 24);
}
