// `organizations.plan_id` must never gain an `ON DELETE` that nulls or cascades.
//
// ── WHY THIS IS A TEST AND NOT A FIX ──────────────────────────────────────
//
// The hole this was filed as — "a plan with tenants on it can be deleted" —
// is not real, and it is worth writing down why, because the reason is a
// Postgres default that is easy to "clean up" by accident.
//
// The column is declared once:
//
//     ALTER TABLE public.organizations
//       ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.platform_plans(id),
//
// with no `ON DELETE` clause, which means `NO ACTION` — the delete is refused
// with a foreign-key violation while any organization still points at the row.
// No later migration drops or re-adds the constraint. There is also no delete
// path in the product at all: `/platform/plans` retires a plan with
// `is_active = false`, and nothing in `src/` issues a delete against
// `platform_plans`. So the protection is real, and it is free.
//
// ── WHAT WOULD MAKE IT UNSAFE ─────────────────────────────────────────────
//
// Adding `ON DELETE SET NULL` — the obvious-looking "don't block deletes"
// change, and the one somebody reaches for when a delete errors in production.
//
// It looks harmless because `plan_tier_for_org` coalesces a missing plan to
// the `launch` floor rather than failing, so nothing crashes. What it does
// instead is silently drop every affected tenant to the cheapest entitlement
// set, and the self-healing does not save them: `assign_billing_tier_for_org`
// re-homes an org onto a plan ONLY for non-paying billing statuses. For
// `active`, `grace` and `past_due` it takes an early return that deliberately
// never writes `plan_id`. So a paying tenant would be left with a null plan,
// on Launch features, indefinitely — the exact silent under-entitlement that
// `20260819160000` was written to remove, arriving by a different door.
//
// `CASCADE` is worse still: it would delete the organizations.
//
// This test therefore pins the absence of both, across every migration.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "supabase", "migrations");
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const all = files.map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), "utf8") }));

/** Statements that create or alter the organizations→platform_plans reference. */
function planIdReferences(): Array<{ file: string; text: string }> {
  const hits: Array<{ file: string; text: string }> = [];
  for (const { file, sql } of all) {
    for (const m of sql.matchAll(/plan_id[^,;]*REFERENCES\s+public\.platform_plans[^,;]*/gi)) {
      hits.push({ file, text: m[0] });
    }
  }
  return hits;
}

describe("a plan cannot be deleted out from under a paying tenant", () => {
  it("still finds the reference at all", () => {
    // If the regex stops matching, every assertion below passes vacuously.
    const refs = planIdReferences();
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it("never nulls or cascades the reference on delete", () => {
    const bad = planIdReferences().filter(({ text }) =>
      /ON\s+DELETE\s+(SET\s+NULL|CASCADE|SET\s+DEFAULT)/i.test(text),
    );
    expect(
      bad.map((b) => `${b.file}: ${b.text.replace(/\s+/g, " ")}`),
      "organizations.plan_id must refuse the delete, not null it out",
    ).toEqual([]);
  });

  it("no migration re-adds the constraint with a delete action", () => {
    // The reference above is created inline with the column. A later migration
    // could drop and re-add the constraint by name instead, which the first
    // check would not see.
    const offenders: string[] = [];
    for (const { file, sql } of all) {
      for (const m of sql.matchAll(
        /ADD\s+CONSTRAINT\s+organizations_plan_id_fkey[\s\S]{0,300}?;/gi,
      )) {
        if (/ON\s+DELETE\s+(SET\s+NULL|CASCADE|SET\s+DEFAULT)/i.test(m[0])) {
          offenders.push(`${file}: ${m[0].replace(/\s+/g, " ").slice(0, 160)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the retirement path that exists instead of a delete", () => {
    // If somebody adds a real delete control, this stops being a test about a
    // constraint and starts being a test about a missing confirmation dialog.
    const page = readFileSync(
      join(__dirname, "..", "src", "routes", "platform.plans.tsx"),
      "utf8",
    );
    expect(page).toMatch(/is_active/);
    expect(page).not.toMatch(/\.delete\(\)/);
  });
});
