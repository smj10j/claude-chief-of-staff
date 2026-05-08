import { useEffect, useState, type ReactNode } from "react";

import { SectionHeader } from "./SectionHeader";

export type TimeBucketTone =
  | "overdue"
  | "today"
  | "this-week"
  | "soon"
  | "someday";

export type TimeBucketProps = {
  /** Bucket label — "Now", "This week", "Soon", "Someday". */
  label: string;
  /** Number of items in the bucket; renders as a count chip. */
  count?: number;
  /** Tone drives background tint via PRD-115 §7.3 time-aware tokens. */
  tone?: TimeBucketTone;
  /** Optional shortcut hint passed through to SectionHeader. */
  shortcut?: string;
  /** Whether the bucket is collapsed by default (e.g., "Someday"). */
  defaultCollapsed?: boolean;
  /** When toggled true, force-expand the bucket. Lets callers reveal a
   *  default-collapsed bucket programmatically (e.g., after a task is
   *  created in Someday). The user can still re-collapse afterward. */
  forceExpand?: boolean;
  /** Optional empty-state copy when `children` is empty. */
  emptyLabel?: string;
  children?: ReactNode;
};

/**
 * Labeled, time-toned task bucket — the core layout unit of the redesigned Work surface.
 * Wraps SectionHeader with a tinted body container; defaults to expanded.
 * PRD-115 §6.2 ("time-bucket layout"); §5 principle 3 (time visual grammar).
 */
export function TimeBucket({
  label,
  count,
  tone = "this-week",
  shortcut,
  defaultCollapsed,
  forceExpand,
  emptyLabel = "Empty.",
  children,
}: TimeBucketProps) {
  const [collapsed, setCollapsed] = useState(Boolean(defaultCollapsed));
  // When the caller flips forceExpand on, open the bucket. Going back
  // to false leaves the user-chosen state alone (no auto-recollapse).
  useEffect(() => {
    if (forceExpand) setCollapsed(false);
  }, [forceExpand]);
  const isEmpty =
    children === null ||
    children === undefined ||
    (Array.isArray(children) && children.length === 0);

  return (
    <section
      className={`cos-time-bucket tone-${tone}${
        collapsed ? " is-collapsed" : ""
      }`}
    >
      <SectionHeader
        label={label}
        count={count}
        shortcut={shortcut}
        collapsible
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
      />
      <div className="cos-time-bucket-body">
        {isEmpty ? (
          <div className="cos-time-bucket-empty">{emptyLabel}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
