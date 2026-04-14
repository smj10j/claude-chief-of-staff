# Chief of Staff UI - Technical Design Document

## Overview

The Chief of Staff UI is a local-only, single-user web application that provides a WYSIWYG editing interface for the work-agent repository. It runs on `localhost:3737` and is tightly coupled to the filesystem structure defined in the work-agent repo.

## System Context

```
+-------------------+       +-------------------+       +-------------------+
|   Browser (UI)    | <---> |  Express Server   | <---> |   Filesystem      |
|   localhost:3737  |       |  (server.js)      |       |   (claude-chief-of-staff/)   |
+-------------------+       +-------------------+       +-------------------+
        |                           |
        |  SSE (live reload)        |  chokidar (file watch)
        |<--------------------------|
```

There is no authentication and no remote access. Task data is stored in SQLite (`data/cos.db`); all other content is markdown on the filesystem.

## Architecture

### Server (`ui/server.js`, \~470 lines)

**Runtime**: Node.js (v22+, required for `node:sqlite`), Express 5.1

**Responsibilities**:

- Serves static assets and the SPA shell (`public/index.html`)
- Builds a navigation tree from the filesystem (`buildTree()`)
- Loads task data from SQLite via shared data module (`data/task-db.js`)
- Reads/writes markdown files via REST API
- Manages annotation storage (filesystem-backed JSON in `ui/.annotations/`)
- Spawns Claude CLI for annotation processing (`/api/process`)
- Broadcasts file change events via SSE

**Key data flows**:

- `GET /api/tree` - Scans `areas/one-on-ones/`, `areas/meetings/`, `projects/`, `areas/`, and root reference files. Returns structured JSON for sidebar navigation.
- `GET /api/tasks` - Queries SQLite via shared data module. Returns `{active, archived, recurring}`. CRUD endpoints: `POST/PUT/DELETE /api/task/:id`, `POST /api/task/:id/done|archive|unarchive`.
- `GET /api/file?path=...` - Reads raw markdown. Path-traversal protected (must start with ROOT).
- `PUT /api/file` - Writes raw markdown. Same path protection.
- `GET /api/events` - SSE stream. Fires on any file change detected by chokidar.
- `POST /api/process` - Spawns `claude -p "/process-ui-annotations <path>"` as a child process, streams output back via SSE.

**File watcher**: chokidar watches the entire repo root, ignoring dotfiles, `node_modules/`, `ui/`, and `.annotations/`. Changes trigger SSE reload events.

### Client (`ui/src/`, \~1,500 lines total)

**Build**: esbuild bundles `src/main.js` into `public/bundle.js` (IIFE format, ES2020 target, sourcemaps, no minification).

**Framework**: Vanilla ES6 modules. No React/Vue/Svelte.

**Module breakdown**:

| Module | Lines | Responsibility |
| --- | --- | --- |
| `main.js` | \~530 | App shell, navigation, sidebar rendering, SSE, breadcrumbs, search wiring, process modal |
| `editor.js` | \~390 | Tiptap editor initialization, file load/save, annotation hydration, toolbar actions |
| `tasks.js` | \~330 | Task card rendering, inline edit panel, create/delete, mark-done with undo toast, tag pill editor, filter interactions |
| `search.js` | \~195 | Cmd+K search palette, fuzzy file search |
| `toolbar.js` | \~110 | Bubble menu button wiring, active state tracking |
| `annotations.js` | \~45 | Tiptap Mark extension for annotation highlights |
| `annotations-store.js` | \~55 | Client-side annotation API wrapper |
| `annotations-panel.js` | \~120 | Popover UI for creating/viewing annotations |

### Editor

