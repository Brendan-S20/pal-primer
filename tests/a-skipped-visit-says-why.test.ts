// A skipped visit says why (QA row 15).
//
// QA found a future stop already marked Skipped with nothing beside it. No
// code path skips without a reason: skip_visit and office_skip_visit refuse a
// blank one, and the portal's skip and vacation hold write "Customer
// requested via portal" / "Vacation hold". The reason was in the row; the
// screens did not read it. The drawer's "Coming up" list fetched only the
// status, and the board card and the phone day list showed a bare chip
// because listVisitsForDay never selected the reason.
//
// So every office screen that marks a visit Skipped now prints the reason,
// and says "No reason recorded" when a row has none rather than nothing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_SKIP_REASON, skipReasonText } from "@/lib/skip-reason-text";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

describe("skipReasonText", () => {
  it("prefers what a person typed", () => {
    expect(skipReasonText("  Gate was chained  ", "gate_locked")).toBe("Gate was chained");
  });
  it("falls back to the code", () => {
    expect(skipReasonText("", "weather")).toBe("Weather");
    expect(skipReasonText(null, "customer_requested")).toBe("Customer requested");
  });
  it("is never blank", () => {
    expect(skipReasonText(null, null)).toBe(NO_SKIP_REASON);
    expect(skipReasonText("   ", "not_a_code")).toBe(NO_SKIP_REASON);
  });
});

describe("the screens that show a skipped visit read its reason", () => {
  it("the day query selects the reason", () => {
    const src = read("src/lib/visits.functions.ts");
    const list = src.slice(src.indexOf("export const listVisitsForDay"), src.indexOf("export const getVisitDetail"));
    expect(list).toMatch(/skip_reason, skip_reason_code/);
    const detail = src.slice(src.indexOf("export const getVisitDetail"), src.indexOf("export const listStaff"));
    // The "Coming up" and "Recent visits" lists, not only the visit itself.
    expect(detail).toMatch(/select\("id, scheduled_on, status, skip_reason, skip_reason_code"\)/);
  });

  it.each([
    "src/components/VisitDetailDrawer.tsx",
    "src/components/schedule/MobileDayList.tsx",
    "src/routes/_authenticated/routes.tsx",
  ])("%s prints it", (f) => {
    expect(read(f)).toMatch(/skipReasonText\(/);
  });
});
