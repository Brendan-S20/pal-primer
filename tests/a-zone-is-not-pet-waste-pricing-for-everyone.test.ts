// R2-38 (round-2 audit, uxqa-r2-12). Two faults on Zones:
//
// 1. A walk-and-sit business was asked "Base price / visit" and "Each
//    additional dog" for every zone, numbers only a scooping plan is quoted
//    from (a walk or a sit is priced from its own service). Area pricing and
//    the first-cleanup fee were already hidden (PET_WASTE_MODULES); the
//    per-visit price was not.
// 2. A 4-ZIP zone was silently handed the ZIPs inside a default 1-mile
//    circle the map seeded around the first typed ZIP, and Save re-assigned
//    39 properties. A shape nobody drew now adds nothing: the drawer says
//    what the area holds and offers "Fill ZIPs from the area".
//
// Hiding only: a hidden price is saved back unchanged, and a zone that prices
// a yard some other way keeps showing it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { showsZoneVisitPrice } from "@/lib/service-lines";
import { isBaselineLookup } from "@/lib/zone-zip-fill";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("a zone's per-visit price", () => {
  it("is shown to a business that scoops", () => {
    expect(showsZoneVisitPrice(["pet_waste"], null)).toBe(true);
    expect(showsZoneVisitPrice(["pet_waste", "dog_walking"], { pricing_mode: "flat" })).toBe(true);
  });

  it("is hidden from one that does not, for a new or a flat zone", () => {
    expect(showsZoneVisitPrice(["dog_walking", "pet_sitting"], null)).toBe(false);
    expect(
      showsZoneVisitPrice(["training"], { pricing_mode: "flat", initial_cleanup_cents: 0 }),
    ).toBe(false);
  });

  it("stays while the zone prices a yard some other way", () => {
    expect(showsZoneVisitPrice(["dog_walking"], { pricing_mode: "per_sqft" })).toBe(true);
    expect(showsZoneVisitPrice(["dog_walking"], { initial_cleanup_cents: 4000 })).toBe(true);
  });

  it("the drawer and the card read it", () => {
    const drawer = read("src/components/ZoneDrawer.tsx");
    expect(drawer).toMatch(
      /const showVisitPricing = showsZoneVisitPrice\(lines, zone \?\? null\);/,
    );
    expect(drawer).toMatch(/\{showResidential && showVisitPricing && \(/);
    // Hidden, the loaded values still go back on save.
    // Blank is "no override" since #860, so it goes back as null.
    expect(drawer).toMatch(
      /basePriceCents: basePrice\.trim\(\) \? Math\.round\(\(parseFloat\(basePrice\) \|\| 0\) \* 100\) : null/,
    );
    const page = read("src/routes/_authenticated/settings.zones.tsx");
    expect(page).toMatch(/const showsVisitPrice = showsZoneVisitPrice\(lines, zone\);/);
    expect(page).toMatch(/\{showsVisitPrice &&/);
  });
});

describe("a shape nobody drew adds no ZIPs", () => {
  it("baseline for an existing zone's first shape and for a seeded circle", () => {
    expect(isBaselineLookup({ existingZoneFirstLookup: true, autoPlaced: false })).toBe(true);
    expect(isBaselineLookup({ existingZoneFirstLookup: false, autoPlaced: true })).toBe(true);
    expect(isBaselineLookup({ existingZoneFirstLookup: false, autoPlaced: false })).toBe(false);
  });

  it("the drawer marks the seeded circle and no longer matches on the key", () => {
    const drawer = read("src/components/ZoneDrawer.tsx");
    expect(drawer).not.toMatch(/baselinePending\.current && key === initialKey/);
    expect(drawer).toMatch(
      /autoPlacedPending\.current = true;\s*setFocusPoint\(\{ lat: res\.point\.latitude, lng: res\.point\.longitude \}\);/,
    );
    expect(drawer).toMatch(/autoPlaced: autoPlacedPending\.current,/);
    // A seeded circle keeps what the owner typed as typed.
    expect(drawer).toMatch(/if \(firstOfExisting\) next = baselineFill\(next, inside\)\.state;/);
  });
});
