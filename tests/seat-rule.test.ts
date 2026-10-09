import { describe, expect, it } from "vitest";
import {
  ACTIVE_EMPLOYEE_DEFINITION,
  addMonthsUtc,
  arrearsFrom,
  changeoverMarker,
  closedSeatPeriods,
  newSubscriptionSeatMarker,
  seatChargeLine,
  seatOverage,
  seatPeriodAt,
  seatPeriodLabel,
  subscriptionPeriod,
} from "@/lib/seat-rule";

// The counting and charging rule, owner's decisions of 2026-10-09:
//
//   * an active employee is anyone who used their login in the period;
//   * a seat period is one month, on monthly and yearly plans alike;
//   * each period is charged once, after it closes, as its own dated line;
//   * a cancelled subscription's final period is charged once, cut at the end;
//   * a period prepaid under the old rule stays paid; the new rule starts next.
//
// WHO was seen is proved against Postgres in
// tests/sql/a-seat-is-somebody-who-showed-up.proof.sql; this file proves which
// periods are charged and what each charge says.

const at = (iso: string) => Date.parse(iso) / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const ANCHOR = at("2026-01-09T15:00:00Z");

describe("seatOverage: people seen past the plan's allowance", () => {
  it.each([
    // [seen in the period, included, charged]
    [0, 3, 0], // nobody used it: nothing
    [3, 3, 0], // exactly the Launch allowance
    [5, 3, 2], // Launch, five people used it
    [13, 10, 3], // Growth
    [30, 30, 0], // Scale, full
    [31, 30, 1],
  ])("%i seen on a plan including %i charges %i", (seen, included, charged) => {
    expect(seatOverage(seen, included)).toBe(charged);
  });

  it("never goes negative or fractional on bad input", () => {
    expect(seatOverage(-4, 3)).toBe(0);
    expect(seatOverage(Number.NaN, 3)).toBe(0);
    expect(seatOverage(5.9, 3)).toBe(2);
    expect(seatOverage(5, -1)).toBe(5);
  });

  it("the edges, as they reach the charge (Launch, 3 included)", () => {
    // Six on the team; only the owner and two techs opened the app.
    expect(seatOverage(3, 3)).toBe(0);
    // Owner + 3 techs used it; one tech left mid-period. The ledger still has
    // their sightings, so the count is 4, not 3: one extra seat.
    expect(seatOverage(4, 3)).toBe(1);
    // A brand-new hire's first use makes them one whole seat for the period.
    expect(seatOverage(3 + 1, 3)).toBe(1);
  });
});

describe("seat periods are months from the billing anchor", () => {
  it("steps a month at a time, at the anchor's own hour", () => {
    expect(iso(addMonthsUtc(ANCHOR, 1))).toBe("2026-02-09T15:00:00.000Z");
    expect(iso(addMonthsUtc(ANCHOR, 12))).toBe("2027-01-09T15:00:00.000Z");
    expect(iso(addMonthsUtc(ANCHOR, -1))).toBe("2025-12-09T15:00:00.000Z");
  });

  it("keeps a 31st anchor on the last day of a shorter month, and back to the 31st", () => {
    const a = at("2026-01-31T00:00:00Z");
    expect(iso(addMonthsUtc(a, 1))).toBe("2026-02-28T00:00:00.000Z");
    expect(iso(addMonthsUtc(a, 2))).toBe("2026-03-31T00:00:00.000Z");
    expect(iso(addMonthsUtc(a, 13))).toBe("2027-02-28T00:00:00.000Z");
  });

  it("finds the month a moment falls in, boundaries included", () => {
    expect(seatPeriodAt(ANCHOR, at("2026-03-20T00:00:00Z"))).toEqual({
      start: at("2026-03-09T15:00:00Z"),
      end: at("2026-04-09T15:00:00Z"),
    });
    // The boundary itself belongs to the period it opens.
    expect(seatPeriodAt(ANCHOR, at("2026-04-09T15:00:00Z")).start).toBe(at("2026-04-09T15:00:00Z"));
    expect(seatPeriodAt(ANCHOR, at("2026-04-09T14:59:59Z")).start).toBe(at("2026-03-09T15:00:00Z"));
  });
});

