// Step two of the eleven-reviewer audit: the money bugs. All four were latent
// — checked against live data before any of this was written, and every count
// was zero: 0 invoices void with credit applied, 0 payments carrying a
// surcharge, 0 add-on subscriptions of any kind, 0 charges paid from credit,
// 0 clients with a negative balance, 0 promo redemptions.
//
// That is why they are grouped. None of them had hurt anybody yet, and all
// four would have, on the ordinary path, the first time a customer used the
// feature.
//
//   void_invoice          kept the credit it had spent on a cancelled invoice
//   the nightly add-on    billed every month a plan sat paused, on resume
//   job                   and debited prepaid clients past zero, then never
//                         invoiced the charge it had marked paid
//   portal_redeem_promo   keyed "already used" on a sentence an admin can edit
//   payments.surcharge    recorded what the card was charged and showed it to
//                         nobody, including on the receipt
//
// ── WHAT THESE TESTS CAN AND CANNOT SEE ───────────────────────────────────
//
// The SQL assertions read migration text, which proves the shape of the fix
// and not its behaviour. Behaviour was proven separately, against the live
// database, with the rollback-probe pattern this repo uses elsewhere: build
// the scenario, measure it, then RAISE so the whole transaction unwinds. Those
// runs are quoted in the comments beside each assertion so the numbers are not
// merely claimed. What runs here in CI is the part that can: the shape, and
// the pure formatting helper.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { surchargeSplit } from "@/lib/format";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The most recent migration that (re)defines a function — the one whose text
 *  is actually live. */
