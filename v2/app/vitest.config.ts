import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Component tests need a DOM. happy-dom is lighter than jsdom and
    // our existing pure-logic tests don't care which env they get.
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
