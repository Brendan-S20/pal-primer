// #788: a new owner opened Settings -> Services, added a Pet waste removal
// service, and found no price field: a sentence saying pet waste is not
// priced here, and a list that read "Priced by your zones" with no figure.
// Their $75 one-time cleanup could only be typed into Settings -> Client
// portal -> Price of an extra visit.
//
// The product model is unchanged (plans by zone, a one-time cleanup at
// organizations.one_off_price_cents, one-time-cleanup.ts), so the fix does
// not invent a third price. It shows the two real amounts on the Services
// screen and edits the one-time price there, through the SAME server function
// the Client portal card uses. These tests pin:
//
//   1. the pet-waste form exposes a price control (and a non-editable amount
//      with the way to it when the caller may not change it);
//   2. what Save sends is the amount the list then shows ($75.00);
//   3. the list shows real amounts once set, and says what is missing when
//      not, never "Priced by your zones" alone;
//   4. Services, the portal card and zones read the same settings.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, hash }: { children: ReactNode; to: string; hash?: string }) =>
    createElement("a", { href: hash ? `${to}#${hash}` : to }, children),
}));

import {
  ONE_OFF_PRICE_SETTING_HASH,
  ONE_OFF_PRICE_SETTING_PATH,
  ONE_TIME_CLEANUP_PRICE_LABEL,
  lowestZoneVisitCents,
  oneTimeCleanupPriceUpdate,
  petWasteOneTimeSave,
  petWastePriceLabel,
  servicePriceLabel,
} from "@/lib/services";
import {
  ONE_TIME_PRICE_INPUT_ID,
  PetWastePriceFields,
} from "@/components/settings/PetWastePriceFields";
import { oneTimeCleanupVisitCents } from "@/lib/one-time-cleanup";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const page = () => read("src/routes/_authenticated/settings.services.tsx");

const fields = (props: Partial<Parameters<typeof PetWastePriceFields>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PetWastePriceFields, {
      oneTimePrice: "",
      savedOneTimeCents: null,
      zoneFromCents: null,
      onOneTimePriceChange: () => {},
      ...props,
    }),
  );

