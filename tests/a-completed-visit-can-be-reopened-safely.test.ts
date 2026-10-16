import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  join(root, "supabase/migrations/20261012140000_visit_reopen_and_missed_are_billing_safe.sql"),
  "utf8",
);
const visits = readFileSync(join(root, "src/lib/visits.functions.ts"), "utf8");

describe("completed visit reopen and missed actions", () => {
  it("block rows that already have an invoice line or prepaid debit", () => {
    expect(migration).toMatch(/FROM public\.invoice_line_items li/);
    expect(migration).toMatch(/Void or remove that invoice line/);
    expect(migration).toMatch(/FROM public\.credit_ledger cl/);
    expect(migration).toMatch(/cl\.kind = 'visit_debit'/);
    expect(migration).toMatch(/Reverse that billing entry/);
  });

  it("remove the completed status before the next invoice run can pick the visit", () => {
    expect(migration).toMatch(/status = CASE WHEN _started IS NULL THEN 'scheduled'/);
    expect(migration).toMatch(/status = 'missed'/);
    expect(migration).toMatch(/completed_at = NULL/);
    expect(migration).toMatch(/price_cents = NULL/);
  });

  it("exposes dispatcher-capable server functions that call the SQL guard", () => {
    expect(visits).toMatch(/export const reopenVisitFromOffice/);
    expect(visits).toMatch(/export const markVisitMissedFromOffice/);
    expect(visits).toContain('["owner", "office_manager", "dispatcher"].includes(caller.role)');
    expect(visits).toMatch(/rpc\("office_reopen_visit"/);
    expect(visits).toMatch(/rpc\("office_mark_visit_missed"/);
  });
});
