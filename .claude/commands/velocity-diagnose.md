---
allowed-tools: mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql, Bash(gh:*), Read, Write, Bash(mkdir:*)
description: Diagnose week-over-week velocity dips (PRD-109 §5.1a)
---

# /velocity-diagnose

Inspect the user's PR + Jira flow over the last 14 days and produce
a one-page synthesis: *what changed and why*. Output is meant to be
opened in the editor, not piped into a UI grid — terse markdown.

## What to write

Path: `data/files/areas/work/velocity-diagnose-<date>.md`

Body shape:

```
# Velocity diagnostic — <date>

## TL;DR
- One-line summary.

## Most likely cause
- Hypothesis (with cited evidence).

## Contributing factors
- ...

## Suggested actions
1. ...

---

### Evidence

(short tables / counts pulled from the queries below)
```

## How to gather signal

- `gh search prs --author=@me --created:>=<14d ago>` — count + size
  trend (additions / deletions where available).
- `gh search prs --reviewer=@me --created:>=<14d ago>` — review
  load.
- `gh pr list --state=closed --search "merged:>=<14d ago> author:@me"`
  for review latency (created-vs-merged).
- Atlassian: ticket churn, blocked tickets count, cross-team
  dependency flags on epics owned by the user's team.

## Output discipline

- `mkdir -p` parent.
- Print exactly: `SAVED: data/files/areas/work/velocity-diagnose-<date>.md`
- Empty path: write a stub explaining missing prerequisites.
