import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_ENTITLEMENTS,
  DEFAULT_TIER,
  ENFORCED_ENTITLEMENTS,
  ENTITLEMENT_LABELS,
  KNOWN_PLAN_SLUGS,
  PLAN_ENTITLEMENTS,
  PLAN_TIERS,
  PLAN_UPGRADE_REQUIRED,
  TIER_NAMES,
  hasEntitlement,
  isPlanUpgradeRequiredError,
  lowestTierWith,
  planTierFromSlug,
  upgradeMessage,
  type Entitlement,
  type PlanTier,
} from "@/lib/entitlements";

// BUILD-1 — plan entitlements have two implementations, exactly like
// permissions (IMP-3), and exactly like permissions they must not drift.
//
// public.has_plan_entitlement() answers the question in SQL;
// PLAN_ENTITLEMENTS answers it in TypeScript. A feature granted on one side and
// not the other is either a paywall with a hole in it or a customer locked out
// of something they paid for, and neither surfaces until it happens in
// production.
//
// The parser is strict on purpose: if the SQL is restructured into a shape it
// cannot read, this FAILS rather than passing vacuously. A parity test that
// quietly stops checking is worse than no test.

const MIGRATION = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260729130000_plan-entitlements.sql",
);

const sql = readFileSync(MIGRATION, "utf8");

/** The migration that made the franchise paywall real in SQL. */
const FRANCHISE_GATE_MIGRATION = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260731230000_a-79-dollar-org-could-mint-franchise-codes.sql",
);

const franchiseGateSql = readFileSync(FRANCHISE_GATE_MIGRATION, "utf8");

/** The (tier, entitlement) pairs in has_plan_entitlement's VALUES list. */
function parseSqlMatrix(source: string): Array<[string, string]> {
  const start = source.indexOf("CREATE OR REPLACE FUNCTION public.has_plan_entitlement");
  if (start === -1)
    throw new Error("has_plan_entitlement is not defined in the expected migration");
  const body = source.slice(start, source.indexOf("$$;", start));
  const valuesAt = body.indexOf("FROM (VALUES");
  if (valuesAt === -1) throw new Error("has_plan_entitlement no longer uses a VALUES matrix");
  const list = body.slice(valuesAt, body.indexOf(") AS m(", valuesAt));
  const pairs = [...list.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\)/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
  if (pairs.length === 0) throw new Error("Parsed no pairs out of the SQL matrix");
  return pairs;
}

/** The slug → tier CASE arms in plan_tier_for_org. */
function parseSqlSlugMap(source: string): Record<string, string> {
  const start = source.indexOf("CREATE OR REPLACE FUNCTION public.plan_tier_for_org");
  if (start === -1) throw new Error("plan_tier_for_org is not defined in the expected migration");
  const body = source.slice(start, source.indexOf("$$;", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+'([a-z_]+)'/g)) out[m[1]] = m[2];
  if (Object.keys(out).length === 0)
    throw new Error("Parsed no slug arms out of plan_tier_for_org");
  return out;
}

const sqlPairs = parseSqlMatrix(sql);
const sqlGrants = (tier: string, entitlement: string) =>
  sqlPairs.some(([t, e]) => t === tier && e === entitlement);
const sqlSlugMap = parseSqlSlugMap(sql);

