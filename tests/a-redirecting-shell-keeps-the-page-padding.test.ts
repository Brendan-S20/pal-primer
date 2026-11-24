import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #1016: while a client-only alias (Settings -> Preferences) hands off, the
// shell used to return a bare <Outlet />, so the layout above the alias drew
// its heading at the screen's corner under the status bar.
const SRC = readFileSync(
  fileURLToPath(new URL("../src/routes/_authenticated/route.tsx", import.meta.url)),
  "utf8",
);

describe("the hand-off state of the app shell", () => {
  it("wraps the outlet in the page padding and the status-bar inset", () => {
    const block = SRC.slice(SRC.indexOf("if (redirecting)"), SRC.indexOf("if (redirecting)") + 400);
    expect(block).toContain("safe-area-inset-top");
    expect(block).toContain("<PageShell>");
    expect(block).not.toMatch(/return <Outlet \/>;/);
  });
});
