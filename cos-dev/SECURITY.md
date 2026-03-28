# Security

## Threat Model

This system has two distinct attack surfaces: the **UI server** (localhost web app) and the **Claude agent** (LLM with tool access processing external data).

### UI Server Threats

The Chief of Staff UI is a **local-only, single-user** application. It runs on `localhost:3737` and is not exposed to the internet. The primary threats are:

1. **Local process access**: Any process on the machine can reach `localhost:3737`
2. **Path traversal**: API endpoints accept file paths - malformed paths could read/write outside the repo
3. **Code execution**: The `/api/process` endpoint spawns Claude CLI as a child process
4. **Sensitive data in content**: Task notes, 1:1 session files, and comms drafts contain work-sensitive information

### Claude Agent Threats (Prompt Injection)

The agent ingests data from multiple external sources and has write access to the local filesystem, bash execution, and potentially outbound access to external services (Google Docs, Jira, Confluence, etc.). This creates a **prompt injection attack surface** - adversarial text in any external data source could attempt to manipulate the agent's behavior.

**Inbound data sources (attack vectors):**

| Source | How it enters | Risk level |
| --- | --- | --- |
| Web pages | WebSearch, WebFetch - research, link following | High - anyone on the internet can author |
| Slack messages | Slack/Glean MCP - briefings, 1:1 prep, channel digests | Medium - requires org Slack access |
| Confluence/wiki pages | Atlassian/Glean MCP - 1:1 prep, project research | Medium - requires wiki edit access |
| Google Docs/Sheets | Google Workspace MCP, Glean - 1:1 prep, doc reads | Medium - requires doc edit access |
| Jira tickets | Atlassian MCP - task triage, epic planning | Medium - requires Jira access |
| Calendar events | Google Workspace MCP - morning briefings | Low - requires calendar invite access |

<!-- Update this table when you add new MCP servers or external data sources -->

**What an attacker could achieve:**

- **Data exfiltration**: Injected instructions could tell Claude to include sensitive 1:1 notes or task data in an outbound Google Doc, Jira ticket, or clipboard copy
- **Silent data modification**: Subtly alter comms drafts, add/remove tasks, change session notes - hard to catch in automated workflows
- **Misdirection**: Inject fake context that influences decisions (e.g., "the user decided to cancel the project" in a message that gets picked up during briefing prep)
- **File writes**: Overwrite or corrupt repo files (session notes, CLAUDE.md) or database

**Why automated workflows are the highest risk:**

Commands like `/morning-briefing` and `/prep-1on1` pull from multiple external sources and write results to files with minimal human review of each individual source. A prompt injection payload in one message among dozens could go unnoticed. In contrast, interactive conversations give the user the chance to review each tool result before Claude acts on it.

### What's NOT in the threat model

- Remote attackers hitting the UI (no network exposure)
- Multi-user access control (single user)
- Authentication/authorization for the UI (localhost-only)
- DDoS/rate limiting (local tool)

## Current Controls

### Prompt injection mitigations

**Built-in protections (Claude Code platform):**

- Claude Code flags suspected prompt injection in tool results before acting on them
- Permission mode prompts the user before executing tools not on the auto-allow list
- Tool results are tagged with `<system-reminder>` markers that help Claude distinguish system context from external content

**Behavioral mitigations (how we use the system):**

- Automated workflows (`/morning-briefing`, `/prep-1on1`) write to session files that the user reviews before acting on them - they don't send outbound messages or create external artifacts without confirmation
- Outbound actions (Google Doc writes, Jira updates, clipboard copies) require explicit user approval in the conversation
- CLAUDE.md instructions anchor Claude's behavior - injected instructions that contradict CLAUDE.md are less likely to succeed because the system prompt takes priority

**Current gaps:**

- No input sanitization on data from MCP tools before Claude processes it (not practical for an LLM agent - the model must see the content to use it)
- No structured separation between "data to analyze" and "instructions to follow" in tool results - this is a fundamental LLM limitation, not specific to this system
- Automated workflows don't have a "dry run" mode that shows sources before writing files
- No audit log of which external sources contributed to a generated file

**Practical risk assessment:**

The realistic threat is not a sophisticated nation-state attack. It's: (1) a random web page with prompt injection that gets fetched during research, or (2) a message or wiki page authored by someone who knows how LLM agents work and intentionally crafts adversarial content. The former is mitigable by reviewing web search results carefully. The latter requires internal org access, which significantly narrows the attacker pool.

