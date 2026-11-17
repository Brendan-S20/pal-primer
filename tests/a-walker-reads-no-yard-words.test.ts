import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boundaryCopy } from "@/lib/property-boundary-copy";
import { propertyHazardsFor } from "@/lib/new-client-plan";
import { ROUTE_END_BLANK_HINT } from "@/lib/route-endpoints";

/**
 * #768, the walker-only half, in seconds and with no browser. The browser half
 * is tests/viewports/a-business-that-does-not-scoop.wording.spec.ts, which
 * renders every surface and reads what it draws; this pins the pieces that
 * decide the words, so the next copy edit fails here first.
 */

const SCOOPER_WORDS = /\btrucks?\b|\bdump\b|landfill|\byards?\b|scoop|unload|crew/i;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("a property's boundary, worded by what the business runs", () => {
  it("a business that does not scoop reads no yard words", () => {
    for (const [field, text] of Object.entries(boundaryCopy(false))) {
      expect(text, field).not.toMatch(SCOOPER_WORDS);
    }
  });

  it("a pet-waste business keeps the wording it had", () => {
    const c = boundaryCopy(true);
    expect(c.sizeLabel).toBe("Yard size");
    expect(c.areaNoun).toBe("yard");
    expect(c.emptyHint).toBe("Yard size and estimated time come from the boundary.");
    expect(c.accessNotesPlaceholder).toBe("How to get into the yard, e.g. side gate on the left");
  });
});

describe("a yard hazard already ticked, off a pet-waste path", () => {
  const ticked = { doNotEnterIfDogOut: true, dogInYardDuringService: true } as const;

  it("is still shown, in words without a yard in them", () => {
    const hz = propertyHazardsFor(["dog_walking"], ticked);
    expect(hz.map((h) => h.key)).toEqual(
      expect.arrayContaining(["doNotEnterIfDogOut", "dogInYardDuringService"]),
    );
    for (const h of hz) expect(h.label, h.key).not.toMatch(SCOOPER_WORDS);
    // A walk client of a business that also scoops (#768): the plan's line.
    for (const h of propertyHazardsFor(["pet_waste", "dog_walking"], ticked, "dog_walking")) {
      expect(h.label, h.key).not.toMatch(/\byard\b|outside/i);
    }
  });

  it("keeps the yard wording for a business that scoops", () => {
    const labels = propertyHazardsFor(["pet_waste"], ticked).map((h) => h.label);
    expect(labels).toContain("Dog in yard during service");
    expect(labels).toContain("Do NOT enter if dog is outside");
  });
});

describe("copy every business reads is not a scooper's", () => {
  it("Settings → Business says routes, as setup step 1 does", () => {
    const src = read("src/components/settings/BusinessDetailsCards.tsx");
    expect(src).not.toMatch(/Where your trucks start the day/);
    expect(src).toMatch(/Where routes start each day, unless someone has a start address/);
  });

  it("Settings → Users offers a dump site only to a pet-waste business", () => {
    const src = read("src/routes/_authenticated/settings.users.tsx");
    expect(src).toMatch(/<RouteEndLabelText \/>/);
    expect(src).toMatch(/useRouteEndPlaceholder\("Landfill or home address"\)/);
    expect(src).toMatch(/placeholder=\{endPlaceholder\}/);
    const label = read("src/components/settings/RouteEndLabel.tsx");
    expect(label).toMatch(
      /petWaste \? "Route end \(dump, home, shop\)" : "Route end \(home or shop\)"/,
    );
    expect(label).toMatch(/petWaste \? petWastePlaceholder : ROUTE_END_BLANK_HINT/);
    expect(src).not.toMatch(/also runs a truck/);
  });

  it("the board's routing dialog tells a non-scooper what an empty end does", () => {
    const src = read("src/components/routes/StaffRoutingDialog.tsx");
    expect(src).toMatch(/useRouteEndPlaceholder\("Dump, home, or shop"\)/);
    expect(src).toMatch(/placeholder=\{endPlaceholder\}/);
  });

  it("an empty route end with no dump site ends at the last visit, and says so", () => {
    // staff_end_point: own end, then the nearest dump site, then nothing;
    // route-inputs.ts adds an end node only when one came back.
    expect(ROUTE_END_BLANK_HINT).toBe("Leave blank to end at the last visit");
    expect(ROUTE_END_BLANK_HINT).not.toMatch(SCOOPER_WORDS);
    const inputs = read("src/lib/route-inputs.ts");
    expect(inputs).toMatch(/let end = located\(t\.end_lat, t\.end_lon\);/);
    expect(inputs).toMatch(/if \(t\.end\) \{\n\s+e = nodeCoords\.length;/);
  });

  it("Edit client's lead-source example is not a truck wrap", () => {
    expect(read("src/components/client-detail/EditClientDrawer.tsx")).not.toMatch(/truck wrap/);
  });
});
