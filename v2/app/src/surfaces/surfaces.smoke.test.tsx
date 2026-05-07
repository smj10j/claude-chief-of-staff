/**
 * Surface smoke tests — render every top-level surface in each major
 * state and assert it doesn't crash + key affordances appear. The
 * primary thing this catches is hooks-order regressions where an
 * early `return` is added between hook calls; React doesn't throw
 * until the component re-renders into the alternate state, which is
 * easy to miss in dev but breaks the app for the user.
 *
 * These are intentionally minimal — full interaction tests live in
 * dedicated files. The goal here is *every surface boots in every
 * meaningful state*.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resetInvokeMock,
  setInvokeHandlers,
} from "../test/invokeMock";
import { Calendar } from "./Calendar";
import { Meetings } from "./Meetings";
import { Ops } from "./Ops";
import { People } from "./People";
import { PersonProfile, type ProfileTarget } from "./PersonProfile";
import { Projects } from "./Projects";
import { ProjectDetail, type ProjectTarget } from "./ProjectDetail";
import { MeetingDetail, type MeetingTarget } from "./MeetingDetail";
import { type MeetingRef } from "./Meetings";

const PROJECT: ProjectTarget = {
  slug: "demo-project",
  label: "Demo Project",
  rel_path: "projects/demo-project",
};

const MEETING: MeetingTarget = {
  slug: "demo-meeting",
  label: "Demo Meeting",
  rel_path: "areas/meetings/demo-meeting",
};

const PERSON: ProfileTarget = {
  slug: "aaron",
  label: "Aaron Demo",
  rel_path: "areas/one-on-ones/peers/aaron",
};

const NOOP = () => undefined;
const NOOP_DOC = NOOP;

beforeEach(() => {
  resetInvokeMock();
});
afterEach(() => {
  resetInvokeMock();
});

describe("Meetings surface", () => {
  it("renders the list mode without a profile", async () => {
    setInvokeHandlers({
      content_list_meetings: (): MeetingRef[] => [
        {
          slug: MEETING.slug,
          label: MEETING.label,
          rel_path: MEETING.rel_path,
          has_readme: true,
          session_count: 2,
          last_session: "2026-04-25",
        },
      ],
    });
    render(
      <Meetings
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToMeeting={NOOP}
        onClearMeeting={NOOP}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: /recurring meetings/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(MEETING.label)).toBeInTheDocument();
  });

  it("renders the detail mode when a profile is set", async () => {
    setInvokeHandlers({
      content_list_meetings: () => [],
      content_list_sessions: () => [],
      content_read_file: () => ({
        rel_path: `${MEETING.rel_path}/README.md`,
        markdown: "# Demo Meeting README",
      }),
    });
    render(
      <Meetings
        onOpenDoc={NOOP_DOC}
        profile={MEETING}
        onGoToMeeting={NOOP}
        onClearMeeting={NOOP}
      />,
    );
    // Hero shows the meeting label
    expect(
      await screen.findByRole("heading", { name: MEETING.label }),
    ).toBeInTheDocument();
  });

  // This is the regression that triggered the test suite — switching
  // between detail and list modes must not change hook count.
  it("survives the detail → list transition without crashing", async () => {
    setInvokeHandlers({
      content_list_meetings: () => [],
      content_list_sessions: () => [],
      content_read_file: () => ({
        rel_path: `${MEETING.rel_path}/README.md`,
        markdown: "# x",
      }),
    });
    const { rerender } = render(
      <Meetings
        onOpenDoc={NOOP_DOC}
        profile={MEETING}
        onGoToMeeting={NOOP}
        onClearMeeting={NOOP}
      />,
    );
    rerender(
      <Meetings
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToMeeting={NOOP}
        onClearMeeting={NOOP}
      />,
    );
    rerender(
      <Meetings
        onOpenDoc={NOOP_DOC}
        profile={MEETING}
        onGoToMeeting={NOOP}
        onClearMeeting={NOOP}
      />,
    );
  });

  it("shows empty-state copy when no meetings exist", async () => {
    setInvokeHandlers({ content_list_meetings: () => [] });
    render(
      <Meetings
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToMeeting={NOOP}
        onClearMeeting={NOOP}
      />,
    );
    expect(await screen.findByText(/no meetings yet/i)).toBeInTheDocument();
  });
});

describe("Projects surface", () => {
  it("renders the list mode", async () => {
    setInvokeHandlers({
      content_list_project_refs: () => [
        {
          slug: PROJECT.slug,
          label: PROJECT.label,
          rel_path: PROJECT.rel_path,
          has_readme: true,
          extra_md_count: 0,
          last_touched: "2026-04-25",
        },
      ],
      content_project_status: () => [],
    });
    render(
      <Projects
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToProject={NOOP}
        onClearProject={NOOP}
      />,
    );
    expect(await screen.findByText(PROJECT.label)).toBeInTheDocument();
  });

  it("renders the detail mode when a profile is set", async () => {
    setInvokeHandlers({
      content_list_project_refs: () => [],
      content_project_status: () => [],
      content_list_project_files: () => [],
      content_read_file: () => ({
        rel_path: `${PROJECT.rel_path}/README.md`,
        markdown: "# x",
      }),
    });
    render(
      <Projects
        onOpenDoc={NOOP_DOC}
        profile={PROJECT}
        onGoToProject={NOOP}
        onClearProject={NOOP}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: PROJECT.label }),
    ).toBeInTheDocument();
  });

  it("survives the detail → list transition without crashing", async () => {
    setInvokeHandlers({
      content_list_project_refs: () => [],
      content_project_status: () => [],
      content_list_project_files: () => [],
      content_read_file: () => ({ rel_path: "x", markdown: "# x" }),
    });
    const { rerender } = render(
      <Projects
        onOpenDoc={NOOP_DOC}
        profile={PROJECT}
        onGoToProject={NOOP}
        onClearProject={NOOP}
      />,
    );
    rerender(
      <Projects
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToProject={NOOP}
        onClearProject={NOOP}
      />,
    );
    rerender(
      <Projects
        onOpenDoc={NOOP_DOC}
        profile={PROJECT}
        onGoToProject={NOOP}
        onClearProject={NOOP}
      />,
    );
  });
});

describe("Calendar surface", () => {
  it("renders without a configured calendar source", async () => {
    setInvokeHandlers({
      calendar_config_get: () => ({ ics_url: "", transport: "ics" }),
    });
    render(
      <Calendar
        onOpenDoc={NOOP_DOC}
        onGoToMeeting={NOOP}
        onGoToProfile={NOOP}
      />,
    );
    // The "configure in Settings" button only appears in the empty
    // state. Asserting on it (rather than the not-configured text,
    // which also shows up as the hero subtitle) keeps the matcher
    // unambiguous.
    expect(
      await screen.findByRole("button", { name: /configure in settings/i }),
    ).toBeInTheDocument();
  });

  it("renders an empty 7-day window without crashing", async () => {
    setInvokeHandlers({
      calendar_config_get: () => ({
        ics_url: "https://example.com/cal.ics",
        transport: "ics",
      }),
      calendar_events: () => [],
    });
    render(
      <Calendar
        onOpenDoc={NOOP_DOC}
        onGoToMeeting={NOOP}
        onGoToProfile={NOOP}
      />,
    );
    expect(
      await screen.findByText(/no events in the next 7 days/i),
    ).toBeInTheDocument();
  });
});

describe("ProjectDetail surface (stand-alone)", () => {
  it("renders the README when present, including the lazy MarkdownView", async () => {
    setInvokeHandlers({
      content_list_project_files: () => [],
      content_read_file: () => ({
        rel_path: `${PROJECT.rel_path}/README.md`,
        markdown: "# Hello world",
      }),
    });
    render(
      <ProjectDetail
        target={PROJECT}
        onOpenDoc={NOOP_DOC}
        onBack={NOOP}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: PROJECT.label }),
    ).toBeInTheDocument();
    // Force the lazy MarkdownView to render — same rationale as
    // PersonProfile, this catches errors that would otherwise be
    // hidden inside an unresolved Suspense fallback.
    expect(
      await screen.findByRole("heading", { name: /hello world/i }),
    ).toBeInTheDocument();
  });

  it("renders the missing-README empty state without crashing", async () => {
    setInvokeHandlers({
      content_list_project_files: () => [],
      content_read_file: () => {
        throw new Error("ENOENT");
      },
    });
    render(
      <ProjectDetail
        target={PROJECT}
        onOpenDoc={NOOP_DOC}
        onBack={NOOP}
      />,
    );
    expect(
      await screen.findByText(/no readme yet/i),
    ).toBeInTheDocument();
  });
});

describe("People surface", () => {
  it("renders the directory list without a profile", async () => {
    setInvokeHandlers({
      content_list_people: () => [
        {
          slug: PERSON.slug,
          label: PERSON.label,
          rel_path: PERSON.rel_path,
          relationship: "peers",
          has_readme: true,
          session_count: 3,
          last_session: "2026-04-25",
        },
      ],
      content_attention_people: () => [],
      org_load: () => ({ views: [] }),
    });
    render(
      <People
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToProfile={NOOP}
        onClearProfile={NOOP}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: /people/i }),
    ).toBeInTheDocument();
  });

  it("renders the profile detail when a profile is set", async () => {
    setInvokeHandlers({
      content_list_people: () => [],
      content_attention_people: () => [],
      org_load: () => ({ views: [] }),
      content_person_profile: () => ({
        rel_path: PERSON.rel_path,
        readme: "# Aaron README",
        sessions: [
          {
            date: "2026-04-25",
            rel_path: `${PERSON.rel_path}/sessions/2026-04-25.md`,
          },
        ],
        meta: { title: "Demo title", email: null, photo_url: null, slack_url: null },
      }),
    });
    render(
      <People
        onOpenDoc={NOOP_DOC}
        profile={PERSON}
        onGoToProfile={NOOP}
        onClearProfile={NOOP}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: PERSON.label }),
    ).toBeInTheDocument();
  });

  it("renders search hits with photo/initials and surfaces the sort dropdown", async () => {
    // Smoke test for B7-CP15: typing in the search filter shows hits
    // with the new richer card layout, AND the sort select is mounted.
    // We assert the dropdown's options as a contract — adding a 4th
    // sort mode later requires updating this test.
    const { fireEvent } = await import("@testing-library/react");
    setInvokeHandlers({
      content_list_people: () => [
        {
          slug: "alice",
          label: "Alice",
          relationship: "direct-reports",
          rel_path: "areas/one-on-ones/direct-reports/alice",
          has_readme: true,
          session_count: 12,
          last_session: "2026-04-25",
          title: "EM, Payments Core",
          photo_url: null,
        },
        {
          slug: "bob",
          label: "Bob",
          relationship: "manager",
          rel_path: "areas/one-on-ones/manager/bob",
          has_readme: true,
          session_count: 30,
          last_session: "2026-04-22",
          title: null,
          photo_url: null,
        },
      ],
      content_attention_people: () => [],
      org_load: () => ({ views: [] }),
    });
    render(
      <People
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToProfile={NOOP}
        onClearProfile={NOOP}
      />,
    );
    const input = await screen.findByLabelText(/Filter people by name/i);
    fireEvent.change(input, { target: { value: "a" } });
    // "a" matches Alice only; Bob is irrelevant here. The point
    // is to land in search-active mode so the sort dropdown mounts.
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    // Alice's title shows as the subtitle (people gain title via
    // person.json — null fallback uses humanized relationship).
    expect(
      await screen.findByText(/EM, Payments Core/),
    ).toBeInTheDocument();
    // Sort dropdown is mounted and offers all three modes.
    const sortSelect = screen.getByLabelText(/Sort search results/i);
    expect(sortSelect).toBeInTheDocument();
    const options = Array.from(
      (sortSelect as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(["last", "name", "staleness"]);
  });

  it("survives the directory → profile → directory transition", async () => {
    setInvokeHandlers({
      content_list_people: () => [],
      content_attention_people: () => [],
      org_load: () => ({ views: [] }),
      content_person_profile: () => ({
        rel_path: PERSON.rel_path,
        readme: null,
        sessions: [],
        meta: null,
      }),
    });
    const { rerender } = render(
      <People
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToProfile={NOOP}
        onClearProfile={NOOP}
      />,
    );
    rerender(
      <People
        onOpenDoc={NOOP_DOC}
        profile={PERSON}
        onGoToProfile={NOOP}
        onClearProfile={NOOP}
      />,
    );
    rerender(
      <People
        onOpenDoc={NOOP_DOC}
        profile={null}
        onGoToProfile={NOOP}
        onClearProfile={NOOP}
      />,
    );
  });
});

describe("PersonProfile surface (stand-alone)", () => {
  it("renders the README when present, including the lazy MarkdownView", async () => {
    setInvokeHandlers({
      content_person_profile: () => ({
        rel_path: PERSON.rel_path,
        readme: "# Hello there",
        sessions: [],
        meta: null,
      }),
    });
    render(
      <PersonProfile
        target={PERSON}
        onOpenDoc={NOOP_DOC}
        onBack={NOOP}
      />,
    );
    // Hero appears synchronously
    expect(
      await screen.findByRole("heading", { name: PERSON.label }),
    ).toBeInTheDocument();
    // README content is lazy-loaded via Suspense + lazy(MarkdownView).
    // Asserting on the README's rendered heading exercises the full
    // lazy-load path — this is what catches errors inside MarkdownView
    // that would otherwise show as an unbounded "..." Suspense fallback.
    expect(
      await screen.findByRole("heading", { name: /hello there/i }),
    ).toBeInTheDocument();
  });

  it("renders the missing-README empty state without crashing", async () => {
    setInvokeHandlers({
      content_person_profile: () => ({
        rel_path: PERSON.rel_path,
        readme: null,
        sessions: [],
        meta: null,
      }),
    });
    render(
      <PersonProfile
        target={PERSON}
        onOpenDoc={NOOP_DOC}
        onBack={NOOP}
      />,
    );
    expect(
      await screen.findByText(/no readme yet/i),
    ).toBeInTheDocument();
  });
});

describe("Ops surface (B8-CP14/15/17, B9-CP5)", () => {
  it("boots with no MCPs registered and shows a degraded state", async () => {
    setInvokeHandlers({
      claude_mcp_list: () => [],
      ops_incidents_read: () => ({ fetched_at: null, incidents: [] }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
      paging_status: () => ({ provider: "pagerduty", has_token: false, whoami: null }),
      paging_oncall_now: () => [],
    });
    render(<Ops />);
    expect(
      await screen.findByRole("heading", { name: /ops/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: /active incidents/i }),
    ).toBeInTheDocument();
  });

  it("On-call tab degrades cleanly when no PD token is configured", async () => {
    sessionStorage.setItem("cos:ops-tab", "oncall");
    setInvokeHandlers({
      claude_mcp_list: () => [],
      ops_incidents_read: () => ({ fetched_at: null, incidents: [] }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
      paging_status: () => ({ provider: "pagerduty", has_token: false, whoami: null }),
      paging_oncall_now: () => [],
    });
    render(<Ops />);
    expect(
      await screen.findByText(/no pagerduty token configured/i),
    ).toBeInTheDocument();
    sessionStorage.removeItem("cos:ops-tab");
  });

  it("On-call tab splits 'My teams' vs 'Other teams' using opsPrefs keywords (B9-CP41)", async () => {
    sessionStorage.setItem("cos:ops-tab", "oncall");
    localStorage.setItem(
      "cos:ops-prefs",
      JSON.stringify({
        myTeam: "",
        teamServices: {},
        homeServiceId: "",
        homeServiceLabel: "",
        recentDeploys: [],
        myPolicyKeywords: ["payments"],
      }),
    );
    setInvokeHandlers({
      claude_mcp_list: () => [],
      ops_incidents_read: () => ({ fetched_at: null, incidents: [] }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
      paging_status: () => ({
        provider: "pagerduty",
        has_token: true,
        whoami: null,
      }),
      paging_oncall_now: () => [
        {
          policy_id: "P1",
          policy_name: "Payments Core",
          level: 1,
          user_id: "U1",
          user_name: "Alice",
          schedule_id: "S1",
          schedule_name: "Payments Core Primary",
          end: "2026-04-26T12:00:00Z",
          user_url: "https://example.pagerduty.com/users/U1",
        },
        {
          policy_id: "P2",
          policy_name: "Server API",
          level: 1,
          user_id: "U2",
          user_name: "Other Person",
          schedule_id: "S2",
          schedule_name: "Server API Primary",
          end: null,
          user_url: "https://example.pagerduty.com/users/U2",
        },
      ],
      content_list_people: () => [],
    });
    render(<Ops />);
    // Both sections render; My teams comes before Other teams in DOM order.
    const mineHeader = await screen.findByRole("heading", {
      name: /my teams/i,
    });
    const otherHeader = await screen.findByRole("heading", {
      name: /other teams/i,
    });
    expect(
      mineHeader.compareDocumentPosition(otherHeader) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByText(/payments core/i).length).toBeGreaterThan(0);
    // "Other teams" is collapsed by default — its content (Server API) is
    // hidden until the user expands the disclosure. Click the toggle so
    // the rest of the assertions still verify rendering.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(otherHeader.closest("button")!);
    expect(screen.getAllByText(/server api/i).length).toBeGreaterThan(0);
    // Schedule countdown chip renders for the entry with `end`.
    expect(screen.getByText(/^ends/)).toBeInTheDocument();
    sessionStorage.removeItem("cos:ops-tab");
    sessionStorage.removeItem("cos:oncall-other-expanded");
    localStorage.removeItem("cos:ops-prefs");
  });

  it("On-call search filters across team, schedule, and person (B9-CP41)", async () => {
    sessionStorage.setItem("cos:ops-tab", "oncall");
    sessionStorage.setItem("cos:oncall-search", "alice");
    setInvokeHandlers({
      claude_mcp_list: () => [],
      ops_incidents_read: () => ({ fetched_at: null, incidents: [] }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
      paging_status: () => ({
        provider: "pagerduty",
        has_token: true,
        whoami: null,
      }),
      paging_oncall_now: () => [
        {
          policy_id: "P1",
          policy_name: "Payments Core",
          level: 1,
          user_id: "U1",
          user_name: "Alice",
          schedule_id: "S1",
          schedule_name: "Payments Core Primary",
          end: null,
          user_url: "https://example.pagerduty.com/users/U1",
        },
        {
          policy_id: "P2",
          policy_name: "Server API",
          level: 1,
          user_id: "U2",
          user_name: "Bob",
          schedule_id: "S2",
          schedule_name: "Server API Primary",
          end: null,
          user_url: "https://example.pagerduty.com/users/U2",
        },
      ],
      content_list_people: () => [],
    });
    render(<Ops />);
    expect(await screen.findByText(/alice/i)).toBeInTheDocument();
    expect(screen.queryByText(/server api/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^bob$/i)).not.toBeInTheDocument();
    sessionStorage.removeItem("cos:ops-tab");
    sessionStorage.removeItem("cos:oncall-search");
  });

  it("On-call tab renders grouped escalation policies when populated", async () => {
    sessionStorage.setItem("cos:ops-tab", "oncall");
    setInvokeHandlers({
      claude_mcp_list: () => [],
      ops_incidents_read: () => ({ fetched_at: null, incidents: [] }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
      paging_status: () => ({ provider: "pagerduty", has_token: true, whoami: null }),
      paging_oncall_now: () => [
        {
          policy_id: "P1",
          policy_name: "Payments Core",
          level: 1,
          user_id: "U1",
          user_name: "Alice",
          schedule_id: "S1",
          schedule_name: "Payments Core Primary",
          end: null,
          user_url: "https://example.pagerduty.com/users/U1",
        },
      ],
    });
    render(<Ops />);
    expect(await screen.findByText("Payments Core")).toBeInTheDocument();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    sessionStorage.removeItem("cos:ops-tab");
  });

  it("renders an incidents row when the snapshot has data", async () => {
    setInvokeHandlers({
      claude_mcp_list: () => [
        { name: "datadog-mcp", info: "ok", connected: true },
      ],
      ops_incidents_read: () => ({
        fetched_at: "2026-04-25T17:00:00Z",
        incidents: [
          {
            id: "1",
            title: "Test incident",
            severity: "SEV-2",
            state: "active",
            created_at: "2026-04-25T16:00:00Z",
            url: "https://app.datadoghq.com/incidents/1",
          },
        ],
      }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
    });
    render(<Ops />);
    expect(
      await screen.findByText(/test incident/i),
    ).toBeInTheDocument();
  });

  it("renders relevance, summary, last_updated, and resolved commander (B9-CP11)", async () => {
    setInvokeHandlers({
      claude_mcp_list: () => [
        { name: "slack-local-mcp", info: "ok", connected: true },
      ],
      ops_incidents_read: () => ({
        fetched_at: "2026-04-25T18:00:00Z",
        incidents: [
          {
            id: "rel-1",
            title: "Payments 4xx spike",
            severity: "SEV-1",
            state: "active",
            created_at: "2026-04-25T15:00:00Z",
            last_updated_at: "2026-04-25T17:55:00Z",
            url: "https://example.slack.com/archives/C/p1",
            commander: "Alice Smith",
            commander_id: "U123",
            summary: "Mitigated, monitoring rollout.",
            tags: ["payments", "@alice"],
            relevance: "mine",
          },
        ],
      }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
    });
    render(<Ops />);
    const title = await screen.findByText(/payments 4xx spike/i);
    const row = title.closest("button")!;
    expect(row.className).toContain("cos-incident-rel-mine");
    expect(row.className).toContain("cos-incident-sev-1");
    expect(
      screen.getByText(/mitigated, monitoring rollout/i),
    ).toBeInTheDocument();
    // Both opened and updated chips render when they're meaningfully apart.
    expect(screen.getByText(/^opened/)).toBeInTheDocument();
    expect(screen.getByText(/^updated/)).toBeInTheDocument();
    // Resolved commander name renders, raw Slack ID does not.
    expect(screen.getByText(/commander alice patel/i)).toBeInTheDocument();
    // Tags render as chips.
    expect(screen.getByText("payments")).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
  });

  it("hides commander when the snapshot still has a raw Slack ID (pre-CP11 data)", async () => {
    setInvokeHandlers({
      claude_mcp_list: () => [
        { name: "slack-local-mcp", info: "ok", connected: true },
      ],
      ops_incidents_read: () => ({
        fetched_at: "2026-04-25T18:00:00Z",
        incidents: [
          {
            id: "stale-1",
            title: "Old-shape snapshot",
            severity: "SEV-3",
            state: "active",
            created_at: "2026-04-25T16:00:00Z",
            url: "https://example.slack.com/archives/C/p2",
            commander: "<@U047V57D0SH>",
          },
        ],
      }),
      ops_rollbar_read: () => ({ fetched_at: null, items: [] }),
      ops_monitors_read: () => ({ fetched_at: null, monitors: [] }),
    });
    render(<Ops />);
    expect(
      await screen.findByText(/old-shape snapshot/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/commander/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/U047V57D0SH/)).not.toBeInTheDocument();
  });
});

describe("MeetingDetail surface (stand-alone)", () => {
  it("renders sessions section when sessions exist", async () => {
    setInvokeHandlers({
      content_list_sessions: () => [
        { date: "2026-04-25", rel_path: `${MEETING.rel_path}/sessions/2026-04-25.md` },
      ],
      content_read_file: () => ({
        rel_path: `${MEETING.rel_path}/README.md`,
        markdown: "# README",
      }),
    });
    render(
      <MeetingDetail
        target={MEETING}
        onOpenDoc={NOOP_DOC}
        onBack={NOOP}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: MEETING.label }),
    ).toBeInTheDocument();
    expect(await screen.findByText("2026-04-25")).toBeInTheDocument();
  });
});
