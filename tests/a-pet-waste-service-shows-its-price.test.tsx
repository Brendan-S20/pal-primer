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
  oneTimeCleanupListLine,
  oneTimeCleanupPriceUpdate,
  petWasteOneTimeSave,
  petWastePriceLabel,
  servicePriceLabel,
} from "@/lib/services";
import {
  ONE_TIME_BLANK_MEANS,
  ONE_TIME_PRICE_INPUT_ID,
  PetWastePriceFields,
  STANDARD_PRICE_INPUT_ID,
} from "@/components/settings/PetWastePriceFields";
import {
  ONE_TIME_PRICE_LOAD_ERROR,
  formAfterSave,
  saveServiceThenOneTimePrice,
  type OneTimePriceWrite,
} from "@/lib/service-save";
import type { ServiceDraft } from "@/lib/services";
import { oneTimeCleanupVisitCents } from "@/lib/one-time-cleanup";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const page = () => read("src/routes/_authenticated/settings.services.tsx");

const fields = (props: Partial<Parameters<typeof PetWastePriceFields>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PetWastePriceFields, {
      standardPrice: "",
      extraDog: "",
      onStandardPriceChange: () => {},
      onExtraDogChange: () => {},
      zoneOverrides: null,
      oneTimePrice: "",
      savedOneTimeCents: null,
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

  it("edits the standard price, and links to Zones & pricing for overrides (#860)", () => {
    const html = fields({ standardPrice: "20.00", extraDog: "5.00", zoneOverrides: 2 });
    expect(html).toContain(`id="${STANDARD_PRICE_INPUT_ID}"`);
    expect(html).toContain('value="20.00"');
    expect(html).toContain('value="5.00"');
    expect(html).toContain("2 zones have their own price, which applies only inside that zone.");
    expect(html).toContain('href="/settings/zones"');
    expect(html).toMatch(/first-cleanup fee/);
    expect(html).toMatch(/does not change the price of plans you already have/);
    expect(fields({ zoneOverrides: 0 })).toContain("A zone can set its own price");
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
    expect(oneTimeCleanupListLine(saved.data.priceCents)).toBe(
      "One-time cleanup (any pet waste service): $75.00",
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
    // The order and the failure handling are saveServiceThenOneTimePrice's
    // and formAfterSave's, driven for real in "a price that fails to save"
    // below; this only pins that the page goes through them.
    expect(src).toMatch(/return saveServiceThenOneTimePrice\(\{/);
    expect(src).toMatch(/setOneTimePrice: \(data\) => setPortalBooking\(\{ data \}\)/);
    expect(src).toMatch(/const next = formAfterSave\(f, r\);/);
    // Same cache keys as the portal card and the zones page, so a save on any
    // of the three shows on the others.
    expect(src).toContain('queryKey: ["portal-booking-settings"]');
    expect(src).toContain('queryKey: ["zones"]');
    expect(src).toMatch(/invalidateQueries\(\{ queryKey: \["portal-booking-settings"\] \}\)/);
  });
});

describe("the Services list shows a real amount for pet waste (#788)", () => {
  // #860: each row shows ITS standard price; "no zone price yet" was shown
  // after the owner had saved $20, because the $20 was not the zone's.
  it("each pet-waste row shows its own standard price", () => {
    expect(petWastePriceLabel({ standardCents: 2000, perDogCents: 500, zoneOverrides: 0 })).toBe(
      "Standard price $20.00 per visit + $5.00 per extra dog",
    );
    expect(petWastePriceLabel({ standardCents: 2000, perDogCents: 0, zoneOverrides: 1 })).toBe(
      "Standard price $20.00 per visit · 1 zone with its own price",
    );
  });

  it("says what is missing rather than a bare 'Priced by your zones'", () => {
    const label = petWastePriceLabel({ standardCents: null, perDogCents: 0, zoneOverrides: 0 });
    expect(label).toBe("Standard price: not set yet");
    expect(label).not.toMatch(/no zone price yet/);
  });

  it("says the one-time cleanup once, above the list, not on every row", () => {
    expect(oneTimeCleanupListLine(null)).toBe(
      "One-time cleanup (any pet waste service): no price yet",
    );
    for (const z of [0, 2])
      expect(
        petWastePriceLabel({ standardCents: 2000, perDogCents: 0, zoneOverrides: z }),
      ).not.toMatch(/One-time cleanup/);
    expect(page()).toContain("{oneTimeCleanupListLine(portalQ.data.priceCents)}");
  });

  it("the list uses it for pet waste", () => {
    expect(page()).toMatch(
      /s\.service_line === "pet_waste"\s*\?\s*petWastePriceLabel\(\{\s*standardCents: s\.base_price_cents/,
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
        // A commercial rate is not what a homeowner's plan starts from.
        { base_price_cents: 900, pricing_mode: "flat", enabled: true, account_type: "commercial" },
        {
          base_price_cents: 2300,
          pricing_mode: "flat",
          enabled: true,
          account_type: "residential",
        },
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

describe("a price that fails to save does not make a second service (#812 review)", () => {
  const DRAFT: ServiceDraft = {
    name: "One-time cleanup",
    service_line: "pet_waste",
    price_unit: "visit",
    base_price_cents: null,
    extra_pet_cents: 0,
    default_duration_min: null,
  };
  const PRICE: OneTimePriceWrite = { autoAccept: false, priceCents: 7500 };

  /** A pretend backend: services by id, and the org's one price. */
  function backend(priceFailures: number) {
    const services = new Map<string, ServiceDraft>();
    let failuresLeft = priceFailures;
    const state = { oneOffPriceCents: null as number | null, creates: 0, updates: 0 };
    return {
      state,
      services,
      create: vi.fn(async (d: ServiceDraft) => {
        state.creates += 1;
        const id = `svc-${state.creates}`;
        services.set(id, d);
        return { id };
      }),
      update: vi.fn(async (id: string, d: ServiceDraft) => {
        if (!services.has(id)) throw new Error("That service was not found.");
        state.updates += 1;
        services.set(id, d);
        return { id };
      }),
      setOneTimePrice: vi.fn(async (data: OneTimePriceWrite) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("Failed to fetch");
        }
        state.oneOffPriceCents = data.priceCents;
        return { ok: true };
      }),
    };
  }

  /** One press of Save, the way the page does it: the writes, then what the
   *  dialog does with the answer. */
  async function pressSave(form: { id: string | null }, be: ReturnType<typeof backend>) {
    const r = await saveServiceThenOneTimePrice({
      id: form.id,
      draft: DRAFT,
      oneTime: PRICE,
      create: be.create,
      update: be.update,
      setOneTimePrice: be.setOneTimePrice,
    });
    return formAfterSave(form, r);
  }

  it("keeps the dialog open on the saved row, says so, and the retry updates that row", async () => {
    const be = backend(1);
    const first = await pressSave({ id: null }, be);
    expect(first.close).toBe(false);
    if (first.close) throw new Error("unreachable");
    expect(first.form.id).toBe("svc-1");
    expect(first.error).toBe(
      "Service added, but the one-time cleanup price was not saved: Failed to fetch. Press Save to try the price again.",
    );
    expect(be.services.size).toBe(1);
    expect(be.state.oneOffPriceCents).toBeNull();

    const second = await pressSave(first.form, be);
    expect(second).toEqual({ close: true });
    expect(be.create).toHaveBeenCalledTimes(1);
    expect(be.update).toHaveBeenCalledTimes(1);
    expect(be.update).toHaveBeenCalledWith("svc-1", DRAFT);
    expect(be.services.size).toBe(1);
    expect(be.state.oneOffPriceCents).toBe(7500);
  });

  it("still makes one service however many times the price fails", async () => {
    const be = backend(3);
    let form: { id: string | null } = { id: null };
    for (let i = 0; i < 4; i += 1) {
      const next = await pressSave(form, be);
      if (next.close) break;
      form = next.form;
    }
    expect(be.create).toHaveBeenCalledTimes(1);
    expect(be.services.size).toBe(1);
    expect(be.state.oneOffPriceCents).toBe(7500);
  });

  it("an edit whose price fails says saved, not added, and keeps its own id", async () => {
    const be = backend(1);
    await be.create(DRAFT);
    const next = await pressSave({ id: "svc-1" }, be);
    expect(next).toMatchObject({ close: false, form: { id: "svc-1" } });
    if (next.close) throw new Error("unreachable");
    expect(next.error).toMatch(/^Service saved, but the one-time cleanup price was not saved/);
  });

  it("a service that fails to save throws before any price is written", async () => {
    const be = backend(0);
    be.create.mockRejectedValueOnce(new Error("You already have a service with that name."));
    await expect(pressSave({ id: null }, be)).rejects.toThrow("already have a service");
    expect(be.setOneTimePrice).not.toHaveBeenCalled();
  });

  it("with no price to write, it saves the service and closes", async () => {
    const be = backend(0);
    const r = await saveServiceThenOneTimePrice({
      id: null,
      draft: DRAFT,
      oneTime: null,
      create: be.create,
      update: be.update,
      setOneTimePrice: be.setOneTimePrice,
    });
    expect(formAfterSave({ id: null }, r)).toEqual({ close: true });
    expect(be.setOneTimePrice).not.toHaveBeenCalled();
  });
});

describe("the copy says what a blank one-time price does, everywhere it is read (#812 review)", () => {
  it("names the booking link, the office's one-off and the portal's extra visits", () => {
    // #860: blank falls back to the standard price (or a zone's own), on the
    // booking link and for the office's one-off alike.
    expect(ONE_TIME_BLANK_MEANS).toMatch(
      /booking link and the office's one-off visits charge the standard price/,
    );
    expect(ONE_TIME_BLANK_MEANS).toMatch(/wait for you to price and book them/);
    const html = fields();
    expect(html).toContain(ONE_TIME_BLANK_MEANS.replace(/'/g, "&#x27;"));
    expect(html).not.toMatch(/Left blank, a one-time cleanup uses the zone/);
  });

  it("says the price could not be loaded rather than 'No price yet'", () => {
    const html = fields({ oneTimePrice: null, loadError: ONE_TIME_PRICE_LOAD_ERROR });
    expect(html).toContain("could not be loaded");
    expect(html).not.toContain("No price yet.");
  });
});

describe("more prices typed by hand", () => {
  const none = { priceCents: null, autoAccept: false };
  it("refuses a negative and a third decimal", () => {
    expect(oneTimeCleanupPriceUpdate("-5", none)).toHaveProperty("problem");
    expect(oneTimeCleanupPriceUpdate("75.999", none)).toHaveProperty("problem");
  });
  it("takes zero and a thousands separator", () => {
    expect(oneTimeCleanupPriceUpdate("0", none)).toEqual({
      data: { autoAccept: false, priceCents: 0 },
    });
    expect(oneTimeCleanupPriceUpdate("$1,000.50", none)).toEqual({
      data: { autoAccept: false, priceCents: 100050 },
    });
  });
});