describe("TS ↔ SQL entitlement parity (BUILD-1)", () => {
  it("grants exactly the same entitlements on both sides, for every tier", () => {
    const mismatches: string[] = [];
    for (const tier of PLAN_TIERS) {
      for (const entitlement of ALL_ENTITLEMENTS) {
        const ts = hasEntitlement(tier, entitlement);
        const db = sqlGrants(tier, entitlement);
        if (ts !== db) {
          mismatches.push(
            `${tier} / ${entitlement}: TypeScript says ${ts ? "INCLUDED" : "NOT INCLUDED"}, SQL says ${db ? "INCLUDED" : "NOT INCLUDED"}`,
          );
        }
      }
    }
    expect(
      mismatches,
      `The SQL mirror of PLAN_ENTITLEMENTS has drifted:\n  ${mismatches.join("\n  ")}\n\nUpdate public.has_plan_entitlement and src/lib/entitlements.ts together.`,
    ).toEqual([]);
  });

  it("never references a tier or entitlement the TS matrix does not define", () => {
    // Either would be a rule nothing in the app knows to check.
    const tiers = new Set<string>(PLAN_TIERS);
    const ents = new Set<string>(ALL_ENTITLEMENTS);
    expect(sqlPairs.filter(([t]) => !tiers.has(t)).map(([t]) => t)).toEqual([]);
    expect(sqlPairs.filter(([, e]) => !ents.has(e)).map(([, e]) => e)).toEqual([]);
  });

  it("maps every plan slug to the same tier on both sides", () => {
    const mismatches: string[] = [];
    for (const slug of KNOWN_PLAN_SLUGS) {
      const ts = planTierFromSlug(slug);
      const db = sqlSlugMap[slug];
      if (ts !== db) mismatches.push(`${slug}: TypeScript → ${ts}, SQL → ${db ?? "(absent)"}`);
    }
    expect(
      mismatches,
      `plan_tier_for_org has drifted from SLUG_TO_TIER:\n  ${mismatches.join("\n  ")}`,
    ).toEqual([]);
  });

  it("covers every plan slug in the live catalog", () => {
    // Verified against the live platform_plans table on 2026-07-29. A slug
    // added to the catalog without being mapped here silently resolves to the
    // floor tier, which would quietly withhold features from whoever bought it.
    const LIVE_CATALOG_SLUGS = [
      "free",
      "puppy",
      "launch",
      "fetch",
      "growth",
      "scoop",
      "scale",
      "enterprise",
      "haul",
      "pack",
      "kennel",
    ];
    const unmapped = LIVE_CATALOG_SLUGS.filter((s) => !KNOWN_PLAN_SLUGS.includes(s));
    expect(
      unmapped,
      `Plan slugs in the catalog with no tier mapping: ${unmapped.join(", ")}`,
    ).toEqual([]);
    for (const slug of LIVE_CATALOG_SLUGS) expect(sqlSlugMap[slug]).toBeTruthy();
  });
});

describe("entitlement matrix (BUILD-1)", () => {
  it("matches the tiers published on the pricing page", () => {
    // These assertions ARE the marketing commitment. If one has to change, the
    // pricing page changes with it — that is the point of writing them out
    // rather than deriving them from the matrix under test.
    expect(hasEntitlement("launch", "advanced_analytics")).toBe(false);
    expect(hasEntitlement("growth", "advanced_analytics")).toBe(true);
    expect(hasEntitlement("scale", "advanced_analytics")).toBe(true);

    expect(hasEntitlement("growth", "regional_reporting")).toBe(false);
    expect(hasEntitlement("scale", "regional_reporting")).toBe(true);

    expect(hasEntitlement("scale", "franchise_structure")).toBe(false);
    expect(hasEntitlement("enterprise", "franchise_structure")).toBe(true);
  });

  it("is monotone up the ladder — no tier loses something the tier below has", () => {
    // A customer who upgrades must never end up with less. Worth asserting
    // structurally rather than trusting six hand-written lists.
    for (let i = 1; i < PLAN_TIERS.length; i++) {
      const lower = PLAN_ENTITLEMENTS[PLAN_TIERS[i - 1]];
      const higher = PLAN_ENTITLEMENTS[PLAN_TIERS[i]];
      for (const e of lower) {
        expect(higher, `${PLAN_TIERS[i]} lost "${e}" that ${PLAN_TIERS[i - 1]} has`).toContain(e);
      }
    }
  });

  it("has at least one tier granting every entitlement it defines", () => {
    // An entitlement no plan includes is a feature nobody can ever buy.
    for (const e of ALL_ENTITLEMENTS) {
      expect(lowestTierWith(e), `No plan includes "${e}"`).not.toBeNull();
    }
  });

  it("gives Launch nothing beyond the core platform", () => {
    expect(PLAN_ENTITLEMENTS.launch).toEqual([]);
  });

  it("gives Enterprise everything", () => {
    for (const e of ALL_ENTITLEMENTS) expect(hasEntitlement("enterprise", e)).toBe(true);
  });

  it("names, labels, and enforcement lists stay complete as entitlements are added", () => {
    for (const e of ALL_ENTITLEMENTS) expect(ENTITLEMENT_LABELS[e]).toBeTruthy();
    for (const t of PLAN_TIERS) expect(TIER_NAMES[t]).toBeTruthy();
    // ENFORCED_ENTITLEMENTS is the honest record of which of these have a real
    // check behind them. Everything in it must be a real entitlement; the ones
    // NOT in it describe features the product has not built.
    for (const e of ENFORCED_ENTITLEMENTS) expect(ALL_ENTITLEMENTS).toContain(e);
    expect(ENFORCED_ENTITLEMENTS).toEqual(["advanced_analytics", "franchise_structure"]);
  });
});

