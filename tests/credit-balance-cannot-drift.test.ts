import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `clients.credit_balance_cents` is what apply_credit_to_invoice SPENDS and
// what the customer's portal shows. `credit_ledger` is the audit trail printed
// next to it on the same screen. They were two answers to one question, and
// they disagreed in live data:
//
//   Emily Rodriguez  cached -18000  ledger -30000  drift +12000
//   Chris Williams   cached  -6000  ledger -15000  drift  +9000
//
// Five routines write the ledger and only two maintained the balance, so on a
// prepaid client an add-on debited the ledger, left the balance untouched, and
// stamped the charge `paid_from_credit`. The same dollars were then spent again
// by apply_credit_to_invoice. Proven live before the fix — $445 out of a $500
// top-up, twice over — and after it:
//
//   topup: balance=50000 ledger=50000
//   after $45 add-on: balance=45500 ledger=45500
//   applied=40000 balance=5500 ledger=5500  === total spent 44500 of 50000
//
// The fix is the pattern that already works here: refresh_active_client_count
// and refresh_active_seat_count are trigger-maintained and RECOUNT rather than
// increment, and both audit at exactly zero drift. That is not luck.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let found = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  return found;
}

/** Only that function's body, so an assertion cannot be satisfied by a sibling
 *  routine or by the prose above it. */
function bodyOf(fn: string): string {
  const sql = latestDefinitionOf(fn);
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  const m = re.exec(sql);
  if (!m) return "";
  const from = sql.slice(m.index);
  return from.slice(0, from.indexOf("$function$;"));
}

const ALL_MIGRATION_SQL = migrationFiles()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

describe("the balance is maintained in one place", () => {
  const trigger = bodyOf("tg_credit_ledger_maintain_balance");

  it("finds the trigger function at all", () => {
    // Every assertion below is a regex over this string. A regex over "" that
    // uses .not is a pass measuring nothing.
    expect(trigger.length).toBeGreaterThan(0);
  });

  it("recounts from the ledger rather than incrementing", () => {
    // An increment is a second implementation of the balance, and it can be
    // skipped, double-applied, or applied to the wrong row — which is exactly
    // the class of bug this replaced.
    expect(trigger).toMatch(/sum\(cl\.delta_cents\)/);
    expect(trigger).not.toMatch(/credit_balance_cents\s*=\s*credit_balance_cents/);
  });

  it("fires on delete and update, not only insert", () => {
    // A reversed or corrected ledger row has to move the balance back. Proven:
    // after DELETE the balance returned to 0.
    const attach = /CREATE TRIGGER credit_ledger_maintain_balance[\s\S]*?;/i.exec(
      latestDefinitionOf("tg_credit_ledger_maintain_balance"),
    )?.[0];
    expect(attach).toBeTruthy();
    expect(attach!).toMatch(/AFTER INSERT OR UPDATE OR DELETE/i);
    expect(attach!).toMatch(/FOR EACH ROW/i);
  });

  it("handles a ledger row moving between clients", () => {
    // An UPDATE that changes client_id has to recount BOTH sides, or the old
    // client keeps credit it no longer has.
    expect(trigger).toMatch(/OLD\.client_id/);
    expect(trigger).toMatch(/NEW\.client_id/);
  });
});

describe("nothing maintains the balance by hand any more", () => {
  it("no routine increments credit_balance_cents", () => {
    // The whole point: with the trigger in place, a hand-written increment
    // does not just duplicate the logic, it DOUBLES every entry. This scans
    // every migration rather than the two routines that had it, because the
    // next one to add it will be a third.
    const offenders: string[] = [];
    for (const f of migrationFiles()) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      // Only the last definition of a function matters, so check the current
      // shipped body of each routine that ever did this.
      for (const fn of ["post_credit_entry", "portal_redeem_promo"]) {
        if (!new RegExp(`FUNCTION\\s+public\\.${fn}\\s*\\(`, "i").test(sql)) continue;
        if (latestDefinitionOf(fn) !== sql) continue; // superseded copy
        if (/credit_balance_cents\s*=\s*credit_balance_cents/.test(bodyOf(fn))) {
          offenders.push(`${fn} in ${f}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("post_credit_entry still writes the ledger", () => {
    // Removing the manual balance update must not have removed the entry
    // itself — that would silently stop recording credit at all.
    expect(bodyOf("post_credit_entry")).toMatch(/INSERT INTO public\.credit_ledger/i);
  });
});

describe("the promo kind that could never be written", () => {
  it("is allowed by the check constraint", () => {
    // portal_redeem_promo inserts kind='promo' and the constraint did not list
    // it, so EVERY promo redeemed from the client portal threw. Proven:
    // "kind=promo REJECTED by the check constraint".
    const constraint = /ADD CONSTRAINT credit_ledger_kind_check[\s\S]*?;/i.exec(
      ALL_MIGRATION_SQL.slice(
        ALL_MIGRATION_SQL.lastIndexOf("ADD CONSTRAINT credit_ledger_kind_check"),
      ),
    )?.[0];
    expect(constraint).toBeTruthy();
    expect(constraint!).toMatch(/'promo'/);
  });

  it("is still the kind the redemption writes", () => {
    // RETIRED, not deleted: this used to assert that the dedupe guard reads
    // `kind = 'promo'`, because for a while that was what it keyed on. It no
    // longer does — 20260808170000 moved the guard onto `promo_code_id`,
    // since a guard keyed on kind + a parsed note could be defeated by
    // renaming the code. What survives from the original intent is that the
    // kind written is still 'promo', which the constraint above allows and
    // the ledger UI groups on.
    expect(bodyOf("portal_redeem_promo")).toMatch(/'promo', _note, _p\.id/);
  });

  it("and the guard keys on the code's id, not on the note", () => {
    const body = bodyOf("portal_redeem_promo");
    expect(body).toMatch(/promo_code_id = _p\.id/);
    expect(body).not.toMatch(/split_part\(note/);
  });
});
