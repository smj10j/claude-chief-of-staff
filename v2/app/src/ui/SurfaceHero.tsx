import type { ReactNode } from "react";

export type SurfaceHeroProps = {
  /** Display-type title shown at the top of a surface (Home greeting, person name). */
  title: ReactNode;
  /** Optional one-line subtitle below the title. Body-lg, secondary color. */
  subtitle?: ReactNode;
  /** Optional right-side actions (buttons, pills). Always keyboard-reachable. */
  actions?: ReactNode;
  /** Drop to h1-size when the surface needs a quieter hero. */
  compact?: boolean;
  /** Optional id for accessibility (h1 labelling). */
  titleId?: string;
};

/**
 * Surface-level hero — display-type title and optional subtitle/actions.
 * Used by Home, Work, People, Meetings, Projects, Person Profile, Settings.
 * One per surface. PRD-115 §5 principle 1 ("lead with one thing").
 */
export function SurfaceHero({
  title,
  subtitle,
  actions,
  compact,
  titleId,
}: SurfaceHeroProps) {
  return (
    <header
      className={`cos-surface-hero${compact ? " cos-surface-hero--compact" : ""}`}
    >
      <div className="cos-surface-hero-text">
        <h1 id={titleId} className="cos-surface-hero-title">
          {title}
        </h1>
        {subtitle ? (
          <p className="cos-surface-hero-subtitle">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="cos-surface-hero-actions">{actions}</div>
      ) : null}
    </header>
  );
}
