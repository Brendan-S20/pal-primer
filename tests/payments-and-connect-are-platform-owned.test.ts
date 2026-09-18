import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_PERMISSIONS } from "@/lib/permissions";

// Two holes an office manager could walk through, both proven live before this
// was written (in a transaction that rolled itself back):
//
//   rewrite_stripe_connect = ALLOWED   (acct now 'acct_ATTACKER')
//   rewrite_payment_status = ALLOWED   (status now 'pending')
//
// 1. stripe_connect_account_id decides which Stripe account receives every
//    customer charge, and it was not among the columns
//    tg_orgs_protect_platform_columns guards — while the organizations UPDATE
//    policy is manage_settings, which office managers hold.
//
// 2. `payments` was writable FOR ALL by manage_client_billing. A franchise
//    location's office manager could flip its own payments to a non-counted
//    status, taking the royalty base generate_franchise_settlements sums — and
//    so the royalty — to zero.
//
// These read the shipped migrations and the shipped source rather than
// restating either. The repo's recurring failure is a check that is green while
// measuring nothing, so each assertion below is anchored to text that would
// actually have to change for the defect to return.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** CREATE OR REPLACE means the LAST migration defining a function is the one in
 *  force; comparing against an earlier copy would let a regression pass.
 *
 *  DEFINING, not mentioning. This used to match any `FUNCTION public.<name>(`,
 *  which a `REVOKE ... ON FUNCTION` satisfies just as well as a CREATE — so a
 *  later migration that only changed a grant became "the definition" and every
 *  assertion below read an empty body and failed. `COMMENT ON FUNCTION` and
 *  `ALTER FUNCTION ... OWNER TO` would have done the same. */
