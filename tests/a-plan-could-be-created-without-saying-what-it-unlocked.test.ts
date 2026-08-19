// A plan could be created without saying what it unlocked.
//
// ── THE FAULT ───────────────────────────────────────────────────────────────
//
// `SLUG_TO_TIER` in src/lib/entitlements.ts and the CASE inside
// `plan_tier_for_org` were two hand-written copies of the same eleven literals,
// each ending `ELSE 'launch'`. Nothing asked the PLAN what it unlocked, because
// the plan had no column to say it in.
//
// That was survivable while only a migration could change the catalog. Plan
// creation shipped on 2026-08-19 (`createPlatformPlan`, and the dialog in
// src/routes/platform.plans.tsx), so a platform admin can mint a plan with any
// slug — and `assign_billing_tier_for_org` will then MOVE tenants onto it by
// itself, picking the cheapest active non-enterprise plan whose `included_seats`
// covers the org. A new "Pro" plan at $999/mo would be sold, subscribed to and
// billed, and every entitlement check for its customers would answer with the
// Launch feature set: no error, no warning, no failing test — the parity test
// compared a hardcoded list of catalog slugs against a hardcoded map.
//
// The customer pays for Analytics and Franchise Management and is told to
// upgrade.
//
// ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
//
// Three things, and the middle one is a decision as much as a behaviour:
//
//   1. A plan's tier is DECLARED, and the declaration is carried all the way to
//      the column — form → server fn → INSERT.
//   2. An unrecognised slug is LOUD but NOT FATAL at resolution time. See the
//      block on that test for why throwing there would be worse than the bug.
//   3. The declaration is refused when the running app could not honour it, at
//      creation time, while somebody is looking at a form.
//
// The TS ↔ SQL half — the column, the backfill, and plan_tier_for_org reading
// it — is in tests/entitlement-parity.test.ts, next to the matrix it belongs
// with.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TIER,
  PLAN_TIERS,
  PLAN_TIER_COLUMN,
  TIER_NAMES,
  UNMAPPED_PLAN_SLUG,
  __resetUnmappedSlugLog,
  isKnownPlanSlug,
  isPlanTier,
  planTierDeclarationProblem,
  planTierFromSlug,
} from "@/lib/entitlements";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
  __resetUnmappedSlugLog();
});

describe("a new plan has to declare what it unlocks (BUILD-1)", () => {
  it("refuses a plan that declares nothing, or declares something that is not a tier", () => {
    for (const bad of [undefined, null, "", "Pro", "premium", "LAUNCH", 3, {}]) {
      const problem = planTierDeclarationProblem("launch", bad);
      expect(problem, `"${String(bad)}" was accepted as a tier`).toBeTruthy();
      expect(problem).toContain("declare what it unlocks");
    }
    expect(isPlanTier("launch")).toBe(true);
    expect(isPlanTier("premium")).toBe(false);
  });

  it("accepts each live slug declaring the tier it actually resolves to", () => {
    for (const slug of ["launch", "growth", "scale", "enterprise"] as const) {
      expect(planTierDeclarationProblem(slug, slug)).toBeNull();
    }
    // The retired slugs are Launch-equivalent and may still be re-declared as
    // such; they are in the catalog and the map has to stay total over it.
    expect(planTierDeclarationProblem("kennel", "launch")).toBeNull();
    expect(isKnownPlanSlug("kennel")).toBe(true);
  });

  it("refuses a slug the running app has never heard of, and says how to fix it", () => {
    // THE CASE THE OWNER ASKED ABOUT: a $999 "Pro" plan. Before this it was
    // created without complaint and quietly served Launch.
    expect(isKnownPlanSlug("pro")).toBe(false);
    const problem = planTierDeclarationProblem("pro", "scale");
    expect(problem, "a plan with an unmapped slug was accepted").toBeTruthy();
    expect(problem).toContain("pro");
    expect(problem).toContain("SLUG_TO_TIER");
    expect(problem).toContain("src/lib/entitlements.ts");
    // It has to name the consequence, not just the rule. "Invalid slug" would
    // send somebody to change the slug rather than the map.
    expect(problem).toContain(TIER_NAMES[DEFAULT_TIER]);
  });

  it("refuses a declaration the app would contradict", () => {
    // growth resolves to Growth in TypeScript. A row declaring Scale would mean
    // the database grants regional reporting and the app does not — one
    // customer, two answers, depending which side of the wire the check is on.
    const problem = planTierDeclarationProblem("growth", "scale");
    expect(problem, "a plan declaring a tier the app contradicts was accepted").toBeTruthy();
    expect(problem).toContain("Growth");
    expect(problem).toContain("Scale");
  });

  it("needs a slug before it can check one", () => {
    expect(planTierDeclarationProblem("", "launch")).toBeTruthy();
    expect(planTierDeclarationProblem(null, "launch")).toBeTruthy();
  });
});

