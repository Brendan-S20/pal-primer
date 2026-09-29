import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// createOneOffVisit has to know a client's billing cadence so that booking a
// one-off cannot silently convert a PREPAID client to postpaid — which it did,
// confirmed live: cadence_before=prepaid, cadence_after_one_off=postpaid. Their
// add-on charges stop drawing down credit they already paid and start landing
// on postpaid invoices instead.
//
// The authoritative answer is SQL: public.client_default_billing_cadence. The
// app cannot call it — it is not granted to `authenticated`, and granting it
// would be wrong, because it is SECURITY DEFINER and would then answer about
// any client id in any tenant (the BUG-42 shape). So one-off-visit.server.ts
// restates the ordering against the caller's own RLS-scoped client.
//
// That is a second copy of a rule, and two copies that must agree are two
// copies that will eventually disagree. This is the guard. It reads the SHIPPED
// SQL rather than restating the rule a third time — a test that asserts its own
// expectation agrees with itself no matter what the database does.
//
// Verified once by hand against the live database when written: 267 clients
// checked, 0 disagreements between the two implementations.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");

/** The latest migration that (re)defines the function — migrations are an
 *  append-only history, so an older copy is not what production runs. This is
 *  the mistake the IMP-3 parity test made: it was pinned to a migration that
 *  had since been superseded, and would have started checking history the
 *  moment anything replaced the function. */
function latestCadenceDefinition(): string {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.client_default_billing_cadence\s*\(/i;
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (re.test(sql)) found = sql;
  }
  if (!found) throw new Error("no migration defines client_default_billing_cadence");
  // Just the function body, so unrelated SQL in the same file cannot satisfy
  // the assertions below.
  const start = found.search(re);
  return found.slice(start, start + 1200);
}

describe("the TS mirror of client_default_billing_cadence", () => {
  const sql = latestCadenceDefinition();
  // The booking code moved out of visits.functions.ts on 2026-09-29 so the
  // portal's auto-accept path could call it too; createOneOffVisit delegates.
  const ts = readFileSync(join(ROOT, "src/lib/one-off-visit.server.ts"), "utf8");
  // The block that does the lookup, so assertions cannot be satisfied by some
  // unrelated query elsewhere in a 900-line file.
  const block = ts.slice(
    ts.indexOf("let cadence:"),
    ts.indexOf("const { data: sub, error: sErr }"),
  );

  it("finds the shipped SQL definition", () => {
    expect(sql).toMatch(/client_default_billing_cadence/);
    expect(block.length).toBeGreaterThan(0);
  });

  it("filters on the same status", () => {
    expect(sql).toMatch(/status\s*=\s*'active'/i);
    expect(block).toMatch(/\.eq\(\s*"status",\s*"active"\s*\)/);
  });

  it("orders by the same column, in the same direction, with NULLs last", () => {
    expect(sql).toMatch(/ORDER\s+BY\s+started_on\s+DESC\s+NULLS\s+LAST/i);
    expect(block).toMatch(/\.order\(\s*"started_on",\s*\{[^}]*ascending:\s*false/);
    // nullsFirst:false is postgrest's spelling of NULLS LAST. Getting this
    // wrong picks a different subscription whenever one has no start date.
    expect(block).toMatch(/nullsFirst:\s*false/);
  });

  it("takes exactly one row", () => {
    expect(sql).toMatch(/LIMIT\s+1/i);
    expect(block).toMatch(/\.limit\(1\)/);
  });

  it("falls back to postpaid when the client has no active service", () => {
    // 247 of 267 clients are in this state, so the fallback is the common path,
    // not an edge case.
    expect(sql).toMatch(/COALESCE\([\s\S]*'postpaid'/i);
    expect(block).toMatch(/cadence:\s*"postpaid"\s*\|\s*"prepaid"\s*=\s*"postpaid"/);
  });

  it("reads the cadence BEFORE inserting the one-off", () => {
    // A moment later the one-off is itself the newest active subscription and
    // would answer about itself, defeating the whole thing.
    expect(ts.indexOf("let cadence:")).toBeLessThan(ts.indexOf('frequency: "one_time"'));
  });

  it("actually writes the inherited cadence onto the new subscription", () => {
    // Without this the whole lookup is decoration and the table default
    // ('postpaid') wins — which is the original bug, restored.
    expect(ts).toMatch(/billing_cadence:\s*cadence/);
  });
});
