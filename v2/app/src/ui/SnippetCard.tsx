export type SnippetFollowUp = {
  text: string;
  done: boolean;
};

export type SnippetCardProps = {
  /** Date of the session — display as YYYY-MM-DD or human-readable. */
  date: string;
  /** Optional relative-date helper ("today", "3d ago"). */
  relative?: string;
  /** Top 1–2 follow-ups to surface. Caller should slice the list. */
  followUps?: SnippetFollowUp[];
  onOpen?: () => void;
};

/**
 * Compact session snippet — date + top follow-ups + open link.
 * Used by Person Profile (recent sessions list).
 * PRD-115 §6.4 ("sessions as snippet cards").
 */
export function SnippetCard({
  date,
  relative,
  followUps,
  onOpen,
}: SnippetCardProps) {
  return (
    <button type="button" className="cos-snippet-card" onClick={onOpen}>
      <div className="cos-snippet-card-head">
        <span className="cos-snippet-card-date">{date}</span>
        {relative ? (
          <span className="cos-snippet-card-relative">{relative}</span>
        ) : null}
      </div>
      {followUps && followUps.length > 0 ? (
        <ul className="cos-snippet-card-followups">
          {followUps.map((followUp, i) => (
            <li
              key={i}
              className={`cos-snippet-card-followup ${
                followUp.done ? "is-done" : "is-open"
              }`}
            >
              <span className="cos-snippet-card-followup-marker" aria-hidden>
                {followUp.done ? "✓" : "○"}
              </span>
              <span>{followUp.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </button>
  );
}
