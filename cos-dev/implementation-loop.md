# Implementation Loop

Process for implementing approved PRDs. Follow these steps in order for each implementation cycle. **Do not skip steps or declare completion early.**

## Tracking Files

Two kinds of tracking files exist during implementation:

- **Scratch TODO** (`cos-dev/TODO-prd-NNN.md`) - gitignored working scratchpad used during active development. Created in step 2, updated as you go.
- **Implementation tracker** (`cos-dev/implementations/PRD-NNN.md`) - committed, long-lived record of what was built, the final audit, soak period log, and post-soak cleanup. Created in step 9 from the scratch TODO.

## Steps

1. **Gather requirements** - Read the PRD (or whatever doc defines the work). Understand the scope, design decisions, and acceptance criteria before writing code.

2. **Write a scratch TODO** - Create `cos-dev/TODO-prd-NNN.md` (gitignored). Break the work into concrete steps from the PRD's build plan. This is your working checklist during implementation.

3. **Implement + test** - Build the changes. **Write tests alongside the code, not after.** Tests are not optional - every new module needs a test file. Mark items off in the TODO as they're completed. If the build plan is large, implement in logical chunks and commit at milestones.

4. **Run tests** - Run all test suites and make sure they pass. Fix any failures before proceeding. If you wrote new code, there must be new tests.
   - Database tests: `node --test bin/db/tests/*.test.js`
   - UI server tests: `node --test ui/tests/*.test.js`

5. **Update TODO against PRD** - Re-read the PRD's build plan, scope, and success criteria. **Check every item in the PRD against the TODO.** Add anything missing. Mark completed items. Note deferred work with rationale.

6. **Continue remaining work** - If the TODO still has unchecked items that are in scope, go back to step 3. **Do not skip ahead with incomplete items.** Only items explicitly deferred (e.g., soak period) can remain unchecked.

7. **Update docs** - This is not optional. Check each of these:
   - README / deploy instructions if the setup process changed
   - TDD if architecture, dependencies, or external systems changed
   - DESIGN if design principles were added, changed, or tension was resolved
   - SECURITY if new attack surfaces, controls, or data handling changed
   - PRD status (mark as `implemented`, `partially implemented`, etc.)
   - PRD INDEX to match
   - CLAUDE.md if workflows, folder structure, or system instructions changed
   - Any other docs that reference the changed system

8. **Grep for stragglers** - When changing a system-wide concept (e.g., YAML to SQLite, Node 18 to 22), grep the entire repo for the old term. Fix every stale reference.

9. **Create implementation tracker** - Move the scratch TODO into a committed implementation tracker at `cos-dev/implementations/PRD-NNN.md`. This file includes:
   - Final audit (every PRD item checked off)
   - Success criteria results
   - Soak period log (if applicable)
   - Post-soak cleanup checklist
   - List of commits

10. **Final commit** - Stage and commit. Verify `git status` is clean (except gitignored files).

## Anti-patterns to avoid

- **Declaring done before checking the TODO against the PRD.** The PRD is the contract. The TODO is the checklist. If they don't match, work is missing.
- **Skipping tests.** "No tests to run" means "I forgot to write tests." Every new module gets a test file.
- **Committing implementation without running tests first.** Tests validate the code works. Committing untested code is shipping bugs.
- **Updating docs only for the parts you remember.** Use the checklist in step 7. It exists because it's easy to forget things like a Node version reference in a README.
- **Treating slash commands as "just instructions."** If the PRD says "add a command," the command must exist and be functional before marking implemented.
- **Leaving TODO items unchecked without explanation.** Every unchecked item must be explicitly deferred with a reason. "I forgot" is not valid.
- **Skipping the straggler grep.** If you find 3 stale references, assume there's a 4th.