describe("tier resolution (BUILD-1)", () => {
  it("resolves the four live slugs", () => {
    expect(planTierFromSlug("launch")).toBe("launch");
    expect(planTierFromSlug("growth")).toBe("growth");
    expect(planTierFromSlug("scale")).toBe("scale");
    expect(planTierFromSlug("enterprise")).toBe("enterprise");
  });

  it("falls to the FLOOR, never the ceiling, on anything it doesn't recognize", () => {
    // The failure that matters is handing out Enterprise because of a typo or a
    // half-configured org.
    expect(planTierFromSlug(null)).toBe(DEFAULT_TIER);
    expect(planTierFromSlug(undefined)).toBe(DEFAULT_TIER);
    expect(planTierFromSlug("")).toBe(DEFAULT_TIER);
    expect(planTierFromSlug("some-future-plan")).toBe(DEFAULT_TIER);
    expect(DEFAULT_TIER).toBe("launch");
    expect(PLAN_ENTITLEMENTS[DEFAULT_TIER]).toEqual([]);
  });

  it("treats a null tier as entitled to nothing", () => {
    for (const e of ALL_ENTITLEMENTS) {
      expect(hasEntitlement(null, e)).toBe(false);
      expect(hasEntitlement(undefined, e)).toBe(false);
    }
  });
});

describe("upgrade signalling (BUILD-1)", () => {
  it("names the cheapest tier that includes the feature, and the current one", () => {
    const msg = upgradeMessage("advanced_analytics", "launch");
    expect(msg).toContain("Advanced analytics");
    expect(msg).toContain("Growth");
    expect(msg).toContain("Launch");
  });

  it("carries a code the client can distinguish from an authorization failure", () => {
    // "Your role can't do this" and "your plan doesn't include this" need
    // different UI; collapsing them tells a paying owner to go ask their admin.
    const msg = upgradeMessage("franchise_structure", "scale");
    expect(msg).toContain(PLAN_UPGRADE_REQUIRED);
    expect(isPlanUpgradeRequiredError(new Error(msg))).toBe(true);
    expect(isPlanUpgradeRequiredError(msg)).toBe(true);
    // Deserialized across the server-fn boundary as a plain object.
    expect(isPlanUpgradeRequiredError({ message: msg })).toBe(true);
  });

  it("does not mistake other failures for an upgrade prompt", () => {
    expect(isPlanUpgradeRequiredError(new Error("Not authorized"))).toBe(false);
    expect(isPlanUpgradeRequiredError(null)).toBe(false);
    expect(isPlanUpgradeRequiredError(undefined)).toBe(false);
    expect(isPlanUpgradeRequiredError({})).toBe(false);
  });

  it("every tier and entitlement pair produces a usable message", () => {
    for (const tier of PLAN_TIERS as readonly PlanTier[]) {
      for (const e of ALL_ENTITLEMENTS as Entitlement[]) {
        expect(upgradeMessage(e, tier).length).toBeGreaterThan(20);
      }
    }
  });
});

