# Projects Index

Single source of truth for active and completed projects. See `areas/` for ongoing responsibilities and `archive/` for completed projects.

## Active

| ID | Title | Status | Started | Target | Notes |
|----|-------|--------|---------|--------|-------|

## On Hold

| ID | Title | Status | Started | Notes |
|----|-------|--------|---------|-------|

## Archived

| ID | Title | Completed | Notes |
|----|-------|-----------|-------|

---

## Conventions

- **Project** = time-bound initiative with a clear finish line. Lives in `projects/<id>/`.
- **Area** = ongoing responsibility with no finish line. Lives in `areas/`. Never archived.
- **Archive** = completed projects, moved from `projects/`. Not deleted — kept for reference.
- **Tasks link to projects** via the `project:` tag in `tasks.yaml`. Tag value = folder ID above.
- To start a project: create `projects/<id>/` folder, add a row here, add tasks with matching `project:` tag.
- To complete a project: mark row as archived here, move folder to `archive/`, update relevant tasks.
