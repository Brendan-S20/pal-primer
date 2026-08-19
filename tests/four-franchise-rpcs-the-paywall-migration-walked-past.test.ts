// Four franchise RPCs the paywall migration walked past.
//
// Owner decision, 2026-08-19: gate all four, and keep the nightly job working.
//
// ── WHAT WAS OPEN ─────────────────────────────────────────────────────────
//
// 20260731230000 put a `franchise_structure` check into six parent-side RPCs
// and named exactly two deliberate exclusions. These four were on neither list:
//
//   set_location_payment_routing   which Stripe account collects a location's
//                                  customer payments
//   set_chargeback_responsibility  who absorbs a reversal
//   generate_franchise_settlements cuts the royalty statements
//   mark_franchise_parent          declares an organization a franchise parent
//
// All four are SECURITY DEFINER, granted to `authenticated`, and check only
// role. The tell that this was an oversight rather than a decision: the READ
// `franchise_payment_routing` was gated while both WRITES that change routing
// were not.
//
// WHICH functions must carry the gate is now derived from the migrations
// themselves in tests/entitlement-parity.test.ts, rather than compared against
// the list that missed these four. This file asserts the two things that
// derivation cannot see: that the nightly job still gets through, and that
// recreating four functions did not widen who can reach them.
//
// ── THE CRON EXEMPTION IS THE FRAGILE PART ────────────────────────────────
//
// `generate_franchise_settlements` admits `auth.role() = 'service_role'` for
// the nightly run. The owner decided explicitly that billing a lapsed
// customer's statements is a separate question from letting them reconfigure,
// so the cron keeps generating for everyone. A plan check applied to that path
// would stop statements being cut the month a franchise's plan lapses — silent,
// monthly, and discovered by a franchisee who never got a bill.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** A migration with its comments removed. Every header in this repo quotes the
 *  SQL it is about, so a whole-file scan reads the explanation as code. */
function sqlCode(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let body = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const m = re.exec(sql);
    if (!m) continue;
    const tail = sql.slice(m.index);
    const open = /\bAS\s+\$(\w*)\$/.exec(tail)!;
    const tag = `$${open[1]}$`;
    body = tail.slice(0, tail.indexOf(tag, open.index + open[0].length));
  }
  return body;
}

const GATED_HERE = [
  "set_location_payment_routing",
  "set_chargeback_responsibility",
  "mark_franchise_parent",
  "generate_franchise_settlements",
] as const;

describe("the four now ask about the plan", () => {
  for (const fn of GATED_HERE) {
    it(`${fn} carries a franchise_structure check after its role check`, () => {
      const body = latestDefinitionOf(fn);
      expect(body.length, `${fn} is in no migration`).toBeGreaterThan(0);
      const role = body.indexOf("public.has_role(auth.uid()");
      const plan = body.indexOf("public.has_plan_entitlement(");
      expect(role, `${fn} lost its role check`).toBeGreaterThan(-1);
      expect(plan, `${fn} has no plan check`).toBeGreaterThan(-1);
      // Role first: "you are not the owner of this franchise" must not be
      // leaked past by an upgrade prompt naming the organization's plan.
      expect(plan, `${fn} asks about the plan before it asks who the caller is`).toBeGreaterThan(
        role,
      );
      expect(body).toContain("'franchise_structure'");
      expect(body).toContain("PLAN_UPGRADE_REQUIRED");
    });
  }
});

describe("the nightly job still cuts statements for everyone", () => {
  const body = latestDefinitionOf("generate_franchise_settlements");

  it("still admits service_role at the role check", () => {
    expect(body).toMatch(/auth\.role\(\) = 'service_role'/);
  });

  it("does not apply the plan check to it", () => {
    // The plausible wrong version passes every other assertion in this file.
    expect(
      body,
      "the plan check now covers the cron path, so a lapsed franchise silently stops being billed",
    ).toMatch(/auth\.role\(\) IS DISTINCT FROM 'service_role'/);
  });

  it("exempts a platform admin for the same reason franchise_signals is not gated", () => {
    // Platform staff are not a tenant and have no plan of their own; gating
    // them would gate the operator on the customer's purchase.
    expect(body).toMatch(/NOT public\.is_platform_admin\(auth\.uid\(\)\)/);
  });

  it("is the routine the nightly run actually calls", () => {
    // The exemption is worth nothing if the caller has moved. This is the
    // wiring, not the guard.
    const nightly = readFileSync(join(ROOT, "src/routes/api/public/hooks/nightly.ts"), "utf8");
    expect(nightly).toMatch(/generate_franchise_settlements/);
  });
});

describe("gating four functions did not widen who can reach them", () => {
  const file = migrationFiles().find((f) =>
    f.includes("four-franchise-rpcs-the-paywall-migration-walked-past"),
  );
  const sql = file ? readFileSync(join(MIGRATIONS, file), "utf8") : "";

  it("exists", () => {
    expect(file, "the four-RPC gate migration is missing").toBeTruthy();
  });

  for (const [fn, args] of [
    ["set_location_payment_routing", "uuid, boolean"],
    ["set_chargeback_responsibility", "uuid, text"],
    ["mark_franchise_parent", "uuid"],
    ["generate_franchise_settlements", "uuid, date, date"],
  ] as const) {
    it(`revokes ${fn} from PUBLIC and anon, then grants it deliberately`, () => {
      // A fresh CREATE in `public` grants EXECUTE to PUBLIC and anon is a
      // member of PUBLIC. Narrowing what a plan may reach while widening who
      // may call it would be a poor trade, and on a replay that is exactly
      // what omitting these lines does.
      const esc = args.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(${esc}\\) FROM PUBLIC, anon;`),
      );
      expect(sql).toMatch(
        new RegExp(
          `GRANT EXECUTE ON FUNCTION public\\.${fn}\\(${esc}\\) TO authenticated, service_role;`,
        ),
      );
    });
  }

  it("reads prosrc by name rather than pg_get_functiondef over a schema", () => {
    expect(sqlCode(sql)).not.toMatch(/pg_get_functiondef\s*\(/);
  });

  it("raises only on what it establishes, and warns about what it measured", () => {
    const survey = sql.slice(sql.indexOf("WHAT WAS MEASURED"));
    expect(survey.length).toBeGreaterThan(0);
    expect(survey).toMatch(/RAISE WARNING/);
    expect(
      survey,
      "a replay must not fail because nobody has bought Enterprise in an empty database",
    ).not.toMatch(/RAISE EXCEPTION/);
    expect(survey).toMatch(/SKIPPED/);
  });

  it("does not assert on operations state a fresh build cannot create", () => {
    expect(sql).not.toMatch(/cron\.job/);
  });
});
