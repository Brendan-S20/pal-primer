// A subscription's zone sets its price. Two paths let the two come apart.
//
// ── 1. PRICED FROM THE PROPERTY'S ZONE, SAVED WITH NONE ───────────────────
//
// The service drawer computed its price preview from
// `form.zoneId || selectedProperty?.zone_id`, and saved
// `zoneId: form.zoneId || undefined`. Two different expressions for one
// question.
//
// For a client with more than one property those disagree on every new
// service. `blankSubscriptionFormValues` prefills the zone only when there is
// exactly one property to prefill it FROM, so the field starts empty; the user
// picks a property; the preview correctly falls back to that property's zone
// and prices the visit from it; and the row is written with no zone at all.
// The price is right on the day and nothing can ever re-derive it — which is
// the shape live data showed: one subscription with a null zone whose property
// has one.
//
// ── 2. MOVED TO ANOTHER PROPERTY, KEEPING THE FIRST ONE'S ZONE ────────────
//
// The property `onChange` refilled `dogCount` from the new property's records
// and did not touch `zoneId`. So editing a service and moving it to another
// address left the OLD address's zone in the form — and because that value is
// truthy, the fallback above never engaged, so the stale zone both priced the
// visit and was written to the row. Zero live instances, because the drift
// needs someone to move a service between properties; it is the worse of the
// two, since a wrong zone is harder to spot than a missing one.
//
// ── WHY THERE IS ALSO A WARNING ───────────────────────────────────────────
//
// Both fixes are at the source and neither reaches a row that already drifted.
// The mismatch chip mirrors the dog-count one that has been on this tab since
// QA round 1.5 — same question, about the field that sets the price rather
// than the field that sets the dog count.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { blankSubscriptionFormValues } from "../src/lib/subscription-form";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const src = () => codeOnly(read("src/components/client-detail/ServicesTab.tsx"));

describe("the price and the saved zone come from one expression", () => {
  it("derives the effective zone once", () => {
    expect(src()).toMatch(
      /const effectiveZoneId = form\.zoneId \|\| selectedProperty\?\.zone_id \|\| ""/,
    );
  });

  it("prices from it", () => {
    expect(src()).toMatch(/zones\.find\(\(z: any\) => z\.id === effectiveZoneId\)/);
  });

  it("saves the same one, which is the half that was wrong", () => {
    // `zoneId: form.zoneId || undefined` is the original. It priced from the
    // property's zone and then recorded nothing.
    expect(src()).toMatch(/zoneId: effectiveZoneId \|\| undefined/);
    expect(src()).not.toMatch(/zoneId: form\.zoneId \|\| undefined/);
  });

  it("uses zone_id rather than auto_zone_id", () => {
    // properties.functions.ts: "auto_zone_id is what the matcher detected;
    // zone_id is what actually applies". An override exists precisely because
    // the detected zone was wrong, so pricing from it would ignore the
    // correction someone made on purpose.
    expect(src()).not.toMatch(/selectedProperty\?\.auto_zone_id/);
  });
});

describe("switching property brings its zone with it", () => {
  it("refills the zone the way it already refilled the dog count", () => {
    const onChange = src().slice(src().indexOf("const pid = e.target.value;"));
    const block = onChange.slice(0, onChange.indexOf("</select>"));
    expect(block).toMatch(/zoneId: \(next\?\.zone_id as string \| null \| undefined\) \?\? ""/);
    // The line it sat next to all along.
    expect(block).toMatch(/dogCount: String\(n\)/);
  });

  it("clears rather than keeps when the new property has no zone", () => {
    // Carrying the previous address's zone across is the bug itself, so an
    // absent zone must win over a stale one.
    const onChange = src().slice(src().indexOf("const pid = e.target.value;"));
    expect(onChange.slice(0, onChange.indexOf("</select>"))).toMatch(/\?\? ""/);
  });
});

describe("the blank form still prefills what it can", () => {
  it("takes the zone from a lone property", () => {
    const v = blankSubscriptionFormValues({
      properties: [{ id: "p1", zone_id: "z1" }],
    });
    expect(v.propertyId).toBe("p1");
    expect(v.zoneId).toBe("z1");
  });

  it("leaves both empty when there is a choice to make", () => {
    // Not a bug, and the reason the fallback and the onChange both matter:
    // there is no property selected yet, so there is no zone to prefill from.
    const v = blankSubscriptionFormValues({
      properties: [
        { id: "p1", zone_id: "z1" },
        { id: "p2", zone_id: "z2" },
      ],
    });
    expect(v.propertyId).toBe("");
    expect(v.zoneId).toBe("");
  });

  it("leaves the zone empty for a lone property that has none", () => {
    const v = blankSubscriptionFormValues({ properties: [{ id: "p1", zone_id: null }] });
    expect(v.zoneId).toBe("");
  });
});

describe("a row that drifted before the fix says so", () => {
  it("compares the service's zone against its property's", () => {
    expect(src()).toMatch(/const zoneMismatch = !!propertyZoneId && s\.zone_id !== propertyZoneId/);
  });

  it("says nothing when the property has no zone to compare against", () => {
    // Without the `!!propertyZoneId` guard every service on an unzoned
    // property raises a warning naming a zone that does not exist.
    expect(src()).toMatch(/!!propertyZoneId &&/);
  });

  it("distinguishes a missing zone from a different one", () => {
    // These need different sentences: one is "we never recorded it", the other
    // is "we recorded the wrong one".
    expect(src()).toMatch(/No pricing zone recorded, but this property is in/);
    expect(src()).toMatch(/Priced from a different zone than this property's/);
  });

  it("offers the fix behind the pricing permission, like the dog-count chip", () => {
    const chip = src().slice(src().indexOf("zoneMismatch && ("));
    expect(chip.slice(0, 1200)).toMatch(/canManagePricing &&/);
    expect(chip.slice(0, 1200)).toMatch(/syncZoneMut\.mutate\(\{ sub: s, zoneId: propertyZoneId \}\)/);
  });

  it("does not re-price the service as a side effect of correcting its zone", () => {
    // The zone EXPLAINS a price rather than silently setting one. Re-pricing
    // here would change what a customer is billed as a consequence of fixing a
    // record, which nobody asked for.
    const mut = src().slice(src().indexOf("const syncZoneMut"));
    expect(mut.slice(0, 900)).toMatch(/priceCents: v\.sub\.price_cents/);
    expect(src()).toMatch(/The price is unchanged/);
  });

  it("gives the chip's button a touch target", () => {
    const chip = src().slice(src().indexOf("zoneMismatch && ("));
    expect(chip.slice(0, 1200)).toMatch(/touch:min-h-11/);
  });
});