function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let found = "";
  for (const f of readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error(`no migration defines ${fn}`);
  const start = found.search(re);
  const rest = found.slice(start);
  const end = rest.indexOf("$function$;");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Comment lines stripped, so a `not.toMatch` cannot be defeated by the prose
 *  that documents what was removed. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("--") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

describe("voiding an invoice returns the credit it consumed", () => {
  const fn = () => latestDefinitionOf("void_invoice");

  it("posts the reversal through the same function that spent it", () => {
    // Not a direct balance UPDATE: the balance column is trigger-maintained
    // from the ledger, so writing it by hand is how the two drift apart —
    // which this codebase has already been bitten by once.
    expect(fn()).toMatch(/post_credit_entry\(/);
    expect(fn()).toMatch(/'invoice_application'/);
    expect(fn()).toMatch(/Returned from voided invoice/);
  });

  it("clears the invoice's record of what it consumed", () => {
    // Leaving credit_applied_cents set would mean a void invoice still
    // claiming to have absorbed credit it has now handed back — and
    // apply_credit_to_invoice computes what is open from exactly that column.
    expect(fn()).toMatch(/credit_applied_cents = 0/);
  });

  it("refuses a second void, which would pay the money back twice", () => {
    expect(fn()).toMatch(/Invoice is already void/);
  });

  it("takes the same lock apply_credit_to_invoice takes", () => {
    // Same key, so an apply and a void racing on one invoice serialize
    // instead of interleaving between the read and the write.
    expect(fn()).toMatch(/pg_advisory_xact_lock\(hashtext\('credit-apply:'/);
    expect(latestDefinitionOf("apply_credit_to_invoice")).toMatch(
      /pg_advisory_xact_lock\(hashtext\('credit-apply:'/,
    );
  });

  // Proven on the live database, every write rolled back:
  //   balance before apply=15000, after apply=0, after void=15000
  //   credit_applied: after apply=15000, after void=0
  //   status=void, invoice_application entries=2
});

describe("the nightly add-on job", () => {
  const fn = () => latestDefinitionOf("admin_generate_addon_charges_through");

  it("takes credit only when the balance covers the whole charge", () => {
    expect(fn()).toMatch(/SELECT COALESCE\(credit_balance_cents, 0\) INTO _bal/);
    expect(fn()).toMatch(/IF _bal >= _amt THEN/);
  });

  it("locks the balance row, since a catch-up spends it more than once", () => {
    expect(fn()).toMatch(/FROM public\.clients WHERE id = _s\.client_id FOR UPDATE/);
  });

  it("leaves the charge pending when it cannot, so the invoice picks it up", () => {
    // The failure this replaces: debit anyway, stamp `paid_from_credit`, and
    // the invoice generator — which collects only `pending` — never bills it.
    // The charge is marked paid ONLY inside the branch that actually paid.
    const gate = fn().slice(fn().indexOf("IF _bal >= _amt THEN"));
    const branch = gate.slice(0, gate.indexOf("END IF;"));
    expect(branch).toMatch(/status='paid_from_credit'/);
    expect(codeOnly(fn().slice(0, fn().indexOf("IF _bal >= _amt THEN")))).not.toMatch(
      /paid_from_credit/,
    );
  });

  it("caps how many periods one run can bill", () => {
    expect(fn()).toMatch(/_max_per_run constant integer := 3/);
    expect(fn()).toMatch(/WHILE _next <= _through AND _emitted < _max_per_run LOOP/);
  });

  it("says so out loud when it hits the cap", () => {
    // A silent cap reads as "nothing was owed". This one names the
    // subscription and the date it stopped at.
    expect(fn()).toMatch(/still owes charges from % after % this run/);
  });

  // Proven live, rolled back — three months owed, $45/month, $45 in the
  // wallet: wrote=3 paid_from_credit=1 pending=2 balance=0. And with an empty
  // wallet and five months owed: wrote=3 (the cap) pending=3 balance=0, with
  // the pointer moved 2026-03-08 -> 2026-06-08 so the rest continue tomorrow.
});

describe("resuming a paused add-on does not bill the pause", () => {
  const fn = () => latestDefinitionOf("set_addon_subscription_status");

  it("exists at all — the old path was a bare UPDATE from TypeScript", () => {
    expect(fn()).toMatch(/CREATE OR REPLACE FUNCTION public\.set_addon_subscription_status/);
    expect(fn()).toMatch(/has_permission\(auth\.uid\(\)/);
  });

  it("rolls next_charge_on forward only when coming back to active", () => {
    expect(fn()).toMatch(
      /IF _status = 'active' AND _s\.status <> 'active' AND _next < CURRENT_DATE/,
    );
  });

  it("steps by the cadence rather than jumping to today", () => {
    // Jumping would move a plan that always billed on the 3rd to whatever
    // date it happened to be resumed on.
    expect(fn()).toMatch(/_next := \(_next \+ _step\)::date/);
    expect(fn()).toMatch(/addon_frequency_step\(_s\.frequency\)/);
  });

  it("reports how many periods it skipped, so the UI can say so", () => {
    expect(fn()).toMatch(/'skipped_periods', _skipped/);
    const panel = read("src/components/client-detail/billing-panels.tsx");
    expect(panel).toMatch(/skippedPeriods/);
    expect(panel).toMatch(/billing period\$\{skipped === 1 \? "" : "s"\} it was paused for/);
  });

  it("the server function calls the RPC instead of updating the table", () => {
    const addons = read("src/lib/addons.functions.ts");
    expect(addons).toMatch(/rpc\(\s*"set_addon_subscription_status"/);
    const handler = addons.slice(addons.indexOf("export const setAddonSubscriptionStatus"));
    expect(codeOnly(handler.slice(0, 2000))).not.toMatch(
      /from\("addon_subscriptions"\)\s*\n?\s*\.update/,
    );
  });

  // Proven live, rolled back: pointer frozen five months back, paused, then
  // resumed ->
  //   {"ok": true, "status": "active", "next_charge_on": "2026-08-08",
  //    "skipped_periods": 5}   (today = 2026-08-08)
});

describe("the cadence lives in one place now", () => {
  it("both callers read the same helper", () => {
    const step = latestDefinitionOf("addon_frequency_step");
    expect(step).toMatch(/WHEN 'quarterly' THEN interval '3 months'/);
    expect(latestDefinitionOf("admin_generate_addon_charges_through")).toMatch(
      /public\.addon_frequency_step\(_s\.frequency\)/,
    );
    expect(latestDefinitionOf("set_addon_subscription_status")).toMatch(
      /public\.addon_frequency_step\(_s\.frequency\)/,
    );
  });

  it("and the generator no longer carries its own copy", () => {
    const gen = latestDefinitionOf("admin_generate_addon_charges_through");
    expect(codeOnly(gen)).not.toMatch(/WHEN 'biweekly' THEN/);
  });

  it("an unmapped frequency is skipped and named, not treated as zero", () => {
    // A NULL interval in the WHILE loop would spin forever on the same date.
    expect(latestDefinitionOf("admin_generate_addon_charges_through")).toMatch(
      /has unmapped frequency %, skipped/,
    );
  });
});

describe("a promo code can be renamed without reopening it", () => {
  const fn = () => latestDefinitionOf("portal_redeem_promo");

  it("keys the guard on the code's id", () => {
    expect(fn()).toMatch(/WHERE client_id = _cid AND promo_code_id = _p\.id/);
  });

  it("and no longer parses the customer-facing note", () => {
    // The note is prose for a human reading their credit history. It was
    // load-bearing; it is not any more.
    expect(codeOnly(fn())).not.toMatch(/split_part\(note/);
  });

  it("records the id on the entry it writes", () => {
    expect(fn()).toMatch(/'promo', _note, _p\.id/);
  });

  it("is enforced by an index, not only by a check", () => {
    // Two requests racing both pass an EXISTS. Only a constraint stops that.
    const sql = readFileSync(
      join(MIGRATIONS, "20260808170000_a-promo-guard-keyed-on-a-sentence.sql"),
      "utf8",
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_one_promo_per_client\s*\n\s*ON public\.credit_ledger \(client_id, promo_code_id\)/,
    );
    expect(fn()).toMatch(/EXCEPTION WHEN unique_violation THEN/);
  });

  it("turns the constraint violation back into the sentence a customer reads", () => {
    const race = fn().slice(fn().indexOf("EXCEPTION WHEN unique_violation THEN"));
    expect(race.slice(0, 300)).toMatch(/You have already used this code/);
  });

  // Proven live, rolled back: redeem PROBE15 -> 1500 cents; redeem again ->
  // "You have already used this code"; rename the row to PROBE20 at a higher
  // value and redeem -> "You have already used this code", while the ledger
  // note on file still reads "Promo: PROBE15".
});

describe("the card surcharge reaches the people who paid it", () => {
  const invoices = read("src/lib/invoices.functions.ts");

  it("is selected everywhere a payment is read for display", () => {
    // Recorded correctly all along, then selected by nothing. Three queries
    // feed the three surfaces that show a payment.
    const selects = invoices.match(/\.select\(\s*\n?\s*"[^"]*amount_cents[^"]*"/g) ?? [];
    const paymentSelects = selects.filter((s) => s.includes("status"));
    expect(paymentSelects.length).toBeGreaterThanOrEqual(3);
    for (const s of paymentSelects) expect(s).toContain("surcharge_cents");
  });

  it("both payment lists show the charged total", () => {
    for (const f of [
      "src/components/client-detail/billing-panels.tsx",
      "src/components/InvoiceDrawer.tsx",
    ]) {
      const src = read(f);
      expect(src, f).toMatch(/surchargeSplit\(/);
      expect(src, f).toMatch(/card fee/);
    }
  });

  it("and the receipt email quotes what hit the card, not the invoice amount", () => {
    const tpl = read("src/lib/email-templates/payment-received.tsx");
    expect(tpl).toMatch(/charged\(amountCents, surchargeCents\)/);
    expect(tpl).toMatch(/for service \+ \{fmtMoney\(surchargeCents\)\} card processing/);
    // The subject line too — it is the first number the customer sees.
    expect(tpl).toMatch(/Receipt: \$\{fmtMoney\(charged\(/);
    expect(read("src/lib/invoice-reconcile.server.ts")).toMatch(
      /surchargeCents: args\.surchargeCents \?\? 0/,
    );
  });
});

describe("surchargeSplit", () => {
  it("returns null when there is no surcharge, meaning 'just show the amount'", () => {
    expect(surchargeSplit(4575, 0)).toBeNull();
    expect(surchargeSplit(4575, null)).toBeNull();
    expect(surchargeSplit(4575, undefined)).toBeNull();
  });

  it("splits the reviewer's example exactly", () => {
    // "$45.75 service + $1.38 card processing = $47.13 charged"
    expect(surchargeSplit(4575, 138)).toEqual({
      chargedCents: 4713,
      baseCents: 4575,
      feeCents: 138,
    });
  });

  it("treats a missing amount as zero rather than NaN", () => {
    expect(surchargeSplit(null, 138)).toEqual({ chargedCents: 138, baseCents: 0, feeCents: 138 });
  });

  it("ignores a negative surcharge instead of subtracting it", () => {
    // Nothing writes one, but a refund path that got its sign wrong should
    // not quietly show the customer less than they paid.
    expect(surchargeSplit(4575, -138)).toBeNull();
  });
});
