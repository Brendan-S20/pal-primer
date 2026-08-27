// The workspace was created every time, and the app could not see it.
//
// ── THE REPORT ───────────────────────────────────────────────────────────
//
// "I don't have an account attached to my Apple Account and it's asking me to
// create a new workspace. I enter in my business name and name, and it just
// endlessly loads instead of creating a new one."
//
// It did create one. `Scoops`, 17:44, one member, trial started — the row was
// in production while the spinner was still going.
//
// ── WHY IT LOOKED LIKE A FAILURE ─────────────────────────────────────────
//
// _authenticated/route.tsx decides whether you have a workspace with:
//
//     ensureQueryData({ queryKey: ["my-org"], staleTime: 60_000 })
//
// and ensureQueryData answers from cache while the entry is fresh. Landing on
// /no-workspace populates that cache with "no organization" seconds earlier.
// So: create the workspace, navigate to /dashboard, guard reads the STALE "no
// organization", redirect back to /no-workspace. With `busy` still true,
// because the navigation was treated as success.
//
// A minute later it would have worked. That is the worst kind of bug to
// report, because the person who waits gives up before the cache does.
//
// Two fixes, and both are needed: forget the cached answer so the guard has to
// ask, and clear `busy` in a `finally` so a navigation that comes back here
// cannot leave a spinner with no way out.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const noWorkspace = read("src/routes/no-workspace.tsx");
const auth = read("src/routes/auth.tsx");
const guard = read("src/routes/_authenticated/route.tsx");

describe("creating a workspace makes the guard ask again", () => {
  it("the guard really does answer from cache, which is what made this possible", () => {
    // If this ever stops being true the fix below is harmless, but the comment
    // explaining it would become a lie. Pinned so they move together.
    expect(guard).toMatch(/queryKey: \["my-org"\]/);
    expect(guard).toMatch(/staleTime: 60_000/);
  });

  it("no-workspace forgets the cached answer before navigating", () => {
    const at = noWorkspace.indexOf('removeQueries({ queryKey: ["my-org"] })');
    expect(at, "the stale my-org answer is not cleared").toBeGreaterThan(-1);
    const nav = noWorkspace.indexOf('navigate({ to: "/dashboard" })');
    expect(at, "cleared after navigating, which is too late").toBeLessThan(nav);
  });

  it("REMOVES rather than invalidates", () => {
    // invalidateQueries marks the entry stale and leaves the value in place,
    // and ensureQueryData will hand a stale value back while the refetch is in
    // flight -- which is precisely the redirect this bug was made of.
    expect(noWorkspace).toMatch(/removeQueries/);
    expect(noWorkspace).not.toMatch(/invalidateQueries\({ queryKey: \["my-org"\] }\)/);
  });

  it("every path that creates an organization clears it", () => {
    // auth.tsx bootstraps in four places -- web landing, native landing,
    // password sign-in, and the native OAuth hand-back -- and all four route
    // into the guarded tree afterwards.
    const bootstraps = auth.match(/isNewOrg = await ensureBootstrapped\(/g) ?? [];
    const clears = auth.match(/if \(isNewOrg === true\) forgetWorkspaceCache\(\);/g) ?? [];
    expect(bootstraps.length).toBeGreaterThan(0);
    expect(clears.length, "a bootstrap path does not clear the cache").toBe(bootstraps.length);
  });

  it("the spinner always stops", () => {
    // It used to clear only on the error path, reasoning that success
    // navigates away. True until the navigation lands somewhere that sends you
    // straight back, and then there is no way to try again.
    const fin = noWorkspace.indexOf("} finally {");
    expect(fin, "finishSetup has no finally").toBeGreaterThan(-1);
    // To the end of the block, not a fixed number of characters. The first
    // version of this read 120 chars past `finally` and failed on a comment
    // that was longer than that -- a test measuring prose, not behaviour.
    const block = noWorkspace.slice(fin, noWorkspace.indexOf("\n    }", fin));
    expect(block, "finally does not clear busy").toMatch(/setBusy\(false\)/);
  });
});