describe("the Add / Edit service form for pet waste has a price control (#788)", () => {
  it("draws a one-time cleanup price input holding the saved amount", () => {
    const html = fields({ oneTimePrice: "75.00", savedOneTimeCents: 7500 });
    expect(html).toContain(`id="${ONE_TIME_PRICE_INPUT_ID}"`);
    expect(html).toContain('value="75.00"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain(ONE_TIME_CLEANUP_PRICE_LABEL.replace("($)", "").trim());
    expect(html).not.toMatch(/not priced here/i);
  });

  it("shows the zone price as a figure and links to Zones & pricing, first cleanup included", () => {
    const html = fields({ zoneFromCents: 2500 });
    expect(html).toContain("from $25.00 per visit");
    expect(html).toContain('href="/zones"');
    expect(html).toMatch(/first-cleanup fee/);
    expect(fields({ zoneFromCents: null })).toContain("No zone has a price yet.");
  });

  it("names the Client portal field it shares, and links to it", () => {
    const html = fields();
    expect(html).toContain(`href="${ONE_OFF_PRICE_SETTING_PATH}#${ONE_OFF_PRICE_SETTING_HASH}"`);
    expect(html).toContain("Price of an extra visit");
  });

  it("shows the amount, not a dead end, when the caller may not edit it here", () => {
    const html = fields({ oneTimePrice: null, savedOneTimeCents: 7500 });
    expect(html).not.toContain(`id="${ONE_TIME_PRICE_INPUT_ID}"`);
    expect(html).toContain("$75.00 per cleanup.");
    expect(fields({ oneTimePrice: null, savedOneTimeCents: null })).toContain("No price yet.");
  });

  it("is what the Services form draws for pet waste, in place of the old note", () => {
    const src = page();
    expect(src).toMatch(/petWaste \? \(\s*(\/\/[^\n]*\n\s*)*<PetWastePriceFields/);
    expect(src).not.toMatch(/Pet waste is not priced here/);
  });
});

describe("saving persists the amount the list shows (#788)", () => {
  const setting = { priceCents: null, autoAccept: false, canEdit: true };

  it("turns $75 typed on the form into the portal setting's 7500 cents", () => {
    expect(petWasteOneTimeSave("pet_waste", "75", setting)).toEqual({
      data: { autoAccept: false, priceCents: 7500 },
    });
    expect(petWasteOneTimeSave("pet_waste", "$75.00", setting)).toEqual({
      data: { autoAccept: false, priceCents: 7500 },
    });
  });

  it("and the list then reads that amount", () => {
    const saved = petWasteOneTimeSave("pet_waste", "75", setting);
    if (!saved || "problem" in saved) throw new Error("expected a write");
    expect(petWastePriceLabel({ zoneFromCents: 2500, oneTimeCents: saved.data.priceCents })).toBe(
      "Plans from $25.00 per visit, by zone · One-time cleanup $75.00",
    );
    // The booking link and quotes price a one-time cleanup from the same number.
    expect(
      oneTimeCleanupVisitCents({ zoneVisitCents: 2500, oneOffPriceCents: saved.data.priceCents }),
    ).toBe(7500);
  });

  it("writes nothing when the price did not change, the line is not pet waste, or it was not offered", () => {
    const at75 = { priceCents: 7500, autoAccept: true, canEdit: true };
    expect(petWasteOneTimeSave("pet_waste", "75.00", at75)).toBeNull();
    expect(petWasteOneTimeSave("dog_walking", "80", at75)).toBeNull();
    expect(petWasteOneTimeSave("pet_waste", null, at75)).toBeNull();
    expect(petWasteOneTimeSave("pet_waste", "80", { ...at75, canEdit: false })).toBeNull();
    expect(petWasteOneTimeSave("pet_waste", "80", null)).toBeNull();
  });

  it("keeps auto-accept as it was, and turns it off only with the price, like the portal card", () => {
    const on = { priceCents: 7500, autoAccept: true };
    expect(oneTimeCleanupPriceUpdate("80", on)).toEqual({
      data: { autoAccept: true, priceCents: 8000 },
    });
    expect(oneTimeCleanupPriceUpdate("", on)).toEqual({
      data: { autoAccept: false, priceCents: null },
    });
  });

  it("refuses a price that is not one, in a sentence, before anything is written", () => {
    expect(oneTimeCleanupPriceUpdate("seventy", { priceCents: null, autoAccept: false })).toEqual({
      problem: "Enter the one-time cleanup price as dollars and cents, like 75.00.",
    });
    expect(
      oneTimeCleanupPriceUpdate("10000.01", { priceCents: null, autoAccept: false }),
    ).toMatchObject({ problem: expect.stringContaining("$10,000.00") });
  });

  it("the page saves the service, then the price, through the portal's own server function", () => {
    const src = page();
    expect(src).toContain(
      'import { getPortalBookingSettings, setPortalBookingSettings } from "@/lib/portal-booking.functions";',
    );
    expect(src).toMatch(/const plan = savePlanOf\(f, oneTime\);/);
    expect(src).toMatch(
      /if \(plan\.oneTime\) await setPortalBooking\(\{ data: plan\.oneTime \}\);/,
    );
    // Same cache keys as the portal card and the zones page, so a save on any
    // of the three shows on the others.
    expect(src).toContain('queryKey: ["portal-booking-settings"]');
    expect(src).toContain('queryKey: ["zones"]');
    expect(src).toMatch(/invalidateQueries\(\{ queryKey: \["portal-booking-settings"\] \}\)/);
  });
});

describe("the Services list shows a real amount for pet waste (#788)", () => {
  it("both amounts once set", () => {
    expect(petWastePriceLabel({ zoneFromCents: 2500, oneTimeCents: 7500 })).toBe(
      "Plans from $25.00 per visit, by zone · One-time cleanup $75.00",
    );
  });

  it("says what is missing rather than a bare 'Priced by your zones'", () => {
    const label = petWastePriceLabel({ zoneFromCents: null, oneTimeCents: null });
    expect(label).toBe("Plans: no zone price yet · One-time cleanup: no price yet");
    expect(label).not.toBe("Priced by your zones");
  });

  it("the list uses it for pet waste once the two settings have loaded", () => {
    expect(page()).toMatch(
      /s\.service_line === "pet_waste" && portalQ\.data && zonesQ\.data\s*\?\s*petWastePriceLabel/,
    );
    expect(page()).toContain("{priceLabelOf(s)}");
    // Every other line keeps its own price, unchanged.
    expect(
      servicePriceLabel({
        service_line: "dog_walking",
        price_unit: "visit",
        base_price_cents: 2500,
        extra_pet_cents: 0,
      }),
    ).toBe("$25.00 per visit");
  });
});

describe("the zone 'from' figure", () => {
  it("is the lowest switched-on, flat-priced zone", () => {
    expect(
      lowestZoneVisitCents([
        { base_price_cents: 3000, pricing_mode: "flat", enabled: true },
        { base_price_cents: 2200, pricing_mode: null, enabled: true },
        { base_price_cents: 1000, pricing_mode: "flat", enabled: false },
        { base_price_cents: 500, pricing_mode: "per_sqft", enabled: true },
        { base_price_cents: null, pricing_mode: "flat", enabled: true },
      ]),
    ).toBe(2200);
  });

  it("is null with no zones or none priced", () => {
    expect(lowestZoneVisitCents([])).toBeNull();
    expect(lowestZoneVisitCents(undefined)).toBeNull();
    expect(lowestZoneVisitCents([{ base_price_cents: null }])).toBeNull();
  });
});
