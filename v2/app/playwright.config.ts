import { defineConfig, devices } from "@playwright/test";

/**
 * Phase-0 E2E: drive the frontend via `vite preview` with Tauri IPC mocked.
 * Full Tauri-driver-on-macOS exploration is tracked as an open spike per
 * PRD-101 §13 #2 — does not block CI coverage of UI flows.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome",
      // Use the Chrome already installed on macOS rather than Playwright's
      // bundled Chromium. Skips a 92MB download on every CI cold-start and
      // runs against a real release-channel browser.
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
