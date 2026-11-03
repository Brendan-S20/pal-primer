// #676: a prepaid one_time service (visit canceled, payment refunded) offered
// Bill next / Edit / Pause / Delete service…, and Delete answered "This
// service has history. End it instead of deleting." — but End was only on the
// card once the service had started, and a one_time service starts on its
// visit day. The server also refused any end before started_on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canEndService,
  endServiceCopy,
  endServiceDecision,
  isServiceEnded,
} from "@/lib/subscription-form";

const TODAY = "2026-11-02";
const ONE_OFF = {
  status: "active",
  frequency: "one_time",
  billing_cadence: "prepaid",
  started_on: "2026-11-03",
  ends_on: "2026-11-03",
};

describe("canEndService", () => {
  it("offers End on a one_time service before its visit day", () => {
    expect(canEndService(ONE_OFF, TODAY)).toBe(true);
  });
  it("offers End on a started recurring service", () => {
    expect(canEndService({ status: "active", ends_on: null }, TODAY)).toBe(true);
  });
  it("does not offer End on a service that is already over", () => {
    expect(canEndService({ status: "canceled", ends_on: null }, TODAY)).toBe(false);
    expect(canEndService({ status: "active", ends_on: "2026-11-01" }, TODAY)).toBe(false);
  });
});

describe("endServiceDecision", () => {
  it("ends a not-yet-started one_time service today, canceled at once", () => {
    expect(
      endServiceDecision({ startedOn: ONE_OFF.started_on, effectiveDate: TODAY, today: TODAY }),
    ).toEqual({ ok: true, status: "canceled" });
  });

  it("the ended one-off reads as ended, so Bill next and Pause leave the card", () => {
    const d = endServiceDecision({
      startedOn: ONE_OFF.started_on,
      effectiveDate: TODAY,
      today: TODAY,
    });
    if (!d.ok) throw new Error(d.error);
    expect(isServiceEnded({ status: d.status, ends_on: TODAY }, TODAY)).toBe(true);
  });

  it("an end before a future start cancels at once: the service will never run", () => {
    expect(
      endServiceDecision({ startedOn: "2026-11-20", effectiveDate: "2026-11-10", today: TODAY }),
    ).toEqual({ ok: true, status: "canceled" });
  });

  it("refuses a past end date on a service that has not started", () => {
    const d = endServiceDecision({
      startedOn: "2026-11-20",
      effectiveDate: "2026-11-01",
      today: TODAY,
    });
    expect(d.ok).toBe(false);
  });

  it("still refuses ending a started service before it started", () => {
    const d = endServiceDecision({
      startedOn: "2026-10-01",
      effectiveDate: "2026-09-30",
      today: TODAY,
    });
    expect(d).toEqual({ ok: false, error: "End date can't be before the service started" });
  });

  it("keeps a future end on a started service active until the day", () => {
    expect(
      endServiceDecision({ startedOn: "2026-10-01", effectiveDate: "2026-11-30", today: TODAY }),
    ).toEqual({ ok: true, status: "active" });
    expect(
      endServiceDecision({ startedOn: "2026-10-01", effectiveDate: TODAY, today: TODAY }),
    ).toEqual({ ok: true, status: "canceled" });
  });
});

describe("endServiceCopy", () => {
  it("tells the owner a prepaid payment is not refunded automatically", () => {
    const { money, description } = endServiceCopy(ONE_OFF);
    expect(money).toMatch(/not refunded automatically/);
    expect(money).toMatch(/refund the payment/);
    expect(description).toMatch(/stops billing/);
    expect(description).toMatch(/Nothing is deleted/);
  });
  it("says no automatic refund for a postpaid service too", () => {
    expect(endServiceCopy({ billing_cadence: "postpaid", frequency: "weekly" }).money).toMatch(
      /Nothing is refunded automatically/,
    );
  });
});

describe("the wiring", () => {
  const root = join(__dirname, "..");
  const tab = readFileSync(join(root, "src/components/client-detail/ServicesTab.tsx"), "utf8");
  const fns = readFileSync(join(root, "src/lib/subscriptions.functions.ts"), "utf8");

  it("the card decides End with canEndService, not `started`", () => {
    expect(tab).toMatch(/const showEnd = canEndService\(s, today\)/);
  });
  it("the End drawer shows what happens to money already paid", () => {
    expect(tab).toMatch(/endServiceCopy\(/);
    expect(tab).toMatch(/\{copy\.money\}/);
  });
  it("endSubscription decides through endServiceDecision", () => {
    expect(fns).toMatch(/endServiceDecision\(\{/);
    expect(fns).toMatch(/status: decision\.status/);
  });
  it("Delete's refusal names the control that now exists", () => {
    expect(fns).toMatch(/Use End service… on the service instead/);
  });
});
