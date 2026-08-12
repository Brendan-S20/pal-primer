import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error - plain ESM script, no type declarations
import { sqlCode } from "../scripts/check-baseline-objects.mjs";

// `seed_demo_org` is the RPC behind the app's "reseed demo data" button. It had
// never been applied to the live database — `src/lib/demo.functions.ts` called
// it by name and got PGRST202 for a month — so nothing in this repo had ever
// executed the version that was committed. Reading it against the live schema
// turned up three defects, one of which is a cross-tenant data loss:
//
//     DELETE FROM public.leads;
//
// No WHERE clause, in a SECURITY DEFINER function granted to `authenticated`,
// on a table that HAS an organization_id. Any owner or office_manager of any
// tenant could call seed_demo_org(their_own_org) and empty every other tenant's
// lead pipeline.
//
// ── WHAT THIS FILE IS FOR ─────────────────────────────────────────────────
//
// The function is 500 lines of destructive SQL that nobody runs in CI, against
// a live database this suite cannot reach. What IS checkable, cheaply and
// without a database, is the shape of the thing: that every delete it performs
// names the organization it was asked to reseed, that it does not invent
// credentials, and that it goes through the product's own scheduler and biller
// rather than a second hand-written copy of them.
//
// It reads the NEWEST migration that defines the function, so a later rewrite
// is checked rather than grandfathered.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const MARKER = "CREATE OR REPLACE FUNCTION public.seed_demo_org";

function currentSeederSource(): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  for (const f of files) {
    const src = readFileSync(join(MIGRATIONS, f), "utf8");
    if (!src.includes(MARKER)) continue;
    // The function body only — a header comment quoting the old bug must not
    // be able to satisfy or break an assertion about the code.
    const open = src.indexOf("AS $fn$", src.indexOf(MARKER));
    const close = src.indexOf("$fn$;", open);
    if (open < 0 || close < 0)
      throw new Error(`${f} defines seed_demo_org but not with $fn$ quoting`);
    return { file: f, body: src.slice(open + "AS $fn$".length, close) };
  }
  throw new Error("no migration defines public.seed_demo_org");
}

const { file, body: rawBody } = currentSeederSource();

// Comments and string literals stripped, so an assertion about what the seeder
// DOES cannot be satisfied — or broken — by a line explaining what it
// deliberately does not do. The first version of this file failed on its own
// `-- No gate_code, no lock_box_code, no key_location` comment.
//
// Shares `sqlCode` with check-baseline-objects.mjs rather than carrying its own
// strip-to-end-of-line regex. That regex was correct for THIS seeder — no
// double-dash appears inside its literals — and latently wrong for any future
// one: eight migrations in this repo already contain a double-dash inside a
// string, and there the regex eats the rest of the line and the test quietly
// checks less than it says. Two strippers for one job, one of them carrying the
// exact bug already fixed in the other, is the duplication this suite keeps
// finding elsewhere.
//
// (Written as line comments, not a block: the regex it describes contains the
// characters that close a block comment, which is how the first attempt at this
// note turned the file into a parse error.)
const body = sqlCode(rawBody);

/** Each `DELETE FROM public.x ...` statement, up to its terminating semicolon. */
function deleteStatements(sql: string): string[] {
  const out: string[] = [];
  const re = /DELETE\s+FROM\s+public\.[a-z_]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const end = sql.indexOf(";", m.index);
    out.push(sql.slice(m.index, end < 0 ? sql.length : end + 1));
  }
  return out;
}

describe("the reseeder only ever deletes the org it was handed", () => {
  it("finds a seeder to check at all", () => {
    // A file scan that matches nothing makes every assertion below vacuous.
    expect(file).toMatch(/\.sql$/);
    expect(body.length).toBeGreaterThan(2000);
  });

  const deletes = deleteStatements(body);

  it("finds its delete statements", () => {
    expect(deletes.length).toBeGreaterThanOrEqual(15);
  });

  for (const stmt of deletes) {
    const table = /DELETE\s+FROM\s+public\.([a-z_]+)/i.exec(stmt)?.[1] ?? "?";
    it(`the delete from ${table} names _org_id`, () => {
      expect(
        stmt,
        `seed_demo_org deletes from public.${table} without naming the organization. ` +
          `It is SECURITY DEFINER and granted to authenticated, so an unscoped delete here ` +
          `is one tenant emptying another tenant's table — which is exactly what the ` +
          `previous version did to public.leads.`,
      ).toContain("_org_id");
    });
  }

  it("wipes clients by organization, not by an import tag", () => {
    // The old version deleted every visit, invoice, property and subscription
    // in the org but only clients `WHERE import_external_id LIKE 'DEMO-%'`.
    // No client in the live demo org had one, so it would have left 24 clients
    // with nothing attached and called that a fresh demo.
    const clientDelete = deletes.find((s) => /DELETE\s+FROM\s+public\.clients/i.test(s));
    expect(clientDelete).toBeTruthy();
    expect(clientDelete).not.toMatch(/import_external_id\s+LIKE/i);
  });
});

