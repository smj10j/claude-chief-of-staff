import {
  PersonCard,
  SectionHeader,
  SnippetCard,
  SurfaceHero,
  TimeBucket,
  TimelineStrip,
} from "./index";

/**
 * Dev-only catalog of the six PRD-115 §7.5 primitives.
 * Reachable via the URL hash `#/catalog`. Not wired into the sidebar.
 *
 * Each primitive renders with realistic-shaped data so design and
 * visual-regression checks have a stable target. This component is
 * intentionally simple — no state management, no IPC, no plumbing.
 */
export function Catalog() {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const at = (h: number, m = 0) => {
    const d = new Date(today);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  return (
    <div className="cos-home" style={{ padding: "var(--cos-space-2xl)" }}>
      <SurfaceHero
        title="Component catalog"
        subtitle="Six primitives that the redesigned surfaces consume — PRD-115 §7.5."
        actions={
          <code className="cos-mount" style={{ fontSize: 11 }}>
            ui.catalog
          </code>
        }
      />

      <section style={{ marginBottom: "var(--cos-space-3xl)" }}>
        <SectionHeader label="SurfaceHero" count={2} shortcut="H" />
        <p
          style={{
            color: "var(--cos-content-muted)",
            fontSize: "var(--cos-font-caption)",
            margin: "0 0 var(--cos-space-sm)",
          }}
        >
          Compact variant:
        </p>
        <SurfaceHero
          compact
          title="Compact title"
          subtitle="Used when the surface needs a quieter hero."
        />
      </section>

      <section style={{ marginBottom: "var(--cos-space-3xl)" }}>
        <SectionHeader label="TimelineStrip" count={4} shortcut="T" />
        <TimelineStrip
          events={[
            {
              id: "1",
              start: at(9),
              end: at(9, 30),
              label: "Alice 1:1",
              tone: "own",
            },
            {
              id: "2",
              start: at(11),
              end: at(11, 30),
              label: "Payments XFN sync",
              tone: "own",
            },
            {
              id: "3",
              start: at(13, 30),
              end: at(14),
              label: "Cross-team hiring sync — needs prep",
              tone: "needs-prep",
            },
            {
              id: "4",
              start: at(16),
              end: at(16, 30),
              label: "Skip-level (declined)",
              tone: "declined",
            },
          ]}
        />
      </section>

      <section style={{ marginBottom: "var(--cos-space-3xl)" }}>
        <SectionHeader label="PersonCard" count={3} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "var(--cos-space-md)",
          }}
        >
          <PersonCard
            name="Alice Wong"
            role="EM, Payments Core"
            initials="AS"
            lastTouched="3d"
          />
          <PersonCard
            name="Carol Lee"
            role="EM, Payments Growth"
            initials="PK"
            lastTouched="2w"
            stale
          />
          <PersonCard
            name="Dan Smith"
            role="EM, At Work / AtWork"
            initials="JS"
            lastTouched="—"
            attention
          />
        </div>
      </section>

      <section style={{ marginBottom: "var(--cos-space-3xl)" }}>
        <SectionHeader label="SnippetCard" count={2} />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: "var(--cos-space-md)",
          }}
        >
          <SnippetCard
            date={todayIso}
            relative="today"
            followUps={[
              { text: "Share growth plan doc", done: false },
              { text: "Confirm CB Sweep 2.0 launch date", done: true },
            ]}
          />
          <SnippetCard
            date="2026-04-17"
            relative="7 days ago"
            followUps={[
              { text: "Higher Limits fairness analysis", done: false },
              { text: "Albert onboarding plan", done: true },
            ]}
          />
        </div>
      </section>

      <section style={{ marginBottom: "var(--cos-space-3xl)" }}>
        <SectionHeader label="TimeBucket" count={4} />
        <div style={{ display: "grid", gap: "var(--cos-space-md)" }}>
          <TimeBucket label="Now" tone="overdue" count={3} shortcut="N">
            <div style={{ padding: "var(--cos-space-xs) 0" }}>
              <span style={{ color: "var(--cos-content-secondary)" }}>
                Bob leadership shift response
              </span>
            </div>
            <div style={{ padding: "var(--cos-space-xs) 0" }}>
              <span style={{ color: "var(--cos-content-secondary)" }}>
                AI staffing plan for the VP
              </span>
            </div>
            <div style={{ padding: "var(--cos-space-xs) 0" }}>
              <span style={{ color: "var(--cos-content-secondary)" }}>
                Aaron transition doc review
              </span>
            </div>
          </TimeBucket>
          <TimeBucket label="This week" tone="today" count={5} shortcut="W">
            <div style={{ padding: "var(--cos-space-xs) 0" }}>
              <span style={{ color: "var(--cos-content-secondary)" }}>
                Payments Eng Leadership prep
              </span>
            </div>
          </TimeBucket>
          <TimeBucket label="Soon" tone="soon" count={8} shortcut="S">
            <div style={{ padding: "var(--cos-space-xs) 0" }}>
              <span style={{ color: "var(--cos-content-secondary)" }}>
                Q2 capacity proposal
              </span>
            </div>
          </TimeBucket>
          <TimeBucket
            label="Someday"
            tone="someday"
            count={12}
            defaultCollapsed
          />
        </div>
      </section>
    </div>
  );
}