// ── The franchise paywall, enforced in SQL ──────────────────────────────────
//
// has_plan_entitlement() mirrored PLAN_ENTITLEMENTS faithfully and was called
// by NOTHING, so the franchise paywall existed only in TypeScript. Every
// parent-side franchise RPC is granted to `authenticated` and checked only
// ROLE, which a browser can reach with supabase.rpc(...) without ever entering
// the server-fn funnel that holds requireEntitlement — an owner on $79 Launch
// could mint link codes, open locations, and read every location's revenue.
//
// These assertions read the migration as TEXT, like the parity checks above and
// like tests/cron-auth and tests/org-write do, so they need no database
// credentials in CI. They cannot prove the guard REJECTS anyone — only a live
// call can, and that was done against the live database when the migration was
// applied. What they can prove, and what actually rots, is that the guard is
// still there, still on the right six functions, still positioned after the
// role check, and still saying what the TypeScript says.

/** Every CREATE OR REPLACE FUNCTION body in a migration, keyed by name.
 *  Strict on purpose: a migration restructured past this parser FAILS rather
 *  than passing vacuously with zero functions checked. */
function parseFunctionBodies(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /CREATE OR REPLACE FUNCTION public\.(\w+)\s*\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/g;
  for (const m of source.matchAll(re)) out[m[1]] = m[2];
  if (Object.keys(out).length === 0) {
    throw new Error("Parsed no function bodies out of the franchise gate migration");
  }
  return out;
}

const franchiseGateBodies = parseFunctionBodies(franchiseGateSql);

// ── WHY THIS SECTION NO LONGER READS ONE FILE ────────────────────────────────
//
// It used to parse 20260731230000 alone and assert its six functions were
// "exactly the six — no more, no fewer". That is a list, and a list only knows
// about the functions that were on it. Four parent-side RPCs
// (set_location_payment_routing, set_chargeback_responsibility,
// generate_franchise_settlements, mark_franchise_parent) were missed by that
// migration and this test agreed with it for three weeks, because the thing it
// compared the six against was the six.
//
// The tell was already on the screen: the READ franchise_payment_routing was
// gated and both WRITES that change routing were not. Nobody chooses that.
//
// So the SCOPE is now derived from the migrations rather than typed here. A new
// franchise RPC added tomorrow with an owner check and no plan check joins the
// list on its own and fails this file until it is gated or explicitly excused.
// The pinned names below are still pinned — but as a floor the derivation must
// reach, not as the definition of what to check.

/** Every function's LATEST definition across every migration, keyed by name.
 *
 *  CREATE OR REPLACE means the last file to define a routine is the one in
 *  force; checking an earlier copy is how a regression walks past a green test.
 *  Handles both `AS $$` and `AS $function$`, which this repo uses
 *  interchangeably, and stops at the matching close so a second function in the
 *  same file is not read as part of the first. */
