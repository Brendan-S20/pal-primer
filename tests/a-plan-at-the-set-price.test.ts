// planSetPriceCents (#728): the price a dispatcher's new plan is booked at is
// exactly what the wizard's Plan step shows before anybody types over it, and
// nothing when there is no such price. The handler tests in
// a-dispatcher-runs-routes-clients-and-messages.test.ts stub this function, so
// it is run for real here, against a fake database and a stubbed zone quote.

import { beforeEach, describe, expect, it, vi } from "vitest";

const quote = vi.hoisted(() => ({
  answer: {
    available: true,
    quote: { zoneId: "zone-1", recurringPriceCents: 3600 },
  } as any,
  calls: [] as any[],
}));

vi.mock("@/lib/internal-quote.server", () => ({
  internalQuote: vi.fn(async (_db: unknown, orgId: string, input: unknown) => {
    quote.calls.push({ orgId, input });
    return quote.answer;
  }),
}));

const {
  planSetPriceCents,
  NO_PLAN_SET_PRICE_ONE_TIME,
  NO_PLAN_SET_PRICE_RATES,
  NO_PLAN_SET_PRICE_SERVICE,
  NO_PLAN_SET_PRICE_ZONE,
} = await import("@/lib/plan-set-price.server");

function dbWithService(service: Record<string, unknown> | null) {
  const q: any = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: service, error: null }),
  };
  return { from: () => q };
}

const base = {
  orgId: "org-1",
  accountType: "residential" as const,
  frequency: "weekly" as const,
  postalCode: "60614",
  dogCount: 2,
};

const walk = {
  id: "svc-walk",
  organization_id: "org-1",
  active: true,
  service_line: "dog_walking",
  price_unit: "visit",
  base_price_cents: 2500,
  extra_pet_cents: 500,
  default_duration_min: 30,
};

beforeEach(() => {
  quote.calls.length = 0;
  quote.answer = { available: true, quote: { zoneId: "zone-1", recurringPriceCents: 3600 } };
});

describe("the set price of a new plan", () => {
  it("is the zone quote for a pet-waste plan, with the quote's zone", async () => {
    const r = await planSetPriceCents(dbWithService(null), base);
    expect(r).toEqual({ cents: 3600, zoneId: "zone-1", reason: null });
    expect(quote.calls[0]).toMatchObject({
      orgId: "org-1",
      input: { postalCode: "60614", dogCount: 2, frequency: "weekly" },
    });
  });

  it("asks the quote with the commercial counts for a commercial account", async () => {
    await planSetPriceCents(dbWithService(null), {
      ...base,
      accountType: "commercial",
      unitCount: 12,
      stationCount: 4,
    });
    expect(quote.calls[0].input).toMatchObject({ unitCount: 12, stationCount: 4 });
  });

  it("is a walk's own price for its pets, never a zone's", async () => {
    const r = await planSetPriceCents(dbWithService(walk), { ...base, serviceId: "svc-walk" });
    expect(r).toEqual({ cents: 3000, zoneId: null, reason: null });
    expect(quote.calls).toEqual([]);
  });

  it("refuses another business's service, or one that is off", async () => {
    await expect(
      planSetPriceCents(dbWithService({ ...walk, organization_id: "org-2" }), {
        ...base,
        serviceId: "svc-walk",
      }),
    ).rejects.toThrow("That service is not offered");
    await expect(
      planSetPriceCents(dbWithService({ ...walk, active: false }), {
        ...base,
        serviceId: "svc-walk",
      }),
    ).rejects.toThrow("That service is not offered");
  });

  it("has none, and says why, when there is nothing set", async () => {
    expect(
      await planSetPriceCents(dbWithService({ ...walk, base_price_cents: null }), {
        ...base,
        serviceId: "svc-walk",
      }),
    ).toMatchObject({ cents: null, reason: NO_PLAN_SET_PRICE_SERVICE });

    expect(
      await planSetPriceCents(dbWithService(null), { ...base, frequency: "one_time" }),
    ).toMatchObject({ cents: null, reason: NO_PLAN_SET_PRICE_ONE_TIME });

    quote.answer = { available: false };
    expect(await planSetPriceCents(dbWithService(null), base)).toMatchObject({
      cents: null,
      reason: NO_PLAN_SET_PRICE_ZONE,
    });

    quote.answer = { available: true, quote: { zoneId: "zone-1", recurringPriceCents: null } };
    expect(await planSetPriceCents(dbWithService(null), base)).toMatchObject({
      cents: null,
      reason: NO_PLAN_SET_PRICE_RATES,
    });
  });
});
