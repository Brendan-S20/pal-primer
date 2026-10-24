// A stay deposit has a cancellation rule (#411 review, item 5). The rule the
// cancel dialog shows, and where the office sets and overrides it. The
// database half is tests/integration/stay-deposits.db.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { depositCancelSentence, depositRefundable } from "@/lib/stays";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/20261017050000_a-deposit-has-a-cancellation-rule.sql");

describe("when a deposit is refundable", () => {
  it("at least the set number of days before the stay starts", () => {
    expect(depositRefundable("2026-12-20", "2026-12-13", 7)).toBe(true);
    expect(depositRefundable("2026-12-20", "2026-12-14", 7)).toBe(false);
    // 0 refunds up to the first day, and not after it.
    expect(depositRefundable("2026-12-20", "2026-12-20", 0)).toBe(true);
    expect(depositRefundable("2026-12-20", "2026-12-21", 0)).toBe(false);
  });

  it("is the same test the trigger makes", () => {
    expect(sql).toMatch(/NEW\.starts_on - _today < COALESCE\(_refund_days, 7\)/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS stay_deposit_refund_days integer NOT NULL DEFAULT 7/);
  });
});

describe("what the cancel dialog says", () => {
  const base = { depositCents: 10000, startsOn: "2026-12-20", refundDays: 7 };
  it("refunded", () => {
    expect(depositCancelSentence({ ...base, today: "2026-12-01" })).toBe(
      "The $100.00 deposit is refunded. Unpaid, its invoice is voided. Paid, it stays on the client's account as credit.",
    );
  });

  it("kept", () => {
    expect(depositCancelSentence({ ...base, today: "2026-12-18" })).toBe(
      "The stay starts in less than 7 days, so the $100.00 deposit is kept as a cancellation fee.",
    );
    expect(depositCancelSentence({ ...base, today: "2026-12-20" })).toMatch(/^The stay starts today,/);
    expect(depositCancelSentence({ ...base, today: "2026-12-21" })).toMatch(/^The stay has started,/);
    expect(depositCancelSentence({ ...base, refundDays: 1, today: "2026-12-20" })).toMatch(
      /^The stay starts today/,
    );
  });

  it("nothing when there is no deposit", () => {
    expect(depositCancelSentence({ ...base, depositCents: null, today: "2026-12-18" })).toBeNull();
    expect(depositCancelSentence({ ...base, depositCents: 0, today: "2026-12-18" })).toBeNull();
  });
});

describe("the office", () => {
  it("cancels through cancel_stay and can refund anyway", () => {
    const fn = read("src/lib/stays.functions.ts");
    expect(fn).toMatch(/supabase\.rpc\("cancel_stay", \{\s*_stay_id: data\.stayId,\s*_refund_deposit: data\.refundDeposit,/);
    const ui = read("src/components/client-detail/StaysSection.tsx");
    expect(ui).toMatch(/Refund the deposit anyway/);
    expect(ui).toMatch(/refundDeposit: refundAnyway\.current/);
  });

  it("sets the window on Settings > Services, with manage_pricing", () => {
    expect(read("src/routes/_authenticated/settings.services.tsx")).toMatch(
      /lines\.includes\("pet_sitting"\) && <StayDepositCard/,
    );
    expect(read("src/lib/stay-deposit.functions.ts")).toMatch(
      /requirePermission\(context\.supabase, context\.userId, "manage_pricing"\)/,
    );
  });
});