function latestFunctionDefinitions(): Record<string, { file: string; body: string }> {
  const out: Record<string, { file: string; body: string }> = {};
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    // Comments stripped: this asks what a routine DOES, and the headers in
    // these files quote SQL at length.
    const code = readFileSync(join(dir, file), "utf8").replace(/--[^\n]*/g, "");
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(/gi;
    for (const m of code.matchAll(re)) {
      const tail = code.slice(m.index!);
      const open = /\bAS\s+\$(\w*)\$/.exec(tail);
      if (!open) continue;
      const tag = `$${open[1]}$`;
      const close = tail.indexOf(tag, open.index! + open[0].length);
      if (close === -1) continue;
      out[m[1].toLowerCase()] = { file, body: tail.slice(0, close) };
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error("Parsed no function definitions out of supabase/migrations");
  }
  return out;
}

const LATEST_DEFINITIONS = latestFunctionDefinitions();

/** Parent-side franchise RPCs that are deliberately NOT plan-gated, each with
 *  the reason. An entry here is a decision on the record; an absence is a gap. */
const FRANCHISE_RPCS_DELIBERATELY_UNGATED: Record<string, string> = {
  redeem_franchise_link_code:
    "the CHILD side. A franchisee is a location somebody else recruited and is most likely on Launch — requiring Enterprise to ACCEPT an invitation would mean linking only works if every location independently buys the most expensive plan.",
  unlink_franchise_child:
    "leaving. A paywall may withhold a capability but must not lock an organization inside a relationship: a franchise whose plan lapses must still be able to release its locations. src/lib/franchise-membership.functions.ts makes the same argument for removeFranchiseLocation having no requireEntitlement.",
};

/**
 * The PARENT side, derived: a routine that decides something about a franchise
 * relationship and admits its caller on the strength of being an OWNER.
 *
 * Each clause earns its place. `'owner'::public.app_role` is what separates a
 * franchise capability from a platform-admin diagnostic (`franchise_signals`,
 * which checks is_platform_admin and has no tenant to bill) and from the
 * primitives (`has_permission`). `RETURNS trigger` drops the two statement
 * triggers, which are not callable RPCs at all. The word test drops routines
 * that mention no franchise concept.
 */
function parentSideFranchiseRpcs(): string[] {
  return Object.entries(LATEST_DEFINITIONS)
    .filter(([name, { body }]) => {
      if (name in FRANCHISE_RPCS_DELIBERATELY_UNGATED) return false;
      if (/RETURNS\s+trigger/i.test(body)) return false;
      if (!/franchise|royalty|parent_organization_id/i.test(body)) return false;
      return body.includes("'owner'::public.app_role");
    })
    .map(([name]) => name)
    .sort();
}

/** The ten, pinned. Not the definition of the scope — see the note above — but
 *  a floor: if the derivation ever returns fewer than these, it has stopped
 *  looking rather than found the schema clean. */
const PARENT_SIDE_FRANCHISE_RPCS = parentSideFranchiseRpcs();

const PINNED_PARENT_SIDE_FRANCHISE_RPCS = [
  "franchise_rollup",
  "franchise_children",
  "franchise_payment_routing",
  "create_franchise_link_code",
  "set_child_royalty_percent",
  "provision_franchise_location",
  // Added 2026-08-19: gated by 20260819140000. Until then every one of these
  // was SECURITY DEFINER, granted to `authenticated`, owner-checked and free of
  // any plan check — so a lapsed franchise could still redirect where a
  // location's customer money lands, move chargeback liability, cut settlement
  // statements and re-mark itself a parent.
  "set_location_payment_routing",
  "set_chargeback_responsibility",
  "generate_franchise_settlements",
  "mark_franchise_parent",
];

describe("franchise_structure is gated in SQL, not only in TypeScript (BUILD-1)", () => {
  it("finds the parent-side RPCs by what they do, not by a list", () => {
    // Both halves pinned, the way the cron scan in the-wiring-is-connected is.
    // A derivation that quietly matched nothing would make every assertion
    // below vacuously green, which is exactly how the six-function version of
    // this file agreed with the migration that missed four.
    expect(
      PARENT_SIDE_FRANCHISE_RPCS,
      "the scan found no parent-side franchise RPCs at all — it is reading nothing",
    ).not.toEqual([]);
    expect(PARENT_SIDE_FRANCHISE_RPCS).toEqual([...PINNED_PARENT_SIDE_FRANCHISE_RPCS].sort());
  });

  it("puts a franchise_structure check in every one of them", () => {
    const missing = PARENT_SIDE_FRANCHISE_RPCS.filter(
      (fn) =>
        !/public\.has_plan_entitlement\(\s*\w+\s*,\s*'franchise_structure'\s*\)/.test(
          LATEST_DEFINITIONS[fn]?.body ?? "",
        ),
    );
    expect(
      missing,
      `These franchise RPCs are granted to \`authenticated\` with no plan check, so any signed-in owner can call them directly: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("names a reason for every one it does NOT gate", () => {
    // The exclusions are the part of a derived scope that can rot into a
    // dumping ground. Each one has to still exist and still be a franchise RPC,
    // or it is a name somebody added to make a failure go away.
    for (const [fn, why] of Object.entries(FRANCHISE_RPCS_DELIBERATELY_UNGATED)) {
      expect(
        LATEST_DEFINITIONS[fn],
        `${fn} is excused from the plan gate and no longer exists`,
      ).toBeTruthy();
      expect(why.length, `${fn} is excused with no reason given`).toBeGreaterThan(40);
      expect(
        LATEST_DEFINITIONS[fn].body,
        `${fn} is excused from a gate it would never have been in scope for`,
      ).toContain("'owner'::public.app_role");
    }
  });

  it("checks the ROLE first and the plan second", () => {
    // "You are not the owner of this franchise" must not be leaked past by an
    // upgrade prompt — that would tell a stranger which plan a franchise is on.
    for (const fn of PARENT_SIDE_FRANCHISE_RPCS) {
      const body = LATEST_DEFINITIONS[fn].body;
      const role = body.indexOf("public.has_role(");
      const plan = body.indexOf("public.has_plan_entitlement(");
      expect(role, `${fn} lost its role check`).toBeGreaterThan(-1);
      expect(plan, `${fn} lost its plan check`).toBeGreaterThan(-1);
      expect(plan, `${fn} asks about the plan before it asks who the caller is`).toBeGreaterThan(
        role,
      );
    }
  });

  it("tells a blocked caller what to buy, in the same words the app uses", () => {
    // Not "Not authorized" — that sends a paying owner to ask their admin for
    // access they already hold. The SQL message is upgradeMessage() with the
    // tier interpolated, so this ties the two wordings together.
    const needed = lowestTierWith("franchise_structure");
    expect(needed, "No plan includes franchise_structure").toBe("enterprise");
    const sqlText =
      `${PLAN_UPGRADE_REQUIRED}: ${ENTITLEMENT_LABELS.franchise_structure} is included on ` +
      `${TIER_NAMES[needed as PlanTier]} and above. This organization is on %.`;
    for (const fn of PARENT_SIDE_FRANCHISE_RPCS) {
      expect(
        LATEST_DEFINITIONS[fn].body,
        `${fn}'s refusal has drifted from upgradeMessage()`,
      ).toContain(sqlText);
    }
    expect(upgradeMessage("franchise_structure", "launch")).toBe(
      sqlText.replace("%.", `${TIER_NAMES.launch}.`),
    );
  });

  it("derives the tier's display name the way the SQL does", () => {
    // The SQL fills that %s with initcap(plan_tier_for_org(org)) rather than
    // carrying a second copy of TIER_NAMES. That only stays honest while every
    // display name is the capitalised slug.
    for (const tier of PLAN_TIERS) {
      const initcap = tier.charAt(0).toUpperCase() + tier.slice(1);
      expect(
        TIER_NAMES[tier],
        `initcap('${tier}') no longer produces its pricing-page name, so the SQL upgrade prompt would name a tier the customer cannot find on the site`,
      ).toBe(initcap);
    }
    for (const fn of PARENT_SIDE_FRANCHISE_RPCS) {
      expect(LATEST_DEFINITIONS[fn].body).toContain("initcap(public.plan_tier_for_org(");
    }
  });

  it("leaves the CHILD side and the platform-admin side alone", () => {
    // redeem_franchise_link_code is how a franchisee ACCEPTS an invitation.
    // Requiring Enterprise to accept one would mean linking only works if every
    // location independently buys the most expensive plan — see the header of
    // src/lib/franchise-membership.functions.ts. franchise_signals is
    // platform-admin only; platform staff are not a tenant and have no plan.
    expect(franchiseGateSql).not.toContain("FUNCTION public.redeem_franchise_link_code");
    expect(franchiseGateSql).not.toContain("FUNCTION public.franchise_signals");
    expect(franchiseGateBodies).not.toHaveProperty("redeem_franchise_link_code");
    expect(franchiseGateBodies).not.toHaveProperty("franchise_signals");
  });

  it("keeps franchise_structure on the list of entitlements that are really enforced", () => {
    expect(ENFORCED_ENTITLEMENTS).toContain("franchise_structure");
    expect(hasEntitlement("scale", "franchise_structure")).toBe(false);
    expect(hasEntitlement("enterprise", "franchise_structure")).toBe(true);
  });
});
