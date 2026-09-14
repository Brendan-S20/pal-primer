import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/permissions";

// The single most productive question to ask of this codebase is not "is the
// routine guarded" but "what does the policy say". Fourteen separate defects
// have now been some version of: a server function authorizes correctly, and
// the table underneath is open, so PostgREST is reachable directly with the
// anon key and the user's own JWT.
//
// Proven live before this was written, in rolled-back transactions:
//
//   TECH mint_$5000_giftcard=ALLOWED
//   DISPATCHER reads_quickbooks_token=TOKEN_SECRET
//   DISPATCHER repriced_subscriptions=24
//
// After: TECH mint_giftcard=BLOCKED reads_giftcards=0 reads_promos=0
//        || DISP qb_token=BLOCKED repriced=0
//        || OM qb_token=readable(ok) can_still_price=24 can_still_issue=OK
//
// This file is deliberately a LIST rather than a rule. A rule ("no money table
// may use is_org_member") needs a definition of "money table" that drifts; a
// list of tables and the permission each one is entitled to has to be edited by
// a human, and editing it is the moment to think.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Every policy on a table, from the LAST migration that creates one. */
function policiesFor(table: string): string[] {
  const re = new RegExp(`CREATE\\s+POLICY[^;]*ON\\s+public\\.${table}\\b`, "i");
  let found = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error(`no migration defines policies on ${table}`);
  return (found.match(/CREATE\s+POLICY[\s\S]*?;/gi) ?? []).filter((p) =>
    new RegExp(`ON\\s+public\\.${table}\\b`, "i").test(p),
  );
}

/** `is_org_member` admits techs; `can_write_org` admits dispatchers. Neither is
 *  a permission, and neither belongs on a surface the permission matrix has an
 *  opinion about. */
const MEMBERSHIP_HELPERS = /\bis_org_member\b|\bcan_write_org\b/;

/**
 * table → the permission its own server function already requires.
 *
 * Each entry was read out of the TypeScript, not chosen here: promotions
 * .functions.ts:12 and accounting.functions.ts:14 both say manage_settings in
 * so many words, subscriptions.functions.ts requires manage_pricing at every
 * writer, neighbors.functions.ts requires view_client_directory.
 */
const GUARDED: Array<{
  table: string;
  permission: Permission;
  /** The SELECT policy is deliberately wider than the write one. */
  readMayBeWider?: boolean;
  /** No tenant writes this at all — it is filled by a webhook on service_role,
   *  which bypasses RLS. The absence of a write policy IS the property. */
  readOnlyForTenants?: boolean;
  /**
   * The permission guards DELETE only; reading, inserting and updating are open
   * to any member of the organization.
   *
   * For a table whose rows ARE field work, recorded by the field crew, where
   * the destructive command is the one the office owns. The same shape as
   * `readMayBeWider` on subscriptions — doing the job is not the risk, undoing
   * it is — extended to the two writes that are part of doing the job.
   *
   * The entry stays on this list rather than leaving it, so the table stays
   * under scrutiny and the DELETE guarantee is still asserted. What narrows is
   * the claim about which commands the permission covers.
   */
  guardsDeleteOnly?: boolean;
}> = [
  { table: "gift_cards", permission: "manage_settings" },
  { table: "gift_card_redemptions", permission: "manage_settings" },
  { table: "promo_codes", permission: "manage_settings" },
  { table: "accounting_connections", permission: "manage_settings" },
  { table: "skip_billing_rules", permission: "manage_settings" },
  // 2026-09-14: this was a single FOR ALL policy on view_client_directory,
  // which a technician does not hold — so their list came back empty, adding a
  // door raised, and the walk mode's buttons did nothing. Reported from an
  // iPhone, on a page ROUTE_ROLES grants to techs, whose server function
  // already NULLs seed_client_id for a caller without the directory, and whose
  // walk mode's own comments describe a tech pressing Interested at a door.
  // Four places were written for that role; the policy was never widened to
  // agree, so the feature was unreachable for the role it was designed around.
  //
  // A canvassing lead is the address of somebody who is NOT a customer, written
  // down by the person who walked past the house. Withholding it from that
  // person protects nothing. The client's IDENTITY is still not theirs:
  // listNeighborLeads strips seed_client_id and seed_client_name for them and
  // `clients` keeps its own RLS, so the embedded join comes back null whatever
  // this table allows — two independent layers, which is the point.
  //
  // Residual risk, stated rather than hidden: a tech reaching PostgREST
  // directly can read `seed_client_id` as a bare UUID. They cannot resolve it
  // through `clients`, and they already hold the ids of their own assigned
  // clients from My Day, so what it discloses is "this door was seeded from
  // some client" — which is the premise of standing there.
  { table: "neighbor_leads", permission: "view_client_directory", guardsDeleteOnly: true },
  // Written by the Twilio voice webhook and the public signup flow, both on
  // service_role. A tenant only ever reads these.
  { table: "ai_receptionist_logs", permission: "manage_settings", readOnlyForTenants: true },
  { table: "signup_requests", permission: "manage_settings", readOnlyForTenants: true },
  // Reading a subscription tells a tech what service they are performing;
  // repricing it is the risk. The read policy is deliberately wider.
  { table: "subscriptions", permission: "manage_pricing", readMayBeWider: true },
];