describe("an unrecognised slug is loud, not fatal (BUILD-1)", () => {
  it("logs a report naming the slug and the risk, and still answers", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tier = planTierFromSlug("pro");

    expect(tier, "an unmapped slug must resolve to the floor, never the ceiling").toBe(
      DEFAULT_TIER,
    );
    expect(spy, "an unmapped plan slug resolved silently").toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain(UNMAPPED_PLAN_SLUG);
    expect(line).toContain("pro");
    expect(line).toContain(PLAN_TIER_COLUMN);
    // The sentence a person reading an alert needs: somebody may be paying for
    // something they are not getting.
    expect(line.toLowerCase()).toContain("paying");
  });

  it("does not THROW at resolution time, on purpose", () => {
    // The plausible fix, and the wrong one twice over.
    //
    // First: this runs inside `planTierForOrg` → `requireEntitlement`, in the
    // same server-fn funnel as ordinary feature calls. Under-granting shows a
    // paying customer an upgrade prompt for something they bought — visible,
    // reportable, and their data is all still there. Throwing takes the whole
    // session down for a tenant whose only crime is being on a plan somebody
    // mis-created. The second failure is strictly worse than the first.
    //
    // Second: it would not even reach anyone. entitlements.server.ts wraps this
    // call in a try/catch that falls back to DEFAULT_TIER — asserted below —
    // so a throw is swallowed and the tenant lands on the floor anyway, minus
    // the log line. A "fix" that only changes the noise is not a fix.
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => planTierFromSlug("pro")).not.toThrow();
    expect(planTierFromSlug("pro")).toBe(DEFAULT_TIER);

    const server = read("src/lib/entitlements.server.ts");
    expect(server).toContain("planTierFromSlug");
    const call = server.indexOf("planTierFromSlug(");
    const catchAt = server.indexOf("} catch {", call);
    expect(
      catchAt,
      "entitlements.server.ts no longer catches around the tier lookup — re-read the argument above before making planTierFromSlug throw",
    ).toBeGreaterThan(call);
    expect(server.slice(catchAt, catchAt + 400)).toContain("tier = DEFAULT_TIER");
  });

  it("complains once per slug, not once per lookup", () => {
    // Resolution is cached per org for a minute, not per slug — a hundred orgs
    // on one bad plan would otherwise write a hundred identical lines a minute
    // and the alert would be turned off by lunchtime.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 50; i++) planTierFromSlug("pro");
    expect(spy).toHaveBeenCalledTimes(1);
    planTierFromSlug("also-unknown");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("says nothing about a plan that is simply absent", () => {
    // No plan at all is an ordinary state — a tenant mid-signup — and it
    // resolves to the floor without a word. Only an unrecognised slug is a
    // defect.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(planTierFromSlug(null)).toBe(DEFAULT_TIER);
    expect(planTierFromSlug(undefined)).toBe(DEFAULT_TIER);
    expect(planTierFromSlug("")).toBe(DEFAULT_TIER);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the declaration is carried all the way to the column (BUILD-1)", () => {
  const fns = () => read("src/lib/platform.functions.ts");
  const route = () => read("src/routes/platform.plans.tsx");

  it("requires the tier on the way in — never optional, never defaulted", () => {
    const src = fns();
    const field = /entitlementTier:\s*z\.[^,\n]*/.exec(src);
    expect(field, "createPlatformPlanSchema has no entitlementTier field").toBeTruthy();
    expect(
      field![0],
      "entitlementTier is optional or defaulted, so a caller that says nothing gets a plan that unlocks nothing — silently, which is the whole fault",
    ).not.toMatch(/\.optional\(|\.default\(|\.nullable\(/);
  });

  it("refuses in the server function, not only in the dialog", () => {
    // Guardrail 10.4: a form check is a courtesy. The server fn is reachable
    // directly by anyone who is a platform admin, and this is the only copy of
    // the rule either of them runs.
    const src = fns();
    expect(src).toContain("planTierDeclarationProblem(slug, data.entitlementTier)");
    expect(src).toMatch(/if\s*\(tierProblem\)\s*throw new Error\(tierProblem\)/);
  });

  it("writes the declaration to the plan row", () => {
    expect(fns(), `createPlatformPlan does not write platform_plans.${PLAN_TIER_COLUMN}`).toContain(
      `${PLAN_TIER_COLUMN}: data.entitlementTier`,
    );
  });

  it("asks for it in the create dialog, with every tier offered", () => {
    const src = route();
    expect(src).toContain("entitlementTier: newPlan.entitlementTier");
    expect(src).toContain("planTierDeclarationProblem(newSlug, newPlan.entitlementTier)");
    // The options come from PLAN_TIERS rather than four hand-written <option>s,
    // so a fifth tier cannot appear in the matrix and be unpickable here.
    expect(src).toMatch(/PLAN_TIERS\.map\(/);
    for (const t of PLAN_TIERS) expect(src).not.toContain(`<option value="${t}">`);
  });

  it("no longer tells the reader that entitlements fall back to Launch", () => {
    // The stopgap the owner asked to have replaced: the dialog warned, in
    // words, about the exact hole it was creating.
    const src = route();
    expect(
      src,
      "the create dialog still says entitlements fall back to the Launch tier — it should no longer be true",
    ).not.toMatch(/fall back to the Launch tier/i);
    expect(src).toContain(`platform_plans.${PLAN_TIER_COLUMN}`);
  });
});

describe("the app reads the column too, not just the database", () => {
  // ── THE HALF THE COLUMN DOES NOT FIX BY ITSELF ────────────────────────────
  //
  // `plan_tier_for_org` reads `entitlement_tier`, so SQL is data-driven for any
  // plan. But a tenant's entitlements are resolved in TypeScript, by
  // `entitlements.server.ts`, which selected `platform_plans(slug)` and handed
  // the slug to SLUG_TO_TIER — a hand-written map. So minting a genuinely new
  // slug still needed a code change and a deploy, and until that happened
  // whoever bought the plan got the floor.
  //
  // ── AND THE LANDMINE IN THE OBVIOUS FIX ───────────────────────────────────
  //
  // The obvious edit is `select("plan_id, platform_plans(entitlement_tier)")`.
  // It is worse than what it replaces. PostgREST 400s an embedded select that
  // names a column the schema does not have, `planTierForOrg` catches every
  // failure and resolves DEFAULT_TIER, and the migration adding the column is
  // applied by hand, separately from the deploy. So between the app shipping
  // and the migration running, EVERY organisation resolves to the floor:
  // Enterprise tenants lose franchise management, and it comes back later with
  // nothing connecting the two events.
  //
  // `*` returns whatever columns exist. That is the whole reason it is there,
  // and it is what these assertions protect.
  const src = read("src/lib/entitlements.server.ts");
  /** Comments stripped: the block above the select QUOTES the banned form in
   *  order to explain why it is banned, and a bare negative match on the file
   *  fails on the explanation rather than on the code. */
  const code = src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

  it("selects the whole plan row rather than naming the new column", () => {
    expect(code).toMatch(/\.select\("plan_id, platform_plans\(\*\)"\)/);
    expect(
      code,
      "naming the column 400s until the migration is applied, dropping every org to the floor",
    ).not.toMatch(/platform_plans\(entitlement_tier/);
  });

  it("prefers the declared tier, and validates it before trusting it", () => {
    // A value outside the CHECK — from a restored backup, or a direct INSERT —
    // must not be cast straight to PlanTier and handed to hasEntitlement.
    expect(src).toMatch(/PLAN_TIERS as readonly string\[\]\)\.includes\(declared\)/);
    expect(src).toMatch(/plan\?\.\[PLAN_TIER_COLUMN\]/);
  });

  it("falls back to the slug map, not to the floor", () => {
    // The distinction this whole change is about: an unmapped slug gets a
    // logged report, a missing column gets the behaviour this file had
    // yesterday. Neither is a silent floor.
    expect(src).toMatch(/planTierFromSlug\(typeof plan\?\.slug === "string" \? plan\.slug : null\)/);
  });

  it("still resolves the floor when the lookup itself fails", () => {
    // Unchanged and deliberate: handing out Enterprise because a query
    // hiccuped is the failure that matters. Pinned so the fallback above is
    // never confused with this one.
    expect(src).toMatch(/\} catch \{/);
    expect(src.slice(src.indexOf("} catch {"))).toMatch(/tier = DEFAULT_TIER;/);
  });
});
