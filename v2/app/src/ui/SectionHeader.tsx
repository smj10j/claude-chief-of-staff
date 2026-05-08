import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export type SectionHeaderProps = {
  /** Label shown as h3-size text. */
  label: ReactNode;
  /** Optional integer count rendered as a muted mono chip. */
  count?: number;
  /** Optional shortcut hint (e.g. "N", "T"). Caption-size, mono, muted chip. */
  shortcut?: string;
  /** When set, the header is a button that toggles `collapsed`. */
  collapsible?: boolean;
  /** Whether the section is currently collapsed (only meaningful with `collapsible`). */
  collapsed?: boolean;
  /** Click handler for the collapsible variant. */
  onToggle?: () => void;
  /** Optional trailing slot for actions/badges. */
  trailing?: ReactNode;
};

/**
 * Typographic section break for time-buckets, relationship groups, status columns.
 * Replaces bordered card headers — h3 type, optional count + shortcut hint.
 * PRD-115 §5 principle 6 ("typography does the heavy lifting").
 */
export function SectionHeader({
  label,
  count,
  shortcut,
  collapsible,
  collapsed,
  onToggle,
  trailing,
}: SectionHeaderProps) {
  const className = [
    "cos-section-header",
    collapsible ? "is-collapsible" : "",
    collapsed ? "is-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const inner = (
    <>
      <span className="cos-section-header-label">{label}</span>
      {count !== undefined ? (
        <span className="cos-section-header-count">{count}</span>
      ) : null}
      {shortcut ? (
        <kbd className="cos-section-header-shortcut">{shortcut}</kbd>
      ) : null}
      {trailing ? <span style={{ marginLeft: "auto" }}>{trailing}</span> : null}
      {collapsible ? (
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className="cos-section-header-chevron"
          aria-hidden
        />
      ) : null}
    </>
  );

  if (collapsible) {
    return (
      <button
        type="button"
        className={className}
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        {inner}
      </button>
    );
  }

  return <h3 className={className}>{inner}</h3>;
}
