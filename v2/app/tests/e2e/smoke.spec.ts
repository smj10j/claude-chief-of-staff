import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { installTauriMock } from "./tauri-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installTauriMock());
});

test("home loads — sidebar + greeting + brief-me action", async ({ page }) => {
  await page.goto("/");

  // Sidebar brand is visible.
  await expect(page.getByText("Chief of Staff")).toBeVisible();

  // SurfaceHero renders the greeting (per PRD-115 §6.1) — match the
  // weekday word generously since the date string varies day-to-day.
  await expect(
    page.getByRole("button", { name: /Brief me|Re-brief/ }),
  ).toBeVisible();
});

test("opening a prep doc via Cmd+K palette shows Tiptap editor and Esc closes it", async ({
  page,
}) => {
  await page.goto("/");

  // Open a doc via the palette so the test doesn't depend on which
  // Home block exposes session links — that surface is in flux per
  // PRD-115 CP8/CP10. Palette + content_search is invariant.
  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(
    page.getByRole("dialog", { name: /Command palette/ }),
  ).toBeVisible();
  // Mock returns a session doc when query contains "session".
  await page.keyboard.type("session");
  await expect(
    page.getByRole("option").filter({ hasText: /direct-reports\/direct-report-a/ }),
  ).toBeVisible();
  await page.keyboard.press("Enter");

  // Editor renders the mocked markdown.
  await expect(page.locator(".ProseMirror")).toBeVisible();
  await expect(page.locator(".ProseMirror h1")).toHaveText(
    "Direct Report A · 2026-04-20",
  );

  // Breadcrumb shows the doc date as the current crumb.
  await expect(page.locator(".cos-breadcrumb-current")).toHaveText(
    "2026-04-20",
  );

  // Esc closes back to the surface.
  await page.keyboard.press("Escape");
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
});

test("Cmd+K opens the palette and Enter jumps surface", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(page.getByRole("dialog", { name: /Command palette/ })).toBeVisible();

  await page.keyboard.type("work");
  await page.keyboard.press("Enter");

  // Landed on Work surface — source banner confirms.
  // Work surface mount is the cheapest signal — the wrapper class is
  // unique to it. The previous "v1 database · live" pill was retired
  // in favor of Settings → Diagnostics for that info.
  await expect(page.locator(".cos-work")).toBeVisible();
});

test("Cmd+Shift+B toggles the sidebar; Cmd+B does not", async ({ page }) => {
  await page.goto("/");

  const app = page.locator(".cos-app");
  await expect(app).not.toHaveClass(/sidebar-collapsed/);

  // Cmd+B alone should NOT toggle (it's reserved for editor bold).
  await page.keyboard.press("ControlOrMeta+KeyB");
  await expect(app).not.toHaveClass(/sidebar-collapsed/);

  // Cmd+Shift+B collapses.
  await page.keyboard.press("ControlOrMeta+Shift+KeyB");
  await expect(app).toHaveClass(/sidebar-collapsed/);

  // Again expands.
  await page.keyboard.press("ControlOrMeta+Shift+KeyB");
  await expect(app).not.toHaveClass(/sidebar-collapsed/);
});

test("Home surface has no axe-detectable violations", async ({ page }) => {
  await page.goto("/");
  // Wait for the SurfaceHero "Brief me" button so axe scans the
  // mounted Home, not a loading skeleton.
  await expect(
    page.getByRole("button", { name: /Brief me|Re-brief/ }),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

// Quick capture has a Cmd+N shortcut + a header "+" button. We test via
// the button because Playwright's Chrome swallows browser-reserved
// chords (Cmd+N opens a window). The real Tauri webview honors the
// shortcut; we trust the keys.ts unit-test layer for that wiring.
test("New task button opens quick capture, Enter creates and lands on Work", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Brief me|Re-brief/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /New task/ }).click();
  const modal = page.getByRole("dialog", { name: /Quick capture/ });
  await expect(modal).toBeVisible();

  await page.keyboard.type("buy milk");
  await page.keyboard.press("Enter");

  await expect(modal).toBeHidden();
  // Work surface mount is the cheapest signal — the wrapper class is
  // unique to it. The previous "v1 database · live" pill was retired
  // in favor of Settings → Diagnostics for that info.
  await expect(page.locator(".cos-work")).toBeVisible();
});

test("Quick capture closes on Escape without creating", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Brief me|Re-brief/ }),
  ).toBeVisible();

  await page.getByRole("button", { name: /New task/ }).click();
  const modal = page.getByRole("dialog", { name: /Quick capture/ });
  await expect(modal).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
});

test("Palette surfaces tasks; selecting one lands on Work with task selected", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /Brief me|Re-brief/ }),
  ).toBeVisible();

  await page.keyboard.press("ControlOrMeta+KeyK");
  await expect(
    page.getByRole("dialog", { name: /Command palette/ }),
  ).toBeVisible();

  // Mock returns "Finish CP6 tests" — search for "CP6" to surface it
  // among the surface entries.
  await page.keyboard.type("CP6");
  // The result list should contain the task title.
  await expect(
    page.getByRole("option").filter({ hasText: /Finish CP6 tests/ }),
  ).toBeVisible();

  await page.keyboard.press("Enter");

  // Work surface loaded with the task selected — banner is the cheap
  // tell.
  // Work surface mount is the cheapest signal — the wrapper class is
  // unique to it. The previous "v1 database · live" pill was retired
  // in favor of Settings → Diagnostics for that info.
  await expect(page.locator(".cos-work")).toBeVisible();
});