The WYSIWYG editor is built on [Tiptap](https://tiptap.dev) (ProseMirror wrapper). Extensions:

- StarterKit (headings, lists, bold/italic/strike, code, blockquote, horizontal rule)
- Markdown (round-trip conversion via `tiptap-markdown`)
- BubbleMenu (floating toolbar on text selection)
- TaskList + TaskItem (checkbox lists)
- Table + TableRow + TableCell + TableHeader
- Link (Cmd+click navigation for internal links)
- CodeBlockLowlight (syntax-highlighted code blocks)
- Annotation (custom Mark extension for highlight + comment)

**Save behavior**: Auto-save on 2s debounce after edits, 30s periodic interval, and on window blur. Synchronous save on file navigation (prevents data loss).

### Styling (`ui/public/style.css`, \~1,060 lines)

- CSS custom properties for theming
- Light/dark mode via `prefers-color-scheme` media query
- No CSS framework or preprocessor
- Layout: flexbox-based sidebar + content area
- Catppuccin-inspired syntax highlighting for code blocks

## Data Model

### Content files (markdown)

All content is stored as markdown files on disk. The server reads/writes them as raw text. The Tiptap editor converts between markdown and ProseMirror document model on load/save.

### Tasks (SQLite)

Single SQLite database at `data/cos.db`, managed by the shared module `data/task-db.js`. Accessed via HTTP API (server) and CLI (`bash data/task-cli.sh`, a shell wrapper that sources nvm for Node 22+ before calling `data/task-cli.js`). Uses `node:sqlite` (Node.js 22+ built-in).

Tables: `tasks` (active + archived), `recurring_tasks`, `task_tags`, `task_links`, `schema_migrations`.

Task schema:

```sql
  id: TEXT PRIMARY KEY   # slugified from title
  title: TEXT NOT NULL
  status: todo | in-progress | done
  priority: high | medium | low
  due: DATE              # nullable
  project: TEXT          # references projects/ folder ID
  tags: [via task_tags]  # normalized join table
  links: [string]     # optional URLs
  notes: string       # optional multiline
```

### Annotations (JSON)

Stored in `ui/.annotations/` as one JSON file per document. Filename is the document path with `/` replaced by `--`.

Annotation schema:

```json
{
  "id": "string",
  "text": "selected text",
  "comment": "instruction for Claude",
  "textBefore": "30 chars before selection",
  "textAfter": "30 chars after selection",
  "createdAt": "ISO 8601"
}
```

### Navigation tree (computed)

Built on every `GET /api/tree` request by scanning the filesystem. Not cached (fast enough for the repo size). Structure mirrors the work-agent folder layout: people (by relationship type), meetings, projects, areas, reference files, and development docs (`cos-dev/`).

## Documentation

Development documentation lives in `cos-dev/` at the repo root:

| File | Purpose |
| --- | --- |
| `cos-dev/TDD.md` | This document - technical architecture |
| `cos-dev/DESIGN.md` | Design principles |
| `cos-dev/SECURITY.md` | Threat model and security controls |
| `cos-dev/PRDs/INDEX.md` | PRD registry |
| `cos-dev/PRDs/*.md` | Individual product requirement documents |

These are browsable in the UI under the "CoS Development" sidebar section.

## Dependencies

| Package | Version | Purpose |
| --- | --- | --- |
| express | 5.1 | HTTP server |
| js-yaml | 4.1 | YAML parsing |
| chokidar | 4.0 | File watching |
| @tiptap/\* | 2.12 | Rich text editor |
| tiptap-markdown | 0.8 | Markdown round-tripping |
| lowlight + highlight.js | 3.3 / 11.11 | Syntax highlighting |
| esbuild | 0.25 | Client bundler |

No database drivers (tasks use `node:sqlite` built into Node 22+), no auth libraries, no external service clients.

## Testing

Tests use **Node.js built-in test runner** (`node:test`) - zero external test dependencies. Run with `node --test data/tests/*.test.js`.

**Approach**: Each test file creates a temporary SQLite database (`:memory:` or temp file), runs the schema migrations, and tests against that isolated database. No shared state between tests. The real `data/cos.db` is never touched by tests.

**Test structure**:

- `data/tests/` - test directory
- `data/tests/task-db.test.js` - shared module unit tests (CRUD, lifecycle, validation, ID generation)
- `data/tests/task-cli.test.js` - CLI integration tests (command parsing, output formats)
- `data/tests/migration.test.js` - YAML-to-SQLite migration tests (data integrity, edge cases)

**Running tests**: `node --test data/tests/` from the repo root. Requires Node 22+.

## Deployment

Fully local. Started via `ui/start.sh`:

1. `npm install` (first run only)
2. `node build.js` (esbuild bundle)
3. `node server.js` (Express on port 3737)

No containerization, no CI/CD, no remote deployment. The UI is a development tool for a single user.
