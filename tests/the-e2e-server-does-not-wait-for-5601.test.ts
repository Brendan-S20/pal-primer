// The Sandboxes job failed twice on PR #597 with "http://127.0.0.1:5601/auth
// is already used": the E2E dev server could not bind because something else
// on the self-hosted runner held 5601. Reuse stays off in CI, so the fix is a
// free port, chosen in tests/e2e/run.sh, that the config reads.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const config = readFileSync(join(root, "playwright.e2e.config.ts"), "utf8");
const run = readFileSync(join(root, "tests/e2e/run.sh"), "utf8");

describe("the E2E dev server does not wait for 5601", () => {
  it("the config reads its port from E2E_PORT, 5601 by default", () => {
    expect(config).toMatch(/const PORT = Number\(process\.env\.E2E_PORT \|\| 5601\);/);
    expect(config).toMatch(/--port \$\{PORT\}/);
  });

  it("still refuses to adopt a server in CI", () => {
    expect(config).toMatch(/reuseExistingServer: !process\.env\.CI,/);
  });

  it("run.sh picks a free port under CI before Playwright starts", () => {
    const pick = run.indexOf('s.listen(0,"127.0.0.1"');
    expect(pick).toBeGreaterThan(0);
    expect(run.slice(0, pick)).toMatch(/if \[ -n "\$\{CI:-\}" \]/);
    expect(run.indexOf("export E2E_PORT")).toBeGreaterThan(pick);
    expect(run.indexOf("export E2E_PORT")).toBeLessThan(run.indexOf("npx playwright test"));
  });

  it("kills nothing", () => {
    expect(run).not.toMatch(/\b(kill|pkill|fuser -k)\b/);
  });
});
