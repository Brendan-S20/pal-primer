import { describe, expect, it } from "vitest";
import {
  ACTIVE_EMPLOYEE_DEFINITION,
  arrearsFrom,
  newSubscriptionSeatMarker,
  seatOverage,
  seatTarget,
  subscriptionPeriod,
} from "@/lib/seat-rule";

// The counting rule, owner's decision 2026-10-09: an active employee for
// billing is anybody who used their login at least once during the billing
// period, in any role. WHO was seen is proved against Postgres in
// tests/sql/a-seat-is-somebody-who-showed-up.proof.sql; this file proves what
// that number becomes on the Stripe seat line, and for which period.

const P = { start: 1_759_968_000, end: 1_762_646_400 };
const ARREARS = newSubscriptionSeatMarker();

describe("seatOverage: people seen past the plan's allowance", () => {
  it.each([
    // [seen this period, included, billed]
    [0, 3, 0], // nobody used it: nothing
    [3, 3, 0], // exactly the Launch allowance
    [5, 3, 2], // Launch, five people used it
    [13, 10, 3], // Growth
    [30, 30, 0], // Scale, full
    [31, 30, 1],
  ])("%i seen on a plan including %i bills %i", (seen, included, billed) => {
    expect(seatOverage(seen, included)).toBe(billed);
  });

  it("never goes negative or fractional on bad input", () => {
    expect(seatOverage(-4, 3)).toBe(0);
    expect(seatOverage(Number.NaN, 3)).toBe(0);
    expect(seatOverage(5.9, 3)).toBe(2);
    expect(seatOverage(5, -1)).toBe(5);
  });
});

describe("the edges, as they reach the seat line", () => {
  // Each edge is decided in the database (who is in the count); here it is
  // carried through to what Stripe bills. Launch: 3 included.
  const bill = (seenThisPeriod: number) =>
    seatTarget({ period: P, metadata: ARREARS, billableSeats: seenThisPeriod, includedSeats: 3 })
      .quantity;

  it("a team of six where only the owner and two techs opened the app costs nothing extra", () => {
    expect(bill(3)).toBe(0);
  });

  it("somebody who worked this period and was then deactivated is still on this period's bill", () => {
    // Owner + 3 techs used it; one tech left mid-period. The ledger still has
    // their sightings, so the count is 4, not 3.
    expect(bill(4)).toBe(1);
  });

  it("a brand-new hire is billed from the period they first use the app, as one whole seat", () => {
    expect(bill(3)).toBe(0); // before their first sighting
    expect(bill(4)).toBe(1); // after it, for the whole period, unprorated
  });
});

describe("subscriptionPeriod", () => {
  it("reads the period off the items, where current API versions put it", () => {
    expect(
      subscriptionPeriod({
        items: {
          data: [
            { current_period_start: P.start, current_period_end: P.end },
            { current_period_start: P.start, current_period_end: P.end },
          ],
        },
      }),
    ).toEqual(P);
  });

  it("reads the subscription's own period on older versions", () => {
    expect(
      subscriptionPeriod({ current_period_start: P.start, current_period_end: P.end }),
    ).toEqual(P);
  });

  it("takes the item with the latest end when they disagree", () => {
    expect(
      subscriptionPeriod({
        items: {
          data: [
            { current_period_start: P.start - 100, current_period_end: P.end - 100 },
            { current_period_start: P.start, current_period_end: P.end },
          ],
        },
      }),
    ).toEqual(P);
  });

  it("is null rather than a guess when Stripe gave nothing usable", () => {
    expect(subscriptionPeriod(null)).toBeNull();
    expect(subscriptionPeriod({ items: { data: [{ current_period_end: P.end }] } })).toBeNull();
    expect(
      subscriptionPeriod({ current_period_start: P.end, current_period_end: P.start }),
    ).toBeNull();
  });
});

describe("the changeover: no period's seats are billed twice", () => {
  it("a subscription with no marker prepaid this period: bill 0, and mark arrears from the next", () => {
    const t = seatTarget({
      period: P,
      metadata: { plan_id: "x" },
      billableSeats: 9,
      includedSeats: 3,
    });
    expect(t).toEqual({
      quantity: 0,
      prepaid: true,
      markWith: { seat_billing: "arrears", seat_arrears_from: String(P.end) },
    });
  });

  it("once the marked period arrives, it is billed in arrears", () => {
    const metadata = { seat_billing: "arrears", seat_arrears_from: String(P.start) };
    expect(seatTarget({ period: P, metadata, billableSeats: 9, includedSeats: 3 })).toEqual({
      quantity: 6,
      prepaid: false,
      markWith: null,
    });
  });

  it("a marked subscription still in its prepaid period stays at zero and is not re-marked", () => {
    const metadata = { seat_billing: "arrears", seat_arrears_from: String(P.end) };
    expect(seatTarget({ period: P, metadata, billableSeats: 9, includedSeats: 3 })).toEqual({
      quantity: 0,
      prepaid: true,
      markWith: null,
    });
  });

  it("a new subscription is in arrears from its very first period", () => {
    expect(arrearsFrom(newSubscriptionSeatMarker())).toBe(0);
    expect(
      seatTarget({
        period: P,
        metadata: newSubscriptionSeatMarker(),
        billableSeats: 5,
        includedSeats: 3,
      }).quantity,
    ).toBe(2);
  });

  it("a marker it cannot read is treated as no marker, never as arrears from the start", () => {
    // Reading garbage as "arrears from 0" would bill a prepaid period again.
    expect(arrearsFrom({ seat_billing: "arrears", seat_arrears_from: "soon" })).toBeNull();
    expect(arrearsFrom({ seat_billing: "something-else", seat_arrears_from: "0" })).toBeNull();
    expect(arrearsFrom(undefined)).toBeNull();
  });
});

describe("the words", () => {
  it("say what the owner decided", () => {
    expect(ACTIVE_EMPLOYEE_DEFINITION).toMatch(/anyone who used their login this billing period/);
  });
});
