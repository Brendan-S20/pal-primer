// R2-31 (groom-r2-08): a client's visit list said "One time service" for a
// Bath & brush, and the day board summed plan prices only — "All 3 · $360"
// for a day booked at $410, because a groom's add-ons live on its plan.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bookedCentsOf, visitBookedCents } from "@/lib/booked-value";
import { visitServiceLabel } from "@/lib/subscription-form";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("visitBookedCents", () => {
  it("adds each booked add-on to the plan price", () => {
    expect(
      visitBookedCents({
        price_cents: 19000,
        groom_addons: [
          { addon_service_id: "a", quantity: 1, unit_price_cents: 2500, name: "Teeth" },
          { addon_service_id: "b", quantity: 2, unit_price_cents: 500, name: "Bow" },
        ],
      }),
    ).toBe(22500);
  });
  it("is the plan price when there are no add-ons, or they are not a list", () => {
    expect(visitBookedCents({ price_cents: 1800, groom_addons: null })).toBe(1800);
    expect(visitBookedCents({ price_cents: 1800, groom_addons: {} })).toBe(1800);
    expect(visitBookedCents(null)).toBe(0);
  });
  it("ignores a malformed add-on rather than adding NaN", () => {
    expect(visitBookedCents({ price_cents: 100, groom_addons: [{ quantity: "x" }, null] })).toBe(
      100,
    );
  });
  it("sums the audit's day: 190 + 90 + 80 plus 25 + 10 + 15 is 410", () => {
    const day = [
      {
        subscriptions: {
          price_cents: 19000,
          groom_addons: [{ quantity: 1, unit_price_cents: 2500 }],
        },
      },
      {
        subscriptions: {
          price_cents: 9000,
          groom_addons: [{ quantity: 1, unit_price_cents: 1000 }],
        },
      },
      {
        subscriptions: {
          price_cents: 8000,
          groom_addons: [{ quantity: 1, unit_price_cents: 1500 }],
        },
      },
    ];
    expect(bookedCentsOf(day)).toBe(41000);
  });
});

describe("visitServiceLabel", () => {
  it("names the service that was booked", () => {
    expect(visitServiceLabel({ frequency: "one_time", services: { name: "Bath & brush" } })).toBe(
      "Bath & brush",
    );
  });
  it("falls back to the cadence with no catalog service", () => {
    expect(visitServiceLabel({ frequency: "one_time", services: null })).toBe("One time service");
    expect(visitServiceLabel({ frequency: "weekly" })).toBe("Recurring service");
    expect(visitServiceLabel(null)).toBe("-");
  });
});

describe("the screens read through it", () => {
  it("the board's lane and tech totals use bookedCentsOf, and its query reads the add-ons", () => {
    const board = read("src/routes/_authenticated/routes.tsx");
    expect(board).toMatch(/const totalCents = bookedCentsOf\(items\)/);
    expect(board).toMatch(/const bookedValue = bookedCentsOf\(mine\)/);
    expect(board).not.toMatch(/subscriptions\?\.price_cents \?\? 0\), 0\)/);
    expect(read("src/lib/visits.functions.ts")).toMatch(
      /stays\(kind, starts_on, ends_on\), groom_addons\), service_id/,
    );
  });
  it("the client's Visits list names the service and prices the visit with its add-ons", () => {
    const tab = read("src/components/client-detail/VisitsTab.tsx");
    expect(tab).toMatch(/\{visitServiceLabel\(service\)\}/);
    expect(tab).toMatch(/visitBookedCents\(service\)/);
    expect(tab).not.toMatch(/"One time" : "Recurring"/);
    expect(read("src/lib/subscriptions.functions.ts")).toMatch(/stay_id, groom_addons"/);
  });
});
