# Design Principles

Guiding principles for the Chief of Staff UI. Reference these when making design decisions or evaluating PRDs.

## 1. Local-first, single-user

This is a personal productivity tool, not a collaborative platform. There is one user, one machine, no remote access. Design decisions should optimize for that context - no multi-tenancy, no conflict resolution, no access control UI. Simplicity over generality.

## 2. Local files as source of truth

Markdown files on disk and SQLite databases are the canonical data stores. The UI is a lens over local data, not a replacement for it. Changes made in the UI must write through immediately. Changes made outside the UI (by Claude via CLI, by direct editing) must be reflected in the UI via live reload.

This principle extends to the CLI workflow: Claude Code accesses the same database the UI does via the shared data module. Neither should "own" the data in a way that locks out the other. Per Design Principle #10, when a data format becomes painful to work with through the UI (e.g., YAML for structured CRUD), we migrate to a better format (e.g., SQLite) rather than adding complex parsing hacks.

## 3. Convention over configuration

The UI derives structure from the filesystem layout defined in CLAUDE.md (one-on-ones by relationship type, meetings, projects, areas, reference files). It does not ask the user to configure navigation, categories, or metadata. If the folder exists and follows the convention, it shows up.

## 4. Explicit saves for structured data, auto-save for prose

Markdown content auto-saves (2s debounce + periodic + blur) because the risk of a bad keystroke is low and undo is easy. Structured data (tasks, metadata) should require explicit save actions because a misclick on a dropdown or a stray keystroke can silently corrupt data with no undo.

## 5. Progressive enhancement

Start with read-only views, add editing where it adds clear value. The task dashboard started read-only and is being enhanced with editing. Annotations started as highlights and gained Claude processing. Each feature should ship in a useful read-only form before interactive editing is added.

## 6. Minimal dependencies

Vanilla JS modules, no framework. Tiptap is the one significant dependency (needed for rich text editing). Every new dependency should be justified by substantial complexity it removes. Prefer native browser APIs and simple DOM manipulation.

## 7. Dark mode by default

Follow system preference via `prefers-color-scheme`. All UI elements must work in both light and dark mode. Use CSS custom properties for theming, never hardcoded colors.

## 8. Keyboard-first

Power-user shortcuts for common actions: Cmd+K search, Cmd+click navigation, Escape to close, Enter to submit. The mouse should work, but the keyboard should be faster.

## 9. Claude-integrated

The UI is designed to work alongside Claude Code. Annotations are instructions for Claude. The "Process with Claude" button spawns the CLI. New features should consider both the human workflow (UI) and the AI workflow (Claude reading/writing the same data).

## 10. Don't fight the data format

When the UI needs to modify YAML, prefer surgical edits over full re-serialization. Preserve formatting, comments, and ordering where possible. If a data format becomes painful to work with through the UI, that's a signal to migrate the format (e.g., YAML to SQLite), not to add complex parsing hacks.
