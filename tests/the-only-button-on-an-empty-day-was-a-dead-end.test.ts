import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const ROLES = "src/hooks/useMyRole.ts";
const MY_DAY = "src/routes/_authenticated/my-day.tsx";
const SIDEBAR = "src/components/AppSidebar.tsx";

/** Comments blanked, same length. Load-bearing: the comments added beside this
 *  fix name "/routes", "/my-schedule" and the toast text, so every assertion
 *  below would pass on prose alone. The last test proves the stripping works. */
function codeOnly(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      const stop = end === -1 ? s.length : end + 2;
      out += s.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (s.startsWith("//", i)) {
      const nl = s.indexOf("\n", i);
      const stop = nl === -1 ? s.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (s.startsWith("{/*", i)) {
      const end = s.indexOf("*/}", i + 3);
      const stop = end === -1 ? s.length : end + 3;
      out += s.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** The roles ROUTE_ROLES grants a path, read from source. */
function rolesFor(path: string): string[] {
  const code = codeOnly(read(ROLES));
  const m = code.match(new RegExp(`"${path.replace("/", "\\/")}":\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]) : [];
}

// A technician with nothing scheduled saw one action: "View schedule", to
// /routes. ROUTE_ROLES has never granted a tech /routes, so RoleGuard bounced
// them straight back to /my-day with a red "You don't have access to that
// page." The only button on the screen was a dead end for the only role the
// screen exists for — and nothing failed, because nothing checks that a link's
// destination admits the person being shown it.
describe("every link My Day offers a technician, a technician can open", () => {
  it("the dispatch board is still office-only", () => {
    // The premise. If /routes ever admits techs this test should be the thing
    // that says so, because then the original link was fine and this one is
    // the odd one out.
    const routes = rolesFor("/routes");
    expect(routes.length, `${ROLES}: /routes has no ACL entry`).toBeGreaterThan(0);
    expect(routes, "/routes should not admit techs — it reassigns other people's work").not.toContain(
      "tech",
    );
  });

  it("My Day links a technician somewhere they are allowed to go", () => {
    const code = codeOnly(read(MY_DAY));
    const targets = [...code.matchAll(/<Link\s+to="([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length, `${MY_DAY}: no <Link to="..."> found`).toBeGreaterThan(0);
    for (const t of targets) {
      const allowed = rolesFor(t);
      // Unguarded paths (no ACL entry) are open to everyone — canAccess returns
      // true for them — so only entries that EXIST can exclude a tech.
      if (allowed.length === 0) continue;
      expect(
        allowed,
        `${MY_DAY} offers a link to ${t}, which ROUTE_ROLES does not grant a tech. ` +
          "RoleGuard will bounce them back here with an error toast.",
      ).toContain("tech");
    }
  });

  it("the technician's own schedule admits them", () => {
    const mine = rolesFor("/my-schedule");
    expect(mine, `${ROLES}: /my-schedule has no ACL entry`).not.toHaveLength(0);
    expect(mine, "a technician cannot open their own schedule").toContain("tech");
  });

  it("is reachable without an empty day to find it from", () => {
    // The empty-day card is the one place the link used to live, which means a
    // tech with work every day could never reach it. The sidebar list is also
    // what the phone tab bar's More sheet is built from, so this one assertion
    // covers both ways in.
    const code = codeOnly(read(SIDEBAR));
    expect(
      code,
      `${SIDEBAR} should list /my-schedule — it is the only way to reach it on a day ` +
        "that is not empty",
    ).toContain('url: "/my-schedule"');
  });

  it("is not reading the comments that explain the fix", () => {
    const raw = read(MY_DAY);
    const stripped = codeOnly(raw);
    const count = (s: string, n: string) => s.split(n).length - 1;
    expect(
      count(raw, "/routes"),
      `${MY_DAY}: this tripwire assumes the explanatory comment still names /routes`,
    ).toBeGreaterThan(count(stripped, "/routes"));
  });
});