describe("the reseeder does not invent credentials", () => {
  // The old seed wrote `gate_code '4213'` and `'9911'`, and those numbers
  // reached a numbered marketing screenshot. The demo org is the org that gets
  // photographed, so the fix belongs in the data, not in the capture script.
  for (const col of ["gate_code", "lock_box_code", "key_location"]) {
    it(`never writes ${col}`, () => {
      expect(body).not.toContain(col);
    });
  }
});

describe("the reseeder uses the product rather than a second copy of it", () => {
  it("generates visits with the real scheduler", () => {
    expect(body).toMatch(/generate_visits_core\(/);
  });

  it("generates invoices with the real biller", () => {
    expect(body).toMatch(/admin_generate_invoice_for_client\(/);
  });

  it("completes visits through finalize_visit_completion", () => {
    // Not decoration: that function posts the prepaid credit debit, and
    // `clients.credit_balance_cents` is maintained by a trigger that recounts
    // the ledger. A bulk `SET status = 'completed'` produces the exact credit
    // drift tests/credit-balance-cannot-drift.test.ts exists to forbid.
    expect(body).toMatch(/finalize_visit_completion\(/);
  });

  it("never writes credit_balance_cents directly", () => {
    expect(body).not.toMatch(/credit_balance_cents\s*=/);
  });
});

describe("the reseeder leaves an org a demo can be shown from", () => {
  it("puts work on today, whatever weekday today is", () => {
    // The old seed placed visits at current_date ± 7*wk and nothing between,
    // so /my-day was empty the moment it finished. Weekdays are now offsets
    // from today's own weekday rather than fixed days, which would otherwise
    // produce a today-route one day in seven.
    expect(body).toMatch(/EXTRACT\(DOW FROM current_date\)/i);
    expect(body).toMatch(/scheduled_on = today/);
  });

  it("puts a payment inside the current calendar month", () => {
    // Collected MTD reads $0.00 for the first days of every month otherwise —
    // which is the state the demo org was found in on the 2nd.
    // Matched in two distinctive halves rather than as one literal expression:
    // `sqlCode` blanks string literals, so `date_trunc('month', …)` reaches this
    // assertion with the 'month' removed. Checking the parts that survive keeps
    // the assertion honest — both must be present, and neither can be satisfied
    // by a comment, because comments are stripped too.
    expect(body).toMatch(/GREATEST\(date_trunc\(/);
    expect(body).toMatch(/current_date - 3/);
  });

  it("dates payments explicitly rather than letting created_at default", () => {
    // collectedInPeriod pre-filters payments on a padded created_at window
    // before filtering on the org-local paid_at day, so a backdated payment
    // written with a default created_at is invisible to any report range more
    // than a few days from when the seed ran.
    expect(body).toMatch(/INSERT INTO public\.payments[\s\S]{0,200}created_at/);
  });
});

describe("staff assignment has one implementation", () => {
  it("the seeder is the one that assigns", () => {
    expect(body).toMatch(/assign_demo_visits_to_staff\(_org_id\)/);
  });

  it("the server function does not re-run it afterwards", () => {
    // It used to. seed_demo_org calls assign_demo_visits_to_staff and then
    // hands today's route to the tech; a second call from the caller re-ran the
    // round-robin over today and undid that. Two implementations of "who is
    // this visit assigned to", with the winner decided by call order.
    const fn = readFileSync(join(ROOT, "src", "lib", "demo.functions.ts"), "utf8");
    expect(fn).toContain("seed_demo_org");
    expect(fn).not.toMatch(/rpc\(\s*"assign_demo_visits_to_staff"/);
  });
});
