// A quote took no deposit.
//
// The owner can ask for a deposit on a quote. It is a prepaid top-up invoice,
// so when it is paid it becomes account credit that apply_credit_to_invoice
// takes off the next invoices -- the product's existing, tested path for
// money paid in advance. This file reads the wiring around it and then runs
// tests/sql/a-quote-took-no-deposit.proof.sql, which proves in a real
// Postgres that the deposit is frozen once sent, billed once, untaxed, waits
// for a prospect to be converted, becomes credit and is spent, and that only
// HoundStack can link a quote to its deposit invoice.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QUOTE_LIMITS } from "@/lib/quotes";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = join(ROOT, "supabase/migrations/20260930020000_a-quote-took-no-deposit.sql");
const PROOF = join(ROOT, "tests/sql/a-quote-took-no-deposit.proof.sql");
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

describe("the limits", () => {
  it("are the same in TypeScript and in the CHECK", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(
      new RegExp(
        `deposit_cents BETWEEN ${QUOTE_LIMITS.minDepositCents} AND ${QUOTE_LIMITS.maxDepositCents}`,
      ),
    );
  });
});

describe("the server", () => {
  const fns = read("src/lib/quotes.functions.ts");
  const respond = fns.slice(fns.indexOf("export const respondToPublicQuote"));
  const convert = fns.slice(
    fns.indexOf("export const markQuoteConverted"),
    fns.indexOf("export const invoiceQuoteOneTimeCharges"),
  );

  it("makes the deposit invoice when the customer accepts, and hands back its pay link", () => {
    expect(respond).toMatch(
      /if \(r\.status === "accepted"\)[\s\S]*?makeDepositInvoice\(r\.quote_id\)/,
    );
    expect(respond).toMatch(/appUrl\(`\/pay\/i\/\$\{di\.public_token\}`\)/);
    expect(respond).toMatch(/depositPayUrl,\n\s+\};/);
  });

  it("makes it on conversion, for a prospect who had nobody to bill", () => {
    expect(convert).toMatch(/makeDepositInvoice\(data\.id\)/);
    // After the permission check, never before.
    expect(convert.indexOf("requirePermission")).toBeLessThan(
      convert.indexOf("makeDepositInvoice"),
    );
  });

  it("never turns a deposit failure into a failed acceptance", () => {
    const helper = fns.slice(
      fns.indexOf("async function makeDepositInvoice"),
      fns.indexOf("export const createQuoteDepositInvoice"),
    );
    expect(helper).toMatch(/try \{/);
    expect(helper).toMatch(/return null;/);
    expect(helper).not.toMatch(/throw /);
  });

  it("carries the deposit into a duplicate and into the draft save", () => {
    expect(fns).toMatch(/prospect_phone, title, message, deposit_cents/);
    expect(fns).toMatch(/deposit_cents: data\.depositCents \?\? null/);
  });
});

describe("what the customer reads", () => {
  it("says a deposit is due before they accept, and offers the pay link after", () => {
    const page = read("src/routes/q.$token.tsx");
    expect(page).toMatch(/deposit is due when you accept/);
    expect(page).toMatch(/href=\{data\.quote\.depositPayUrl\}/);
    expect(page).toMatch(/deposit is paid/);
  });

  it("puts the deposit on the quote PDF", () => {
    expect(read("src/lib/pdf/quote-pdf.ts")).toMatch(/"Deposit due on accepting"/);
    expect(read("src/lib/document-pdf.server.ts")).toMatch(/depositCents: d\.deposit_cents/);
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
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the deposit proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a deposit, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(5);
    expect(out).toMatch(/ALL DEPOSIT PROOFS PASSED/);
  });
});
