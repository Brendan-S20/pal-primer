import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The seven settlement-math claims, worked through one at a time against the
// live database. Four reproduced; each number below came out of a transaction
// that rolled itself back.
//
//   1  voiding a statement stranded its adjustments forever
//        AFTER VOID: aug_adj=0 | july_status=void | adj_now=applied linked_void=true
//   2  a reversed deduction stayed on the draft it was applied to
//        DRAFT STILL SAYS: adj=20000 net=70000   (regenerating gave adj=0 net=90000)
//   3  an adjustment landed on whichever statement was cut first
//        aug_adj=20000  july_adj=0   (the July chargeback landed on AUGUST)
//   4  changing a royalty rate restated closed periods
//        july_royalty_at_10pct=10000 -> after_rate_change=25000 pct_on_row=25.00
//
// Three did not reproduce and are pinned here too, because a dismissed claim is
// worth as much as a confirmed one — and because the reason each was dismissed
// is a property that could quietly stop being true.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
}

/** CREATE OR REPLACE means the LAST definition is the one that runs. */
function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let found = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  return found;
}

/** Just the body of that one function, so an assertion cannot be satisfied by
 *  another routine or by the prose above it. This file's whole subject is
 *  arithmetic, and matching the comment that describes the arithmetic instead
 *  of the arithmetic is how a check ends up green while measuring nothing. */
function bodyOf(fn: string): string {
  const sql = latestDefinitionOf(fn);
  const i = sql.indexOf(`FUNCTION public.${fn}`);
  if (i < 0) return "";
  const body = sql.slice(i);
  return body.slice(0, body.indexOf("$function$;"));
}

describe("generate_franchise_settlements", () => {
  const body = bodyOf("generate_franchise_settlements");

  it("finds the routine at all", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("only sweeps adjustments already known when the period closed", () => {
    // Without this an August chargeback could appear on a July statement, which
    // is the property that makes a statement reconcilable against the
    // franchisee's own books for that month.
    expect(body).toMatch(/fa\.created_at\s*<\s*_to/);
  });

  it("applies that filter to BOTH the sum and the consume", () => {
    // They must agree exactly. Consuming something the statement did not count
    // marks it applied against a statement it is not on — which is the void
    // stranding bug reached by another route.
    expect(body.match(/fa\.created_at\s*<\s*_to/g)?.length).toBe(2);
  });

  it("settles a period at the rate it was FIRST settled at", () => {
    // Reading franchise_royalty_percent live restated closed months every time
    // the owner changed a location's rate. Issued statements were already safe;
    // drafts are exactly what sits there between generating and issuing.
    const kids = body.slice(body.indexOf("WITH kids"), body.indexOf("rev AS"));
    expect(kids).toMatch(/SELECT\s+fri\.royalty_percent/);
    expect(kids).toMatch(/fri\.period_start\s*=\s*_start/);
    // The live column stays as the fallback for a period never settled before.
    expect(kids).toMatch(/o\.franchise_royalty_percent/);
  });

  it("still protects an issued statement from being rewritten", () => {
    // Pre-existing and load-bearing: this is why the rate bug could only ever
    // reach drafts.
    expect(body).toMatch(/WHERE public\.franchise_royalty_invoices\.status = 'draft'/);
  });

  it("still counts money that ARRIVED, per IMP-10", () => {
    // Unrelated to these four fixes and easy to break while editing this CTE.
    expect(body).toMatch(/p\.status IN \('succeeded', 'refunded'\)/);
  });

  it("keeps the period end EXCLUSIVE", () => {
    // Checked and correct: lastMonthRange() returns the first of the NEXT
    // month, and cpa-reports.ts states the same. A flip to <= here would
    // double-count a day across two statements.
    expect(body).toMatch(/p\.created_at\s*<\s*_to/);
    expect(body).not.toMatch(/p\.created_at\s*<=\s*_to/);
  });
});

describe("a voided statement releases what was on it", () => {
  const body = bodyOf("tg_franchise_invoice_release_on_void");

  it("exists", () => {
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns applied adjustments to outstanding", () => {
    // Voiding is the one action whose whole purpose is "undo this statement",
    // and it undid everything except the part that moves money.
    expect(body).toMatch(/status\s*=\s*'pending'/);
    expect(body).toMatch(/applied_settlement_id\s*=\s*NULL/);
  });

  it("leaves reversed adjustments alone", () => {
    // A reversed deduction is finished, not owed. Releasing it would re-bill a
    // chargeback the location won.
    expect(body).toMatch(/AND status = 'applied'/);
  });

  it("fires only on the transition INTO void", () => {
    // Without the OLD check, every later UPDATE of a voided row would re-release
    // adjustments that a subsequent statement had since taken.
    expect(body).toMatch(/OLD\.status IS DISTINCT FROM 'void'/);
  });
});

describe("a stale statement cannot be issued", () => {
  const body = bodyOf("tg_franchise_invoice_block_stale_issue");

  it("compares the printed total against the adjustments actually on it", () => {
    // The first version asked "is any adjustment on this statement reversed",
    // which is a one-way door: the reversed row stays linked, so the statement
    // could never be issued even after being regenerated. The probe of the fix
    // caught that. Checking the invariant itself clears as soon as the numbers
    // agree again.
    expect(body).toMatch(/NEW\.adjustments_applied_cents/);
    expect(body).toMatch(/IS DISTINCT FROM/);
    expect(body).not.toMatch(/fa\.status = 'reversed'/);
  });

  it("mirrors the settlement's own collector split", () => {
    // If this summed differently from the adj CTE, every statement would look
    // stale and none could be issued.
    expect(body).toMatch(/location_share_cents[\s\S]*collected_by_organization_id = NEW\.parent_organization_id/);
    expect(body).toMatch(/franchise_share_cents[\s\S]*IS DISTINCT FROM NEW\.parent_organization_id/);
  });

  it("only blocks the draft-to-issued transition", () => {
    // Voiding a stale draft must stay possible — it is one of the two ways out.
    expect(body).toMatch(/NEW\.status = 'issued' AND OLD\.status = 'draft'/);
  });
});
