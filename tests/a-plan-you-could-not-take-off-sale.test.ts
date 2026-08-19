// The Plans half of the 2026-08-19 owner QA. `updatePlatformPlan` has always
// accepted `isActive` on its own — every field on updatePlatformPlanSchema
// except `planId` is `.optional()`, and the handler builds its patch from
// whichever ones arrived. The capability was there. Nothing could reach it.
//
// ── THE ONLY CALLER WAS A WHOLE-FORM SAVE ─────────────────────────────────
//
// `is_active` lived as a Switch inside the edit dialog, and the only thing that
// sent it was `submit()`, which posts the entire form — name, description,
// monthly price, annual price, per-seat price, included seats, interval, sort
// order — after validating the entire form. One of those checks is:
//
//     if (form.interval === "year" && annualPrice === undefined) {
//       toast.error("Annual plans need an annual price ($/year)");
//       return;
//     }
//
// An annual plan whose `annual_price_cents` is NULL prefills `annualPrice` as
// "", which parses to `undefined`, which trips that guard on every save. Not
// just the price: its name, its sort order and its `is_active` were unreachable
// too, because there was one door and it was bolted. "Stop selling this plan"
// is the last thing you want to discover you cannot do.
//
// The guard itself is right and stays — an annual plan billed from a NULL
// yearly base is the 12x MRR bug the surrounding comments are about. What was
// wrong was routing an unrelated action through it.
//
// ── AND WHY IT IS NOT JUST A SWITCH IN A ROW ──────────────────────────────
//
// Taking a plan off sale is the one plan action with a blast radius outside the
// catalog: it disappears from signup and from every tenant's plan picker, while
// tenants already on it stay on it and keep being billed. That asymmetry is not
// obvious from a toggle, so it is said out loud in a confirmation that names
// the plan and its price, and the toast afterwards names the plan too.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");

const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const plansRoute = read("src/routes/platform.plans.tsx");
const platformFns = read("src/lib/platform.functions.ts");

describe("the premise: the server always supported this", () => {
  it("takes every plan field except the id as optional", () => {
    const schema = platformFns.slice(
      platformFns.indexOf("const updatePlatformPlanSchema"),
      platformFns.indexOf("export const updatePlatformPlan ="),
    );
    expect(schema).toMatch(/isActive: z\.boolean\(\)\.optional\(\)/);
    expect(schema).toMatch(/planId: z\.string\(\)\.uuid\(\)/);
  });

  it("patches only the fields that arrived", () => {
    const handler = platformFns.slice(
      platformFns.indexOf("export const updatePlatformPlan ="),
      platformFns.indexOf("// ---------- Impersonation ----------"),
    );
    expect(handler).toMatch(/if \(data\.isActive !== undefined\) patch\.is_active = data\.isActive/);
  });
});

describe("the guard that made it unreachable is still there", () => {
  it("still refuses to save an annual plan with no annual price", () => {
    // If this ever goes away the fault below stops being a fault — and this
    // test's reason for existing changes. It has not gone away: the 12x MRR
    // bug it prevents is real.
    expect(codeOnly(plansRoute)).toMatch(
      /form\.interval === "year" && annualPrice === undefined/,
    );
  });
});

describe("is_active has an action of its own", () => {
  const code = codeOnly(plansRoute);
  // The write itself, and the confirmation in front of it, checked separately:
  // the confirmation's own copy talks about prices, and a forbidden-field
  // sweep over both would be reading the sentence rather than the payload.
  const block = code.slice(
    code.indexOf("const setActive = useMutation"),
    code.indexOf("const requestSetActive"),
  );
  const confirmBlock = code.slice(
    code.indexOf("const requestSetActive"),
    code.indexOf("const [editing, setEditing]"),
  );

  it("exists at all", () => {
    expect(code).toMatch(/const setActive = useMutation/);
    expect(block.length).toBeGreaterThan(200);
    expect(confirmBlock.length).toBeGreaterThan(200);
  });

  it("sends planId and isActive and nothing else", () => {
    expect(block).toMatch(/planId: v\.plan\.id, isActive: v\.isActive/);
    for (const field of [
      "priceCents",
      "annualPriceCents",
      "includedSeats",
      "pricePerSeatCents",
      "interval",
      "sortOrder",
      "description",
    ]) {
      expect(block, `the is_active action must not resend ${field}`).not.toMatch(
        new RegExp(`\\b${field}\\b`),
      );
    }
  });

  it("does not route through the whole-form submit that blocked it", () => {
    expect(block).not.toMatch(/\bsubmit\(\)/);
    expect(confirmBlock).not.toMatch(/\bsubmit\(\)/);
  });

  it("works in both directions from the row", () => {
    // A plan that can be taken off sale and not put back is the same one-way
    // door in a different place.
    expect(confirmBlock).toMatch(/isActive: false/);
    expect(confirmBlock).toMatch(/isActive: true/);
    expect(code).toMatch(/p\.is_active \? \(/);
  });

  it("confirms with the plan's name and price, not a generic prompt", () => {
    expect(confirmBlock).toMatch(/title: `Stop offering \$\{p\.name\}\?`/);
    expect(confirmBlock).toMatch(/formatBase\(p\)/);
    // The consequence a toggle cannot state: existing tenants are unaffected.
    expect(confirmBlock).toMatch(/Tenants already on it stay on it/);
    expect(confirmBlock).not.toMatch(/Are you sure/i);
  });

  it("says what happened, naming the plan", () => {
    expect(block).toMatch(/toast\.success\(/);
    expect(block).toMatch(/\$\{v\.plan\.name\}/);
  });

  it("surfaces a failure instead of swallowing it", () => {
    expect(block).toMatch(/onError: \(e: Error\) => toast\.error\(e\.message\)/);
  });

  it("refreshes the catalog afterwards", () => {
    expect(block).toMatch(/invalidateQueries\(\{ queryKey: \["platform", "plans"\] \}\)/);
  });
});