function latestDefinitionOf(fnName: string): string {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fnName}\\s*\\(`,
    "i",
  );
  let found = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  return found;
}

/** Likewise for policies: the last migration that creates one on the table. */
function policiesFor(table: string): string[] {
  const re = new RegExp(`CREATE\\s+POLICY[^;]*ON\\s+public\\.${table}\\b`, "i");
  let found = "";
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error(`no migration defines policies on ${table}`);
  return found.match(/CREATE\s+POLICY[\s\S]*?;/gi) ?? [];
}

const CONNECT_COLUMNS = [
  "stripe_connect_account_id",
  "stripe_connect_charges_enabled",
  "stripe_connect_status",
  "stripe_connect_connected_at",
] as const;

interface TableWrite {
  file: string;
  /** The expression `.from(...)` was called on — `supabaseAdmin`,
   *  `(supabaseAdmin as any)`, `context.supabase`, … */
  receiver: string;
  op: string;
  /** The object literal passed to .update(), if any. */
  patch: string;
}

/**
 * Every `.from("<table>")…​.update()/.delete()` in src/, with the receiver it was
 * called on.
 *
 * The first version of this looked for the word `supabaseAdmin` within 600
 * characters before the call, and a mutation that added a genuine user-client
 * UPDATE at the bottom of a file passed — an unrelated `supabaseAdmin` import
 * further up satisfied it. Proximity is not a receiver. This reads the ~90
 * characters immediately preceding `.from(`, which is the receiver or nothing.
 */
function tableWrites(table: string): TableWrite[] {
  const out: TableWrite[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue;
      const text = readFileSync(p, "utf8");
      const from = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
      for (const m of text.matchAll(from)) {
        const chain = text.slice(m.index! + m[0].length, m.index! + m[0].length + 600);
        const op = /^[\s\S]*?\.(update|delete|upsert)\(/.exec(chain.split(";")[0]);
        if (!op) continue;
        out.push({
          file: p.replace(ROOT, ""),
          receiver: text.slice(Math.max(0, m.index! - 90), m.index!).trimEnd(),
          op: op[1],
          patch: /\.update\(\s*(\{[\s\S]*?\n\s*\}|\{[^{}]*\})/.exec(chain)?.[1] ?? "",
        });
      }
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

/** The receiver ends in the client the call actually runs on. */
function isServiceRole(w: TableWrite): boolean {
  return /supabaseAdmin\s*(as\s+any\s*)?\)?$/.test(w.receiver);
}

describe("where the org's card money lands is the platform's to set", () => {
  const trigger = latestDefinitionOf("tg_orgs_protect_platform_columns");

  it("finds the trigger at all", () => {
    // Without this the rest is vacuous — every assertion below is a substring
    // match, and every substring match on "" is a pass waiting to happen.
    expect(trigger.length).toBeGreaterThan(0);
  });

  for (const col of CONNECT_COLUMNS) {
    it(`refuses a tenant write to ${col}`, () => {
      // The guard is a NEW.x IS DISTINCT FROM OLD.x clause. Naming the column
      // anywhere in the file is not enough — the comment above the block names
      // all four too, and a comment guards nothing.
      expect(trigger).toMatch(
        new RegExp(`NEW\\.${col}\\s+IS\\s+DISTINCT\\s+FROM\\s+OLD\\.${col}`, "i"),
      );
    });
  }

  it("still lets the platform through", () => {
    // Connect onboarding, the refresh and the disconnect all write these four
    // columns via supabaseAdmin. If the service_role escape ever disappears,
    // connecting a Stripe account starts failing in production and nowhere else.
    expect(trigger).toMatch(/auth\.role\(\)\s+IS\s+DISTINCT\s+FROM\s+'service_role'/i);
  });

  it("keeps every Connect write in the app on the service-role client", () => {
    // The trigger is only a backstop. The reason it does not break the product
    // is that no app path writes these columns as the caller.
    const writes = tableWrites("organizations").filter((w) =>
      CONNECT_COLUMNS.some((c) => w.patch.includes(`${c}:`)),
    );
    expect(writes.length, "found no Connect writes at all — the scan is broken").toBeGreaterThan(0);
    expect(writes.filter((w) => !isServiceRole(w)).map((w) => `${w.file} (${w.op})`)).toEqual([]);
  });

  it("keeps the Connect surface owner-only in the matrix", () => {
    // The three server functions that reach these columns require
    // manage_org_billing. If that were ever granted to office_manager, they
    // could disconnect the account through the front door instead.
    expect(ROLE_PERMISSIONS.owner).toContain("manage_org_billing");
    expect(ROLE_PERMISSIONS.office_manager).not.toContain("manage_org_billing");
    expect(ROLE_PERMISSIONS.dispatcher).not.toContain("manage_org_billing");
    expect(ROLE_PERMISSIONS.tech).not.toContain("manage_org_billing");
  });
});

describe("a recorded payment is a fact, not a field", () => {
  const policies = policiesFor("payments");

  it("has no policy covering ALL commands", () => {
    // `FOR ALL` is how "record a payment" quietly became "rewrite a payment".
    for (const p of policies) {
      expect(p, p.slice(0, 70)).not.toMatch(/FOR\s+ALL/i);
    }
  });

  it("lets billing managers INSERT", () => {
    // Manual payments — cash, cheque, terminal — are recorded from the app on
    // the caller's own client. This is the one write a tenant needs.
    const ins = policies.filter((p) => /FOR\s+INSERT/i.test(p));
    expect(ins.length).toBe(1);
    expect(ins[0]).toMatch(/manage_client_billing/);
  });

  it("lets NOBODY update or delete through the table", () => {
    // Every status transition in the product is written by the Stripe webhook
    // through supabaseAdmin, which is service_role and bypasses RLS. Nothing
    // deletes a payment; a reversal is a new row.
    for (const p of policies) {
      expect(p, p.slice(0, 70)).not.toMatch(/FOR\s+(UPDATE|DELETE)/i);
    }
  });

  it("would notice if the table were switched to FORCE ROW LEVEL SECURITY", () => {
    // FORCE RLS applies policies to the table owner too, which would stop the
    // webhook writing statuses at all. The migration asserts this at deploy
    // time; this asserts the assertion is still there.
    const sql = readFileSync(
      join(
        MIGRATIONS,
        migrationFiles().find((f) => f.includes("redirect-the-orgs-card-payments"))!,
      ),
      "utf8",
    );
    expect(sql).toMatch(/relforcerowsecurity/i);
  });

  it("keeps every payments UPDATE in the app on the service-role client", () => {
    // If an app path ever needs to update a payment as the caller, RLS will
    // refuse it silently — PostgREST reports a zero-row UPDATE as a success.
    // Better to fail here than to ship a green toast over nothing.
    const writes = tableWrites("payments");
    expect(writes.length, "found no payments writes at all — the scan is broken").toBeGreaterThan(
      0,
    );
    expect(writes.filter((w) => !isServiceRole(w)).map((w) => `${w.file} (${w.op})`)).toEqual([]);
  });
});
