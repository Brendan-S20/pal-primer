// A tech records cash; the office applies it.
//
// The money rules for field collections, proved in a real Postgres, and the
// one rule that lives in TypeScript -- that a confirmation goes through the
// office's own Record payment path rather than a copy of it -- pinned in the
// source.
//
// tests/sql/the-cash-a-tech-took-had-nowhere-to-go.proof.sql applies the
// migration inside a transaction, builds two tenants with an owner, two office
// managers (one has muted the notification), a dispatcher, two techs and a
// tech in another org, and proves that
//
//   * the assigned tech records on his own visit, once: a replay with the same
//     key, an hour later, is the same row, and so is a double tap without one;
//     the phone's clock is believed inside the last seven days and not in the
//     future;
//   * the owner and the unmuted office manager are told, once each;
//   * he is refused on another tech's visit, an unassigned one, ten days ago,
//     tomorrow, a canceled visit, another org's, no such visit, zero, a
//     negative, a cent more than is owed less what is already waiting, and
//     venmo -- and a key from one visit cannot answer for another;
//   * he cannot mark an invoice paid, insert a payment, write the table
//     directly, or confirm or reject anything;
//   * his card's facts (dog count, how they pay, what is owed and waiting) come
//     back for his own stops only;
//   * a colleague, another org's owner and anon read and decide none of it;
//   * the dispatcher previews the facts and cannot confirm;
//   * the office confirms once, only against this customer's open invoices
//     that add up to no more than was collected, the claim itself writes no
//     money, and a rejection carries its note;
//   * once decided, nothing is left waiting against the balance,
//
// and then ROLLS BACK. Sixteen mutants of the migration were run against it
// when it was written -- each guard removed or loosened in turn (the assigned
// staff check, the day window, the balance bound, the canceled check, the key,
// the double-tap window, the second-confirmation refusal, the invoice's client,
// its status, the amount ceiling, the permission, the facts' reach, the mute,
// the read policy, the clock bound, the key's visit) -- and every one failed
// it, each at the check named for it.
//
// When no database is reachable it says so loudly and skips.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts),
// so on a loaded runner one can take minutes without being hung.
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261002150000_the-cash-a-tech-took-had-nowhere-to-go.sql",
);
const METHODS = join(
  ROOT,
  "supabase/migrations/20260928030000_a-cash-payment-could-not-say-how-it-was-paid.sql",
);
const PROOF = join(ROOT, "tests/sql/the-cash-a-tech-took-had-nowhere-to-go.proof.sql");
const DB_URL =
  process.env.FIELD_COLLECTIONS_PROOF_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

/** Comments stripped, so prose about a rule cannot satisfy a check on it. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|--)/.test(l))
    .join("\n");

describe("a confirmation goes through the office's own Record payment path", () => {
  const fn = codeOnly(readFileSync(join(ROOT, "src/lib/invoices.functions.ts"), "utf8"));
  const start = fn.indexOf("export const bulkMarkInvoicesPaid =");
  const rest = fn.slice(start + 1);
  const body = rest.slice(0, rest.indexOf("\nexport const "));

  it("claims the collection before it pays anything", () => {
    const claim = body.indexOf('rpc("confirm_field_collection"');
    expect(claim, "bulkMarkInvoicesPaid never claims the collection").toBeGreaterThan(-1);
    expect(claim).toBeLessThan(body.indexOf('from("payments").insert'));
    expect(claim).toBeLessThan(body.indexOf("for (const id of ids)"));
    // A refused claim stops it: nothing after it runs.
    expect(body.slice(claim, claim + 300)).toMatch(/if \(cErr\) throw new Error\(cErr\.message\)/);
  });

  it("pays exactly the invoices the claim accepted", () => {
    expect(body).toMatch(
      /ids = \(\(claimed as \{ invoice_ids\?: string\[\] \} \| null\)\?\.invoice_ids/,
    );
    expect(body).toMatch(/for \(const id of ids\)/);
    expect(body).not.toMatch(/for \(const id of data\.ids\)/);
  });

  it("records the collection's own method, check number and time", () => {
    expect(body).toMatch(/const method = field \?/);
    expect(body).toMatch(/const nowIso = field\s*\?\s*field\.collected_at/);
    expect(body).toMatch(/const reference = field\s*\?\s*field\.reference/);
    expect(body).toMatch(/field_collection_id: field\?\.id \?\? null/);
  });

  it("is still gated on manage_client_billing before any of it", () => {
    const gate = body.indexOf(
      'requirePermission(supabase, context.userId, "manage_client_billing")',
    );
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf('rpc("confirm_field_collection"'));
  });

  it("the tech's server function only records", () => {
    const tech = codeOnly(
      readFileSync(join(ROOT, "src/lib/field-collections.functions.ts"), "utf8"),
    );
    const rec = tech.slice(tech.indexOf("export const recordFieldCollection"));
    const recBody = rec.slice(0, rec.indexOf("\nexport ", 10));
    expect(recBody).toMatch(/rpc\("record_field_collection"/);
    expect(recBody).not.toMatch(
      /from\("invoices"\)|from\("payments"\)|confirm_field_collection|bulkMarkInvoicesPaid/,
    );
  });
});

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    // Generous: a shared local stack busy with other proofs has been measured
    // taking 3-20 seconds to accept a connection, and a probe that gives up
    // first reports "no database" for a database that is there. Where there
    // really is none the refusal is immediate, so this costs nothing.
    timeout: 30_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the field-collection proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set FIELD_COLLECTIONS_PROOF_DB_URL to run them.\n",
  );
}

/** Run the proof, again if and only if Postgres chose it as a deadlock victim.
 *  Every proof here re-applies migrations inside its own transaction, and one
 *  that runs ALTER TABLE takes an exclusive lock; vitest runs files side by
 *  side, so two can cross. A deadlock rolls the whole transaction back, so a
 *  retry starts clean. Any other failure is returned as it is. */
function runProof(args: string[]) {
  let r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  for (let i = 0; i < 2 && /deadlock detected/.test(`${r.stdout}${r.stderr}`); i++) {
    r = spawnSync(psql!, args, { encoding: "utf8", timeout: 300_000 });
  }
  return r;
}

describe.skipIf(!reachable)("the field-collection rules hold in a real database", () => {
  it("has the files it runs", () => {
    for (const f of [MIGRATION, METHODS, PROOF]) expect(existsSync(f), f).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = runProof([
      DB_URL,
      "-X",
      "-v",
      `migration=${MIGRATION}`,
      "-v",
      `methods=${METHODS}`,
      "-f",
      PROOF,
    ]);
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Nine groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(9);
    expect(out).toMatch(/ALL FIELD COLLECTION PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Cash Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
    // psql runs synchronously, so vitest cannot cut it short; the budget is
    // the proof's own (180s per attempt), not the 30s default for a unit test.
  }, 600_000);
});
