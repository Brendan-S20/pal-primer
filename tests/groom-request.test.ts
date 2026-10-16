// The pure half of a portal groom request: the quote the client sees is the
// office's quote, the window round-trips, and "Book this groom" opens the
// dialog with the request's own values.

import { describe, expect, it } from "vitest";
import { groomHoldMinutes, groomQuote } from "@/lib/groom";
import {
  GROOM_WINDOWS,
  GROOM_WINDOW_KEYS,
  groomPrefillFromRequest,
  groomRequestQuote,
  groomRequestRefusal,
  groomWindowOf,
} from "@/lib/groom-request";

const service = {
  id: "svc",
  price_unit: "visit" as const,
  base_price_cents: 8000,
  extra_pet_cents: 0,
  default_duration_min: 90,
};
const rules = [
  {
    service_id: "svc",
    size: "large" as const,
    coat_type: null,
    duration_min: 120,
    price_cents: 11000,
  },
  {
    service_id: "svc",
    size: "large" as const,
    coat_type: "double" as const,
    duration_min: 150,
    price_cents: 13000,
  },
  {
    service_id: "other",
    size: "large" as const,
    coat_type: null,
    duration_min: 30,
    price_cents: 100,
  },
];
const addons = [
  { id: "teeth", name: "Teeth brushing", unit_price_cents: 1500, duration_min: 10 },
  { id: "nails", name: "Nail grind", unit_price_cents: 1200, duration_min: null },
];

describe("the portal quote is the office's quote", () => {
  it("prices a pet by size and coat, adds add-ons and holds setup and cleanup", () => {
    const pet = { id: "p", name: "Biscuit", size: "large" as const, coat_type: "double" as const };
    const picked = [
      { addonServiceId: "teeth", quantity: 1 },
      { addonServiceId: "nails", quantity: 2 },
    ];
    const office = groomQuote({
      service,
      rules: rules.filter((r) => r.service_id === "svc"),
      pets: [pet],
      addons: [
        { ...addons[0], duration_min: 10, quantity: 1 },
        { ...addons[1], duration_min: 0, quantity: 2 },
      ],
    });
    const portal = groomRequestQuote({ service, rules, pet, addons, picked, bufferMin: 20 });
    expect(portal.cents).toBe(office.cents);
    expect(portal.cents).toBe(13000 + 1500 + 2400);
    expect(portal.minutes).toBe(groomHoldMinutes(office.minutes, 20));
    expect(portal.minutes).toBe(150 + 10 + 20);
  });

  it("ignores another service's rules and falls back to the service price", () => {
    const pet = { id: "p", name: "Pip", size: null, coat_type: null };
    expect(groomRequestQuote({ service, rules, pet, addons, picked: [], bufferMin: null })).toEqual(
      {
        cents: 8000,
        minutes: 90 + 15,
      },
    );
  });

  it("leaves the price to the office when the business has none", () => {
    const pet = { id: "p", name: "Pip", size: null, coat_type: null };
    const unpriced = { ...service, base_price_cents: null };
    expect(
      groomRequestQuote({ service: unpriced, rules: [], pet, addons, picked: [], bufferMin: 0 })
        .cents,
    ).toBeNull();
  });
});

describe("windows and refusals", () => {
  it("reads a stored window back to the key the form used", () => {
    for (const k of GROOM_WINDOW_KEYS) {
      const w = GROOM_WINDOWS[k];
      expect(groomWindowOf(w.from && `${w.from}:00`, w.until && `${w.until}:00`)).toBe(k);
    }
    expect(groomWindowOf("06:00:00", "07:00:00")).toBe("any");
  });

  it("words every code the database raises and nothing else", () => {
    expect(groomRequestRefusal("ERROR: pet_not_found")).toBe("Choose one of your pets.");
    expect(groomRequestRefusal("grooming_not_offered")).toMatch(/isn't offered/);
    expect(groomRequestRefusal("relation does not exist")).toMatch(/could not be sent/);
  });
});

describe("Book this groom opens the dialog with the request", () => {
  it("carries the pet, groom, add-ons, day and the start of the window", () => {
    expect(
      groomPrefillFromRequest({
        property_id: "prop",
        service_id: "svc",
        dog_id: "dog",
        requested_on: "2026-11-02",
        requested_time: "12:00:00",
        groom_addons: [
          { addon_service_id: "teeth", quantity: 1 },
          { addon_service_id: 7, quantity: 1 },
          { addon_service_id: "nails", quantity: 0 },
        ],
      }),
    ).toEqual({
      propertyId: "prop",
      serviceId: "svc",
      petIds: ["dog"],
      addons: [{ addonServiceId: "teeth", quantity: 1 }],
      scheduledOn: "2026-11-02",
      startTime: "12:00",
    });
  });

  it("has nothing to open when the pet or address has since been deleted", () => {
    expect(
      groomPrefillFromRequest({
        property_id: null,
        service_id: "svc",
        dog_id: "dog",
        requested_on: "2026-11-02",
        requested_time: null,
        groom_addons: [],
      }),
    ).toBeNull();
  });
});
