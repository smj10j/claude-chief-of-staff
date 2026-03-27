# Task Export

Export the current task database to YAML files for backup or debugging.

## Steps

1. Run `bash data/task-cli.sh list --format json` to get all active tasks
2. Run `bash data/task-cli.sh list --archived --format json` to get all archived tasks
3. Run `bash data/task-cli.sh recurring --format json` to get all recurring tasks
4. Format the data as YAML matching the original schema:
   - `tasks-export.yaml` with a `tasks:` root key (active tasks only)
   - `tasks-archive-export.yaml` with an `archived:` root key (archived/completed tasks)
   - `recurring-export.yaml` with a `recurring:` root key
5. Write the files to the repo root
6. Report what was exported: counts per file, total tasks

## Rules

- Export files use the `-export` suffix to avoid overwriting `.bak` files
- This is a read-only backup operation - it does not modify the database
- The YAML output should be human-readable (not minified)
- If export files already exist, overwrite them (they're disposable backups)
