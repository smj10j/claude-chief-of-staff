# Chief of Staff — your data folder

This is where your notes, sessions, and project documents live. The app reads and writes from here.

## Folder map

```
data/files/                          ← this folder is the content root
  areas/                             ← ongoing responsibilities
    one-on-ones/                     ← per-person 1:1 folders (see README)
      direct-reports/
      manager/
      peers/
      skip-level/
      skip-level-reports/
      xfn/
    meetings/                        ← recurring meetings (see README)
    career/                          ← promotion tracking, growth plans
    comms/                           ← drafted messages
    daily-briefings/sessions/        ← morning briefing history
    weekly-reviews/sessions/         ← Friday weekly review artifacts
  projects/                          ← time-bound initiatives (each in its own folder)
  archive/                           ← completed projects (moved here from projects/)
  attachments/                       ← images and files dropped into the editor
  style-guide.md                     ← Claude's drafting style for you
```

## How to use it

1. **Add a person.** Create a folder under `areas/one-on-ones/<relationship>/<their-name>/` with a `README.md`. Run `/prep-1on1 <their-name>` from Claude Code to generate the next session file with shared agenda + context.
2. **Add a meeting.** Create a folder under `areas/meetings/<meeting-name>/` with a `README.md`. Run `/digest-meeting <meeting-name>` to capture notes after a meeting happens.
3. **Add a project.** Create a folder under `projects/<project-id>/` with a `README.md`. Add a row to `projects/INDEX.md` so it shows in the Projects surface.
4. **Capture a task.** Cmd+N from the app, or `bash bin/cos add "task title"` from the terminal.

The app and the CLI share the same data — edits in either show up in the other.

## What's in this folder vs. what gets generated

The folder you're looking at right now is the **starter set**: empty README templates + the system style guide. As you use the app, it'll fill in:

- `areas/daily-briefings/sessions/YYYY-MM-DD.md` — written by `/morning-briefing`
- `areas/weekly-reviews/sessions/YYYY-MM-DD.md` — written by `/weekly-review`
- `projects/<id>/` folders — created when you run `/init` or by hand
- `*.annotations.json` sidecars — written when you drop annotations on a doc inside the app

You can edit anything in here freely. The app picks up changes automatically.
