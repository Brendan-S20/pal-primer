import { describe, expect, it } from "vitest";
import { subscriptionToFormValues, blankSubscriptionFormValues } from "@/lib/subscription-form";

// Finding #8: the edit form must mirror the actual subscription record, not
// hardcoded defaults (weekly / $25 / 1 dog / no property).
const RECORD = {
  id: "sub-1",
  frequency: "biweekly",
  price_cents: 4500,
  dog_count: 2,
  unit_count: null,
  zone_id: "zone-9",
  property_id: "prop-7",
  billing_cadence: "postpaid",
  preferred_weekdays: [1, 3],
  started_on: "2026-07-01",
  ends_on: "2026-09-30",
};

describe("subscriptionToFormValues (finding #8)", () => {
  it("hydrates every field from the record — no default drift", () => {
    expect(subscriptionToFormValues(RECORD)).toEqual({
      propertyId: "prop-7",
      frequency: "biweekly",
      priceDollars: "45.00",
      dogCount: "2",
      unitCount: "1",
      zoneId: "zone-9",
      billingCadence: "postpaid",
      preferredWeekdays: [1, 3],
      startedOn: "2026-07-01",
      endsOn: "2026-09-30",
    });
  });

  it("defaults start date to today and end date to open-ended when the record has none", () => {
    const v = subscriptionToFormValues({ ...RECORD, started_on: null, ends_on: null });
    expect(v.startedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.endsOn).toBe("");
  });

  it("does not invent $25 or 'weekly' from a real record", () => {
    const v = subscriptionToFormValues(RECORD);
    expect(v.priceDollars).not.toBe("25.00");
    expect(v.frequency).not.toBe("weekly");
  });

  it("carries a prepaid cadence through", () => {
    expect(subscriptionToFormValues({ ...RECORD, billing_cadence: "prepaid" }).billingCadence).toBe(
      "prepaid",
    );
  });
});

describe("blankSubscriptionFormValues (finding #8)", () => {
  it("auto-selects the property (and its zone) when there is exactly one", () => {
    const v = blankSubscriptionFormValues({ properties: [{ id: "only-prop", zone_id: "z1" }] });
    expect(v.propertyId).toBe("only-prop");
    expect(v.zoneId).toBe("z1");
  });

  it("leaves the property unselected when there are several", () => {
    const v = blankSubscriptionFormValues({ properties: [{ id: "a" }, { id: "b" }] });
    expect(v.propertyId).toBe("");
  });

  it("uses an empty price rather than a misleading hardcoded default", () => {
    const v = blankSubscriptionFormValues({ properties: [] });
    expect(v.priceDollars).toBe("");
  });

  it("starts today with no end date", () => {
    const v = blankSubscriptionFormValues({ properties: [] });
    expect(v.startedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v.endsOn).toBe("");
  });
});