describe.each(GUARDED)("$table", (entry) => {
  const { table, permission, readMayBeWider, readOnlyForTenants, guardsDeleteOnly } = entry;
  const policies = policiesFor(table);

  it("has at least one policy to check", () => {
    // Without this every assertion below is vacuous over an empty array —
    // `[].every(...)` is true, and that is how a check ends up green while
    // measuring nothing.
    expect(policies.length).toBeGreaterThan(0);
  });

  it(`gates writes on ${permission}, not on bare membership`, () => {
    const writes = policies.filter((p) => !/FOR\s+SELECT/i.test(p));
    if (readOnlyForTenants) {
      // Asserting the absence, which is the actual guarantee: a webhook fills
      // this table on service_role and no tenant should be able to forge a row.
      expect(writes).toEqual([]);
      return;
    }
    expect(writes.length).toBeGreaterThan(0);
    if (guardsDeleteOnly) {
      // The claim narrows to the destructive command, and it is still a claim:
      // a DELETE policy on bare membership, or no DELETE policy at all, fails
      // here exactly as a wide write policy fails anywhere else on this list.
      const deletes = policies.filter((p) => /FOR\s+DELETE/i.test(p));
      expect(deletes.length, `${table} has no DELETE policy to guard`).toBeGreaterThan(0);
      for (const p of deletes) {
        expect(p, p.slice(0, 80)).toMatch(new RegExp(`'${permission}'`));
        expect(p, p.slice(0, 80)).not.toMatch(MEMBERSHIP_HELPERS);
      }
      // And no FOR ALL may come back. One would re-merge the four commands this
      // entry exists to keep separate, and would satisfy the DELETE check above
      // while silently re-gating the other three.
      for (const p of policies) {
        expect(p, `${table} must not carry a FOR ALL policy`).not.toMatch(/FOR\s+ALL/i);
      }
      return;
    }
    for (const p of writes) {
      expect(p, p.slice(0, 80)).toMatch(new RegExp(`'${permission}'`));
      expect(p, p.slice(0, 80)).not.toMatch(MEMBERSHIP_HELPERS);
    }
  });

  it("does not let a membership helper stand in for a permission on reads", () => {
    if (readMayBeWider || guardsDeleteOnly) return;
    for (const p of policies.filter((p) => /FOR\s+SELECT/i.test(p))) {
      expect(p, p.slice(0, 80)).not.toMatch(MEMBERSHIP_HELPERS);
    }
  });

  it(`grants ${permission} to nobody below the office`, () => {
    // A policy is only as strict as the permission it names. If this were ever
    // granted to a dispatcher or a tech, every rule above would silently widen
    // without one line of policy changing.
    expect(ROLE_PERMISSIONS.owner).toContain(permission);
    expect(ROLE_PERMISSIONS.tech, "tech").not.toContain(permission);
    if (permission !== "view_client_directory") {
      // view_client_directory is deliberately held by dispatchers — they route
      // the work, so they see the addresses.
      expect(ROLE_PERMISSIONS.dispatcher, "dispatcher").not.toContain(permission);
    }
  });
});

describe("the push credential read", () => {
  it("is own-row only", () => {
    // A tech could read the OWNER's endpoint, p256dh and auth secret. Every path
    // in push.functions.ts filters on user_id = auth.uid() and delivery runs on
    // supabaseAdmin, so nothing needed the org-wide read.
    const dropped = migrationFiles().some((f) =>
      /DROP POLICY IF EXISTS "org staff view org push subs"/.test(
        readFileSync(join(MIGRATIONS, f), "utf8"),
      ),
    );
    expect(dropped).toBe(true);
  });
});
