import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "supabase", "migrations");

/** The LAST migration to define `fn`, so a superseded copy cannot vouch for the
 *  live one. Same shape as four-ways-the-money-moved-quietly.test.ts:40, which
 *  documents that trap. */
function latestDefinitionOf(fn: string): string {
  const re = new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`, "i");
  let found = "";
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error(`no migration defines ${fn}`);
  const rest = found.slice(found.search(re));
  const end = rest.indexOf("$function$;");
  return end === -1 ? rest : rest.slice(0, end);
}

/** Comments stripped, so prose about the guard cannot satisfy an assertion
 *  about the guard — the failure mode this repo keeps rediscovering. */
const codeOnly = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");

// `rls-is-the-boundary.test.ts` says, at line 50:
//
//     "is_org_member admits techs; can_write_org admits dispatchers. Neither is
//      a permission, and neither belongs on a surface the permission matrix has
//      an opinion about."
//
// It applies that rule to CREATE POLICY text. It does not apply it to the
// SECURITY DEFINER functions granted to `authenticated` — which are precisely
// the things that run PAST a policy. So the rule was right and its reach was
// one layer short, and `post_credit_entry` sat in the gap: gated on
// `is_org_member`, granted to `authenticated`, inserting into a ledger whose own
// RLS policies both require `manage_client_billing`. The table and the function
// disagreed with each other in the same schema, and the function won.
//
// Proven on production in a rolled-back transaction holding a tech's JWT claims:
// post_credit_entry(own org, own client, 500000, 'prepayment') was ALLOWED and
// the ledger went 92 -> 93. After the fix the same probe is DENIED and an owner
// of the same org is still ALLOWED.
//
// A LIST, NOT A RULE — deliberately, for the reason rls-is-the-boundary gives
// about its own table list: a rule needs a definition of "money function" that
// drifts. Adding a money RPC here is a line of typing; the cost of forgetting is
// what this file exists to prevent.
const MONEY_RPCS: Array<{ fn: string; permission: string; note?: string }> = [
  { fn: "post_credit_entry", permission: "manage_client_billing", note: "the one that was wrong" },
  { fn: "apply_credit_to_invoice", permission: "manage_client_billing" },
  { fn: "apply_referral_code", permission: "manage_client_billing" },
  { fn: "generate_invoice_for_client", permission: "manage_client_billing" },
  { fn: "generate_invoices_for_org", permission: "manage_client_billing" },
  { fn: "generate_prepaid_invoice", permission: "manage_client_billing" },
  { fn: "redeem_gift_card", permission: "manage_client_billing" },
  { fn: "void_invoice", permission: "manage_client_billing" },
  { fn: "void_addon_charge", permission: "manage_client_billing" },
  { fn: "set_addon_subscription_status", permission: "manage_client_billing" },
  // A tech's cash, claimed against invoices. record_field_collection is NOT
  // on this list on purpose: it is the tech's, it moves no money onto an
  // invoice, and its gate is the visit being assigned to the caller.
  { fn: "confirm_field_collection", permission: "manage_client_billing" },
  { fn: "reject_field_collection", permission: "manage_client_billing" },
];

/** is_org_member admits every role; can_write_org admits dispatchers. */
const MEMBERSHIP_HELPERS = /\bis_org_member\b|\bcan_write_org\b/;

describe("a money RPC checks the permission matrix, not membership", () => {
  it("finds the definitions at all, so the rule below is not vacuous", () => {
    for (const { fn } of MONEY_RPCS) {
      expect(latestDefinitionOf(fn).length, `${fn} definition looks empty`).toBeGreaterThan(120);
    }
  });

  for (const { fn, permission, note } of MONEY_RPCS) {
    it(`${fn} requires ${permission}${note ? ` — ${note}` : ""}`, () => {
      const body = codeOnly(latestDefinitionOf(fn));
      expect(body, `${fn} does not consult ${permission}`).toMatch(
        // NOT [^)]* — the first argument is `auth.uid()`, whose own closing
        // paren ends the class and makes this match nothing. The first version
        // of this line failed every row, which is the right way round to be
        // wrong.
        new RegExp(`has_permission\\([\\s\\S]{0,160}?'${permission}'`),
      );
    });

    it(`${fn} does not gate on membership alone`, () => {
      const body = codeOnly(latestDefinitionOf(fn));
      if (!MEMBERSHIP_HELPERS.test(body)) return; // the common case
      // Some legitimately use both — a membership check for tenant reach AND a
      // permission check for authority. What is forbidden is membership as the
      // ONLY gate, which is what post_credit_entry had.
      expect(
        body,
        `${fn} mentions a membership helper; it must also consult ${permission}`,
      ).toMatch(new RegExp(`has_permission\\([\\s\\S]{0,160}?'${permission}'`));
    });
  }

  it("the service-role callers stay exempt", () => {
    // finalize_visit_completion, tg_invoice_paid_credit and run_billing_cycles
    // reach post_credit_entry with auth.uid() NULL. Removing that exemption
    // would break nightly billing, so the guard must stay inside the NULL check.
    const body = codeOnly(latestDefinitionOf("post_credit_entry"));
    const nullCheck = body.indexOf("auth.uid() IS NOT NULL");
    const permCheck = body.indexOf("manage_client_billing");
    expect(nullCheck, "the auth.uid() IS NOT NULL exemption is gone").toBeGreaterThan(-1);
    expect(permCheck, "the permission check moved outside the exemption").toBeGreaterThan(nullCheck);
  });
});
