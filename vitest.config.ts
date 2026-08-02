import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    // `.tsx` too: a QA pass dropped a deliberately failing tests/*.test.tsx in
    // and the run reported the same 61 files as before, having never executed
    // it. A test file the runner does not discover is a test file CI cannot
    // fail on — BUG-47 in a different disguise. tests/the-wiring-is-connected
    // .test.ts asserts this glob covers everything actually on disk.
    include: ["tests/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
