// The normaliser that lets 86 Windows failures become 21 edits.
//
// This tests `toPosix` rather than `repoRelative`, and the distinction is the
// point: `repoRelative` calls `node:path`'s `relative`, which is
// platform-dependent by design and therefore cannot be made to produce a
// Windows-shaped path on a Mac. `toPosix` is pure string work, so the Windows
// case IS testable here, on this machine, today — which is the only reason
// this file can claim anything about a platform it is not running on.
//
// See `tests/support/repo-paths.ts` for why the fault is 21 lines and not 86
// files.

import { describe, expect, it } from "vitest";

import { repoRelative, toPosix } from "./support/repo-paths";

describe("a path a person reads is spelled with forward slashes", () => {
  it("normalises the exact shape that failed on the Windows runner", () => {
    // Mixed separators, verbatim from the failure. This is the case
    // `split(sep)` would only half-fix: on Windows it would split the
    // backslashes and leave the forward slash, and on POSIX the reverse.
    expect(toPosix("src\\components/RouteMap.tsx")).toBe("src/components/RouteMap.tsx");
    expect(toPosix("src\\components\\ui\\dialog.tsx")).toBe("src/components/ui/dialog.tsx");
  });

  it("leaves a POSIX path exactly as it was, so no expectation moves", () => {
    // The substitution across 21 call sites is only safe because of this.
    for (const already of [
      "src/components/RouteMap.tsx",
      "tests/viewports/rules.ts",
      "supabase/migrations/20260101000000_init.sql",
      "a.tsx",
      "",
    ]) {
      expect(toPosix(already)).toBe(already);
    }
  });

  it("agrees with the hand-written idioms it replaces, on this platform", () => {
    // The three spellings found in the suite. If `repoRelative` ever stops
    // matching them here, the bulk substitution silently changed a message or
    // an assertion on macOS as well as fixing Windows.
    const root = "/repo";
    const file = "/repo/src/components/RouteMap.tsx";

    expect(repoRelative(file, root)).toBe(file.slice(root.length + 1));
    expect(repoRelative(file, root)).toBe(file.replace(root + "/", ""));
    expect(repoRelative(file, root)).toBe("src/components/RouteMap.tsx");
  });

  it("handles a file directly in the root, which has no separator to split", () => {
    expect(repoRelative("/repo/CLAUDE.md", "/repo")).toBe("CLAUDE.md");
  });
});