describe("which periods are charged", () => {
  it("a monthly renewal: the month that just closed, and nothing still open", () => {
    const due = closedSeatPeriods({
      anchor: ANCHOR,
      from: at("2026-02-09T15:00:00Z"),
      until: at("2026-03-09T15:00:05Z"), // the renewal invoice, seconds after the boundary
    });
    expect(due).toEqual([{ start: at("2026-02-09T15:00:00Z"), end: at("2026-03-09T15:00:00Z") }]);
  });

  it("a yearly plan is charged month by month: three closed months, three charges", () => {
    // Anchored on Jan 9; the yearly invoice is next January, but the months
    // close every month and each is charged on its own.
    const due = closedSeatPeriods({ anchor: ANCHOR, from: ANCHOR, until: at("2026-04-20T00:00:00Z") });
    expect(due.map((p) => iso(p.start))).toEqual([
      "2026-01-09T15:00:00.000Z",
      "2026-02-09T15:00:00.000Z",
      "2026-03-09T15:00:00.000Z",
    ]);
  });

  it("a seasonal helper who only worked in March costs only March", () => {
    // The months are separate charges; a month nobody extra used charges 0.
    const used = new Map([[at("2026-03-09T15:00:00Z"), 4]]); // 4 people in March, 3 otherwise
    const charges = closedSeatPeriods({ anchor: ANCHOR, from: ANCHOR, until: at("2026-04-20T00:00:00Z") }).map(
      (p) => seatOverage(used.get(p.start) ?? 3, 3),
    );
    expect(charges).toEqual([0, 0, 1]);
  });

  it("a cancellation charges the final period once, cut at the moment it ended", () => {
    const ended = at("2026-03-20T10:00:00Z");
    const due = closedSeatPeriods({
      anchor: ANCHOR,
      from: at("2026-03-09T15:00:00Z"),
      until: ended,
      endedAt: ended,
    });
    expect(due).toEqual([{ start: at("2026-03-09T15:00:00Z"), end: ended }]);
  });

  it("a cancellation at period end charges that whole period, and nothing after", () => {
    const ended = at("2026-04-09T15:00:00Z");
    expect(
      closedSeatPeriods({ anchor: ANCHOR, from: at("2026-03-09T15:00:00Z"), until: ended, endedAt: ended }),
    ).toEqual([{ start: at("2026-03-09T15:00:00Z"), end: ended }]);
  });

  it("never a period that began before the floor: the prepaid one, or one before the subscription", () => {
    // Changed over mid-March: March was prepaid, so April is the first charged.
    const due = closedSeatPeriods({
      anchor: ANCHOR,
      from: at("2026-04-09T15:00:00Z"),
      until: at("2026-05-10T00:00:00Z"),
    });
    expect(due.map((p) => iso(p.start))).toEqual(["2026-04-09T15:00:00.000Z"]);
    // A floor that falls mid-month skips that month entirely.
    expect(
      closedSeatPeriods({ anchor: ANCHOR, from: at("2026-03-15T00:00:00Z"), until: at("2026-04-10T00:00:00Z") }),
    ).toEqual([]);
  });

  it("nothing when the floor is infinite (a subscription still on the old rule)", () => {
    expect(closedSeatPeriods({ anchor: ANCHOR, from: Number.POSITIVE_INFINITY, until: at("2027-01-01T00:00:00Z") })).toEqual([]);
  });
});

describe("the invoice line", () => {
  it("is dated for the period it covers, in the business's time zone, last day inclusive", () => {
    const sep = { start: at("2026-09-01T05:00:00Z"), end: at("2026-10-01T05:00:00Z") };
    expect(seatPeriodLabel(sep, "America/Chicago")).toBe("Sep 1–30");
    expect(seatPeriodLabel({ start: at("2026-09-09T15:00:00Z"), end: at("2026-10-09T15:00:00Z") })).toBe(
      "Sep 9 – Oct 9",
    );
    expect(
      seatPeriodLabel({ start: at("2026-12-09T15:00:00Z"), end: at("2027-01-09T15:00:00Z") }, "UTC"),
    ).toBe("Dec 9, 2026 – Jan 9, 2027");
  });

  it("says what it is, how many and at what price, and charges seats × price", () => {
    const sep = { start: at("2026-09-01T05:00:00Z"), end: at("2026-10-01T05:00:00Z") };
    expect(seatChargeLine({ period: sep, seats: 2, unitAmountCents: 1000, timeZone: "America/Chicago" })).toEqual({
      description: "Extra active employees, Sep 1–30 (2 × $10.00)",
      amountCents: 2000,
    });
  });
});

describe("the changeover marker", () => {
  it("a new subscription is charged by period from its first month", () => {
    expect(arrearsFrom(newSubscriptionSeatMarker())).toBe(0);
  });

  it("an old subscription's marker starts the new rule when its prepaid period ends", () => {
    expect(arrearsFrom(changeoverMarker(at("2026-11-09T15:00:00Z")))).toBe(at("2026-11-09T15:00:00Z"));
  });

  it("a marker it cannot read is no marker -- never 'charge from the start'", () => {
    // Reading garbage as 0 would charge a prepaid period a second time.
    expect(arrearsFrom({ seat_billing: "arrears", seat_arrears_from: "soon" })).toBeNull();
    expect(arrearsFrom({ seat_billing: "something-else", seat_arrears_from: "0" })).toBeNull();
    expect(arrearsFrom(undefined)).toBeNull();
  });
});

describe("subscriptionPeriod", () => {
  const P = { start: 1_759_968_000, end: 1_762_646_400 };
  it("reads the period off the items, where current API versions put it", () => {
    expect(
      subscriptionPeriod({
        items: { data: [{ current_period_start: P.start, current_period_end: P.end }] },
      }),
    ).toEqual(P);
  });

  it("is null rather than a guess when Stripe gave nothing usable", () => {
    expect(subscriptionPeriod(null)).toBeNull();
    expect(subscriptionPeriod({ items: { data: [{ current_period_end: P.end }] } })).toBeNull();
    expect(subscriptionPeriod({ current_period_start: P.end, current_period_end: P.start })).toBeNull();
  });
});

describe("the words", () => {
  it("say what the owner decided", () => {
    expect(ACTIVE_EMPLOYEE_DEFINITION).toMatch(/anyone who used their login this billing period/);
  });
});
