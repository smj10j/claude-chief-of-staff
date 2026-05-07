/**
 * Mocks window.__TAURI_INTERNALS__.invoke so Playwright can drive the UI as a
 * plain web app. Stays in lock-step with the IPC surface declared in
 * src-tauri/src/lib.rs — keep the switch below in sync.
 */

export const MOCK_SESSION_MARKDOWN = `# Direct Report A · 2026-04-20

## Shared Agenda
- follow-up from previous session
- career conversation

## Notes
Great session.`;

export function installTauriMock(): string {
  // Stringified so Playwright can inject before page scripts run.
  return `
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => {
        switch (cmd) {
          case "backend_version":
            return Promise.resolve({
              version: "cos-app v0.0.1 (mock)",
              db_path: "/tmp/mock/cos.db",
            });
          case "db_ping":
            return Promise.resolve({ rows: 1, last_write: "2026-04-24T00:00:00Z" });
          case "secret_set":
          case "secret_delete":
            return Promise.resolve(null);
          case "secret_get":
            return Promise.resolve(null);
          case "v1_tasks_status":
            return Promise.resolve({ path: "/tmp/mock/v1.db", found: true });
          case "v1_tasks_list":
            return Promise.resolve([
              {
                id: "t1",
                title: "Finish CP6 tests",
                status: "in-progress",
                priority: "high",
                due: "2026-04-24",
                project: "cos-v2",
                notes: "vitest + playwright",
                tags: ["work", "prep"],
                links: [],
                created_at: "2026-04-20T10:00:00Z",
                updated_at: "2026-04-24T05:00:00Z",
              },
            ]);
          case "v1_tasks_complete":
            return Promise.resolve(null);
          case "v1_tasks_update":
            return Promise.resolve({
              id: args.id ?? "t1",
              title: args.patch?.title ?? "Finish CP6 tests",
              status: args.patch?.status ?? "in-progress",
              priority: args.patch?.priority ?? "high",
              due: args.patch?.due ?? "2026-04-24",
              project: args.patch?.project ?? "cos-v2",
              notes: args.patch?.notes ?? "vitest + playwright",
              tags: args.patch?.tags ?? ["work", "prep"],
              links: [],
              created_at: "2026-04-20T10:00:00Z",
              updated_at: "2026-04-24T09:00:00Z",
            });
          case "v1_tasks_create":
            return Promise.resolve({
              id: "mock-new-task",
              title: args.input?.title ?? "new task",
              status: "todo",
              priority: args.input?.priority ?? "medium",
              due: null,
              project: null,
              notes: null,
              tags: [],
              links: [],
              created_at: "2026-04-24T09:30:00Z",
              updated_at: "2026-04-24T09:30:00Z",
            });
          case "content_status":
            return Promise.resolve({ root: "/tmp/mock/files", found: true });
          case "content_list_projects":
            return Promise.resolve(["cos-v2", "project-b"]);
          case "org_load":
            return Promise.resolve({ views: [] });
          case "org_save":
            return Promise.resolve(null);
          case "org_generate":
            return Promise.reject("claude binary not found on $PATH");
          case "person_refresh":
            return Promise.reject("claude binary not found on $PATH");
          case "person_prep":
            return Promise.reject("claude binary not found on $PATH");
          case "session_digest":
            return Promise.reject("claude binary not found on $PATH");
          case "morning_briefing":
            return Promise.reject("claude binary not found on $PATH");
          case "task_triage":
            return Promise.reject("claude binary not found on $PATH");
          case "weekly_review":
            return Promise.reject("claude binary not found on $PATH");
          case "publish_to_gdoc":
            return Promise.reject("claude binary not found on $PATH");
          case "content_recent_briefings":
            return Promise.resolve([]);
          case "reminders_list":
            return Promise.resolve({
              available: false,
              items: [],
              error: null,
            });
          case "annotations_list":
            return Promise.resolve([]);
          case "annotations_save":
            return Promise.resolve(null);
          case "annotations_process":
            return Promise.reject("claude binary not found on $PATH");
          case "content_person_profile":
            return Promise.resolve({
              rel_path: args.relPath,
              readme: "# Profile — mock content",
              sessions: [
                { date: "2026-04-20", rel_path: args.relPath + "/sessions/2026-04-20.md" },
              ],
              meta: null,
            });
          case "content_list_people":
            return Promise.resolve([
              {
                slug: "direct-report-a",
                label: "Direct Report A",
                relationship: "direct-reports",
                rel_path: "areas/one-on-ones/direct-reports/direct-report-a",
                has_readme: true,
                session_count: 12,
                last_session: "2026-04-20",
              },
              {
                slug: "peer-a",
                label: "Peer A",
                relationship: "peers",
                rel_path: "areas/one-on-ones/peers/peer-a",
                has_readme: true,
                session_count: 8,
                last_session: "2026-04-18",
              },
            ]);
          case "content_list_meetings":
            return Promise.resolve([
              {
                slug: "team-eng-leads",
                label: "Team Eng Leads",
                rel_path: "areas/meetings/team-eng-leads",
                has_readme: true,
                session_count: 6,
                last_session: "2026-04-22",
              },
              {
                slug: "payments-eng-managers",
                label: "Payments Eng Managers",
                rel_path: "areas/meetings/payments-eng-managers",
                has_readme: true,
                session_count: 14,
                last_session: "2026-04-21",
              },
            ]);
          case "content_list_sessions":
            return Promise.resolve([
              {
                date: "2026-04-22",
                rel_path: args.relPath + "/sessions/2026-04-22.md",
              },
              {
                date: "2026-04-15",
                rel_path: args.relPath + "/sessions/2026-04-15.md",
              },
            ]);
          case "content_search": {
            const q = String(args.query ?? "").toLowerCase();
            // Mock just one matching doc when the query touches
            // "session" so smoke-test palette-opens-doc flow has
            // something deterministic to click.
            if (q.includes("session") || q.includes("direct report")) {
              return Promise.resolve([
                {
                  rel_path:
                    "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md",
                  label: "2026-04-20",
                  context: "direct-reports/direct-report-a",
                  snippet: "session content",
                  hits: 3,
                },
              ]);
            }
            return Promise.resolve([]);
          }
          case "annotations_list_pending":
            return Promise.resolve([]);
          case "disk_health":
            return Promise.resolve({
              audit_rows: 42,
              audit_latest_at: "2026-04-25T10:00:00.000Z",
              audit_db_bytes: 81_920,
              blob_count: 18,
              blob_bytes: 524_288,
              oldest_restorable_at: "2026-04-22T08:00:00.000Z",
              content_md_count: 230,
              content_md_bytes: 1_048_576,
            });
          case "db_encryption_status":
            return Promise.resolve({
              key_present: false,
              sqlcipher_linked: false,
              encrypted: false,
            });
          case "db_encryption_key_ensure":
            return Promise.resolve(true);
          case "perf_record":
            return Promise.resolve();
          case "perf_summaries":
            return Promise.resolve([]);
          case "perf_clear":
            return Promise.resolve();
          case "audit_recent":
          case "audit_filter":
            return Promise.resolve([
              {
                id: 7,
                at: "2026-04-25T10:00:00.000Z",
                actor: "local",
                action: "doc.write",
                target_kind: "doc",
                target_id: "areas/x/y.md",
                detail_json: JSON.stringify({
                  before_hash: "deadbeef",
                  after_hash: "cafe1234",
                }),
                this_hash: "abcdef",
              },
            ]);
          case "audit_restore":
            // Mirror the new RestoreOutcome enum shape.
            return Promise.resolve({
              kind: "blob_missing",
            });
          case "plugin_list":
            return Promise.resolve([]);
          case "plugin_dir_path":
            return Promise.resolve("/tmp/mock/plugins");
          case "plugin_dir_open":
            return Promise.resolve(null);
          case "content_write_attachment":
            return Promise.resolve(
              "attachments/mock-doc/" + (args.filename ?? "paste.png"),
            );
          case "take_open_request":
            return Promise.resolve(null);
          case "install_status":
            // Default mock: everything OK so the first-run wizard
            // auto-dismisses and tests can run against the steady-
            // state app. Tests that exercise the wizard explicitly
            // set window.localStorage("cos.first-run-complete.v1")
            // to "false" and override this.
            return Promise.resolve({
              checks: [
                {
                  id: "content-root",
                  label: "Content root",
                  ok: true,
                  detail: "found at /tmp/mock/data/files",
                  fix_hint: "",
                },
                {
                  id: "claude-cli",
                  label: "Claude Code CLI",
                  ok: true,
                  detail: "found at /usr/local/bin/claude",
                  fix_hint: "settings:claude",
                },
                {
                  id: "calendar-source",
                  label: "Calendar source",
                  ok: true,
                  detail: "EventKit adapter present",
                  fix_hint: "settings:calendar",
                },
              ],
              all_ok: true,
            });
          case "content_create_session":
            return Promise.resolve(
              args.ownerRelPath + "/sessions/" + args.date + ".md",
            );
          case "content_list_project_refs":
            return Promise.resolve([
              {
                slug: "alpha-launch",
                label: "Alpha Launch",
                rel_path: "projects/alpha-launch",
                has_readme: true,
                extra_md_count: 2,
                last_touched: "2026-04-23T10:00:00Z",
              },
              {
                slug: "beta-rollout",
                label: "Beta Rollout",
                rel_path: "projects/beta-rollout",
                has_readme: true,
                extra_md_count: 0,
                last_touched: "2026-04-10T10:00:00Z",
              },
            ]);
          case "content_list_project_files":
            return Promise.resolve([
              { name: "README.md", rel_path: args.relPath + "/README.md" },
              { name: "metrics.md", rel_path: args.relPath + "/metrics.md" },
            ]);
          case "v1_tasks_uncomplete":
            return Promise.resolve();
          case "v1_tasks_get":
            return Promise.resolve({
              id: args.id,
              title: "Mock task " + args.id,
              status: "pending",
              priority: "medium",
              due: null,
              project: null,
              notes: null,
              tags: ["mock"],
              links: [],
              created_at: "2026-04-24T00:00:00Z",
              updated_at: "2026-04-24T00:00:00Z",
            });
          case "calendar_config_get":
            return Promise.resolve({ ics_url: "", transport: "eventkit" });
          case "calendar_config_set":
            return Promise.resolve(args.config);
          case "calendar_events":
            return Promise.resolve([]);
          case "claude_status":
            return Promise.resolve({
              binary_path_configured: "",
              binary_path_resolved: null,
              settings_path: "",
              extra_args: [
                "--print",
                "--permission-mode",
                "auto",
                "--model",
                "opus",
              ],
              available: false,
              config_file: "/tmp/mock/claude-cli.json",
            });
          case "claude_config_get":
            return Promise.resolve({
              binary_path: "",
              settings_path: "",
              extra_args: [
                "--print",
                "--permission-mode",
                "auto",
                "--model",
                "opus",
              ],
            });
          case "claude_config_set":
          case "claude_config_reset":
            return Promise.resolve({
              binary_path_configured: args.config?.binary_path ?? "",
              binary_path_resolved: null,
              settings_path: args.config?.settings_path ?? "",
              extra_args: args.config?.extra_args ?? [],
              available: false,
              config_file: "/tmp/mock/claude-cli.json",
            });
          case "claude_ping":
            return Promise.reject("claude binary not found on $PATH");
          case "claude_mcp_list":
            return Promise.resolve([]);
          case "claude_parse_task":
            return Promise.resolve({
              title: args.text ?? "",
              priority: "medium",
              due: null,
              project: null,
              tags: [],
              notes: null,
            });
          case "content_recent_sessions":
            return Promise.resolve([
              {
                rel_path: "areas/one-on-ones/direct-reports/direct-report-a/sessions/2026-04-20.md",
                owner_kind: "one-on-ones",
                owner_slug: "direct-report-a",
                owner_label: "Direct Report A",
                date: "2026-04-20",
              },
              {
                rel_path: "areas/meetings/team-leadership/sessions/2026-04-18.md",
                owner_kind: "meetings",
                owner_slug: "team-leadership",
                owner_label: "Team Leadership",
                date: "2026-04-18",
              },
            ]);
          case "content_read_file":
            return Promise.resolve({
              rel_path: args.relPath,
              markdown: ${JSON.stringify(MOCK_SESSION_MARKDOWN)},
              bytes: ${MOCK_SESSION_MARKDOWN.length},
            });
          default:
            return Promise.reject("unknown command: " + cmd);
        }
      },
    };
  `;
}
