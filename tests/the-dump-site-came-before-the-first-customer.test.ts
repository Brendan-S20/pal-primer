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
    expect(ids.length, `${STEPS}: no steps parsed`).toBeGreaterThanOrEqual(7);
    expect(new Set(ids).size, `${STEPS}: duplicate step ids`).toBe(ids.length);
  });

  it("puts clients before the dump site", () => {
    const clients = ids.indexOf("clients");
    const dump = ids.indexOf("dump_site");
    expect(clients, "the clients step is gone").toBeGreaterThan(-1);
    expect(dump, "the dump_site step is gone").toBeGreaterThan(-1);
    expect(
      clients,
      `"Add or import clients" is step ${clients + 1} and "Add your dump site" is step ` +
        `${dump + 1}. A four-minute-old signup is being asked where they unload before ` +
        "they have been asked for a single customer.",
    ).toBeLessThan(dump);
  });

  it("puts clients before everything except verifying the email", () => {
    // Not merely "before the dump site": zones, staff and billing are all
    // arrangement of a thing you have not put in yet, and the checklist is
    // worked top to bottom. verify_email stays first because it is 85 seconds
    // and it gates Stripe.
    expect(ids[0], "verify_email should still lead").toBe("verify_email");
    expect(
      ids[1],
      `step 2 is "${ids[1]}" — clients is what makes every other screen in the ` +
        "product do something, so nothing but the email check goes ahead of it.",
    ).toBe("clients");
  });

  it("still asks for the dump site before the first route", () => {
    // The other half of the ordering, and the reason dump_site did not simply
    // move to the end: the planner routes TO it, so a first route planned
    // without one is the 116-minute version of a 22-minute day.
    const dump = ids.indexOf("dump_site");
    const route = ids.indexOf("route");
    expect(route).toBeGreaterThan(-1);
    expect(
      dump,
      "the dump site must still come before the first route — that is where it pays",
    ).toBeLessThan(route);
  });
});