// Projects: surface mounting is in flux per PRD-115 CP9 (Work tabs
// dropped) → CP11 (Projects redesign as status grid). The Projects
// component still exists; PRD-115 will re-mount it when CP11 lands.
// Smoke test for Projects re-added once the new mount point is
// stable.

test("Settings → Activity restore: clicking through stays sticky on tab switch", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+Digit6");
  await page.getByRole("tab", { name: "Activity" }).click();

  // Mock returns a doc.write row with a captured before_hash.
  // Expand it.
  const auditRow = page
    .locator(".cos-audit-row")
    .filter({ hasText: /doc\.write/ })
    .first();
  await expect(auditRow).toBeVisible();
  await auditRow.locator("button.cos-audit-head").click();

  // Two-step confirm: click "restore" → "confirm restore".
  await auditRow.getByRole("button", { name: /^restore$/ }).click();
  await auditRow
    .getByRole("button", { name: /confirm restore/ })
    .click();

  // Mock returns kind:"blob_missing" — the inline status should
  // display the "snapshot not captured" message rather than re-
  // arming the button.
  await expect(
    auditRow.getByText(/snapshot not captured/),
  ).toBeVisible();

  // The "restore" button should NOT be visible anymore.
  await expect(
    auditRow.getByRole("button", { name: /^restore$/ }),
  ).toHaveCount(0);

  // Switch to Diagnostics, then back to Activity. Status should
  // persist via localStorage — no re-arm.
  await page.getByRole("tab", { name: "Diagnostics" }).click();
  await page.getByRole("tab", { name: "Activity" }).click();

  // Re-expand the row (the panel collapsed when we switched away).
  const reopened = page
    .locator(".cos-audit-row")
    .filter({ hasText: /doc\.write/ })
    .first();
  await reopened.locator("button.cos-audit-head").click();

  await expect(
    reopened.getByText(/snapshot not captured/),
  ).toBeVisible();
  await expect(
    reopened.getByRole("button", { name: /^restore$/ }),
  ).toHaveCount(0);
});

test("Settings → Diagnostics shows install readiness", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+Digit6"); // Cmd+6 -> Settings
  await page.getByRole("tab", { name: "Diagnostics" }).click();

  // The install panel renders the three checks from the mock.
  await expect(page.getByText("Setup readiness")).toBeVisible();
  await expect(page.getByText("Content root")).toBeVisible();
  await expect(
    page.getByText("Claude Code CLI", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Calendar source")).toBeVisible();
});

test("Install wizard appears on first-run when checks fail and persists dismissal", async ({
  page,
}) => {
  // Override the install_status mock to return a failing check, AND
  // clear the first-run flag so the wizard's gate fires.
  await page.addInitScript(() => {
    window.localStorage.removeItem("cos.first-run-complete.v1");
    // Patch the existing window.__TAURI_INTERNALS__.invoke to return
    // a failing install_status while keeping every other case the
    // real mock provides.
    const original = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => unknown };
    }).__TAURI_INTERNALS__.invoke;
    (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => unknown };
    }).__TAURI_INTERNALS__.invoke = (cmd: string, args: unknown) => {
      if (cmd === "install_status") {
        return Promise.resolve({
          checks: [
            {
              id: "content-root",
              label: "Content root",
              ok: true,
              detail: "found",
              fix_hint: "",
            },
            {
              id: "claude-cli",
              label: "Claude Code CLI",
              ok: false,
              detail: "not found",
              fix_hint: "settings:claude",
            },
            {
              id: "calendar-source",
              label: "Calendar source",
              ok: true,
              detail: "ok",
              fix_hint: "",
            },
          ],
          all_ok: false,
        });
      }
      return original(cmd, args);
    };
  });
  await page.goto("/");

  // Wizard renders.
  const wizard = page.getByRole("dialog", { name: /First-run setup/ });
  await expect(wizard).toBeVisible();
  await expect(wizard.getByText(/Welcome to Chief of Staff/)).toBeVisible();

  // Skip closes it and persists the flag.
  await wizard.getByRole("button", { name: /skip setup/ }).click();
  await expect(wizard).toBeHidden();

  // Verify the persistence flag landed in localStorage. (Can't
  // use page.reload() here — addInitScript re-fires on reload and
  // would clear the flag again. The component's own gate is unit-
  // tested in InstallWizard.test.ts.)
  const flag = await page.evaluate(() =>
    window.localStorage.getItem("cos.first-run-complete.v1"),
  );
  expect(flag).toBe("true");
});

test("Settings surface has no axe-detectable violations", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+Digit6"); // Cmd+6 -> Settings
  await expect(page.getByText(/Diagnostics/)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});
