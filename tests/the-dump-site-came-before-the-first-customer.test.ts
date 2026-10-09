import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STEPS = "src/lib/onboarding.functions.ts";
const src = readFileSync(join(__dirname, "..", STEPS), "utf8");

/** Comments blanked, same length. The comment added beside this fix argues the
 *  ordering in prose and names every step in it, so an order test read against
 *  the raw file would pass on a file where the array had been reordered back. */
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
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** The ids in the order the checklist renders them. */
function order(): string[] {
  const code = codeOnly(src);
  const decl = "const steps: OnboardingStep[] = [";
  const from = code.indexOf(decl);
  if (from === -1) return [];
  return [...code.slice(from).matchAll(/id:\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

// Measured on the only three real signups this app has had. One verified their
// email 85 seconds in, created two service zones by 4m17s, and then met "Add
// your dump site" — and never signed in again, not once in the 29 days after.
// The other two never got past the account. Nobody arrives wanting to tell a
// stranger where they unload; they arrive with a book of business.
describe("the setup checklist asks for a customer before a dump site", () => {
  const ids = order();

  it("parses the steps", () => {
    // Every assertion below is an index comparison, and indexOf returns -1 on
    // an empty list — which compares "correctly" against another -1 and proves
    // nothing. This is the guard against that.
    expect(ids.length, `${STEPS}: no steps parsed`).toBeGreaterThanOrEqual(6);
    expect(new Set(ids).size, `${STEPS}: duplicate step ids`).toBe(ids.length);
  });

  it("puts clients before the dump site", () => {
    const clients = ids.indexOf("clients");
    const dump = ids.indexOf("dump_site");
    expect(clients, "the clients step is gone").toBeGreaterThan(-1);
    expect(dump, "the dump_site step is gone").toBeGreaterThan(-1);
    expect(
      clients,
      `"Add or import clients" is step ${clients + 1} and the dump site is step ` +
        `${dump + 1}. A four-minute-old signup is being asked where they unload before ` +
        "they have been asked for a single customer.",
    ).toBeLessThan(dump);
  });

  it("puts nothing ahead of clients but what it takes to price one", () => {
    // CHANGED 2026-10-08, with the guided setup. Clients was second, behind
    // only verifying the email. Verifying is now folded into payouts, the one
    // thing it gates. Ahead of clients there are now exactly two steps, and
    // both are there because the first client NEEDS them: the business
    // address and time zone (thirty seconds, and where every route starts),
    // and the service area, because a client's plan is quoted from the zone
    // their address falls in and with no zone the new-client form has no
    // price to offer. Anything else ahead of clients is the old fault back.
    const clients = ids.indexOf("clients");
    expect(clients).toBeGreaterThan(-1);
    expect(
      ids.slice(0, clients),
      `ahead of clients: ${ids.slice(0, clients).join(", ")}. Only what prices a client may ` +
        "go first; clients is what makes every other screen in the product do something.",
    ).toEqual(["business", "zones"]);
  });

  it("asks who runs the route before where the route ends", () => {
    // The other half of the ordering, and the reason dump_site did not simply
    // move to the end: the planner routes a technician TO it, so it is asked
    // once there is somebody whose route it improves. (It used to be pinned
    // before "Assign your first route", a step that is gone: auto-assign hands
    // visits to the field techs the staff step creates.)
    const staff = ids.indexOf("staff");
    const dump = ids.indexOf("dump_site");
    expect(staff).toBeGreaterThan(-1);
    expect(staff, "who runs the route must come before where it ends").toBeLessThan(dump);
  });
});