### Path traversal protection

Both `GET /api/file` and `PUT /api/file` validate that the resolved path starts with the repo root (`ROOT`):

```javascript
const filePath = path.join(ROOT, req.query.path || '');
if (!filePath.startsWith(ROOT)) {
  return res.status(404).json({ error: 'Not found' });
}
```

This prevents `../../etc/passwd` style attacks. The check uses `path.join` which normalizes `..` segments before the prefix check.

### Process spawning

The `/api/process` endpoint only spawns Claude CLI with a hardcoded command pattern (`/process-ui-annotations <path>`). The path is passed as a CLI argument, not interpolated into a shell string, preventing command injection. The child process inherits the user's environment.

### No authentication

There is no auth. This is intentional for a localhost tool. If the server were ever exposed on a network interface, authentication would need to be added first.

### No HTTPS

Traffic is plaintext HTTP over localhost. This is acceptable for `127.0.0.1` - the OS prevents other machines from sniffing loopback traffic.

### File watcher scope

Chokidar ignores dotfiles, `node_modules/`, `ui/`, and `.annotations/`. This prevents the watcher from triggering on sensitive dotfiles (`.env`, `.git/`).

## Sensitive Data Handling

### What's sensitive

- 1:1 session notes (performance feedback, career discussions, personnel decisions)
- Task notes (hiring plans, incident details, org changes)
- Comms drafts (Slack messages, announcements)
- Style guide (communication patterns)

### What's NOT sensitive

- Development docs (`cos-dev/`) - architecture, design principles, PRDs. These contain no personnel or business-sensitive data and are safe to share or commit.

### Current protections

- All data stays on the local filesystem (no cloud sync, no telemetry)
- The `.annotations/` directory is inside `ui/` which is gitignored from the chokidar watcher
- No data is sent to external services unless explicitly triggered by the user

### Gaps

- The Express server binds to `0.0.0.0` by default (Express 5 behavior) - should explicitly bind to `127.0.0.1`
- No Content-Security-Policy headers
- No request logging (makes incident investigation harder)

## Security Checklist for New Features

When adding features, verify:

### UI Server

1. **File paths**: Any endpoint accepting a path must validate it starts with ROOT after `path.join` normalization
2. **Process spawning**: Never interpolate user input into shell commands. Use array-style arguments with `spawn`, not `exec`
3. **New dependencies**: Check for known vulnerabilities (`npm audit`). Prefer well-maintained packages with small dependency trees
4. **Data exposure**: New API endpoints should not expose data outside the repo root. Task data, annotations, and file contents should stay local
5. **Binding**: Server must listen on `127.0.0.1`, not `0.0.0.0`
6. **Input validation**: Validate types and shapes on all API inputs. Don't trust client-side validation alone

### Claude Agent / Workflows

 7. **New external data sources**: If a command or workflow ingests data from a new external source (MCP tool, API, web fetch), add it to the threat model table above
 8. **Outbound writes from automated workflows**: Workflows that pull external data and then write to Google Docs, Jira, Confluence, or Slack should always require explicit user confirmation before the outbound write - never chain "read external source -> write external destination" without a human checkpoint
 9. **Sensitive data in prompts**: When building prompts that include content from 1:1 notes, tasks, or career docs, consider whether that content could end up in an external tool call (e.g., search query, Jira description). Avoid leaking sensitive context into external services
10. **Review generated files**: Automated workflows that write session files or briefings should be treated as drafts, not final artifacts. The workflow documentation should make this clear

## Future Considerations

### If adding a database (SQLite)

- Store the `.db` file inside the repo or a well-defined local path
- Use parameterized queries exclusively (no string concatenation for SQL)
- Consider encryption at rest if the database will contain sensitive 1:1 notes
- Ensure the database file is excluded from git (`.gitignore`)
- Implement proper connection cleanup on server shutdown

### If ever exposing beyond localhost

This would require a fundamental security overhaul:

- Add authentication (at minimum, a local bearer token)
- Add HTTPS (self-signed cert or reverse proxy)
- Add CORS restrictions
- Add rate limiting
- Add request logging and audit trail
- Review all endpoints for authorization
- Add CSP headers

This is not planned and would be a separate design exercise if needed.
