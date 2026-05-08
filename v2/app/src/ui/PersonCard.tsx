import type { ReactNode } from "react";

export type PersonCardProps = {
  name: string;
  role?: string;
  /** Optional avatar image URL. If omitted, initials render in a tinted circle. */
  avatarSrc?: string;
  /** Used as fallback when `avatarSrc` is missing. Caller may compute or just pass first letter. */
  initials?: string;
  /** Pre-formatted last-touched chip ("3d", "2w", "—"). */
  lastTouched?: string;
  /** Treat last-touched as stale (warning color). */
  stale?: boolean;
  /** Highlight as needing the user's attention (overdue 1:1, no prep, etc). */
  attention?: boolean;
  /** Optional action chips rendered below the body row (Prep, DM, etc). */
  actions?: ReactNode;
  onOpen?: () => void;
};

/**
 * Avatar + name + role + last-touched indicator card.
 * Used by People (direct-reports grid) and Person Profile (related people).
 * PRD-115 §6.3, §5 principle 4 (People is relational).
 */
export function PersonCard({
  name,
  role,
  avatarSrc,
  initials,
  lastTouched,
  stale,
  attention,
  actions,
  onOpen,
}: PersonCardProps) {
  const fallbackInitials = initials ?? name.slice(0, 2).toUpperCase();
  const className = [
    "cos-person-card",
    attention ? "is-attention" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={className}
      onClick={onOpen}
      aria-label={`Open ${name}`}
    >
      <div className="cos-person-card-avatar" aria-hidden>
        {avatarSrc ? (
          <img src={avatarSrc} alt="" />
        ) : (
          <span>{fallbackInitials}</span>
        )}
      </div>
      <div className="cos-person-card-body">
        <span className="cos-person-card-name">{name}</span>
        {role ? <span className="cos-person-card-role">{role}</span> : null}
      </div>
      {lastTouched ? (
        <span
          className={`cos-person-card-touched${stale ? " is-stale" : ""}`}
          style={{ gridColumn: "2", justifySelf: "end" }}
        >
          {lastTouched}
        </span>
      ) : null}
      {actions ? (
        <div className="cos-person-card-actions">{actions}</div>
      ) : null}
    </button>
  );
}
