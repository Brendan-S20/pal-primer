// F-06 (round-2 audit, RC3): every new business is created holding
// service_lines = {pet_waste} (the column default), and setup's first step
// showed that ticked. A groomer, a trainer and a sitter each saved it without
// reading, and the waste tools, copy and seeded service followed them round
// the product. Also: the client wizard asked a walker about bees and sharp
// objects, and the portal card called its one-off price "an extra pet waste
// visit" to a trainer.
//
// Not changed, on purpose: the column default and serviceLinesOrDefault's
// fail-open. An answer that cannot be read is still pet waste (CLAUDE.md,
// "A pet-waste page is signposted only to a pet-waste business"); setup asks
// only when the answer WAS read and is still the untouched default.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SERVICE_LINES,
  portalExtraVisitPriceLabel,
  serviceLinesOrDefault,
  setupAsksServiceLines,
} from "@/lib/service-lines";
import { PROPERTY_HAZARDS, propertyHazardsFor } from "@/lib/new-client-plan";
import {
  preselectedServiceLines,
  requestedServiceLine,
  setupStartingLines,
} from "@/lib/signup-service";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("setup asks what a new business runs", () => {
  it("starts with nothing ticked while the step is open and the answer is the default", () => {
    expect(setupAsksServiceLines(["pet_waste"], true, false)).toBe(true);
  });

  it("shows what is stored once the step is done, pet waste included", () => {
    expect(setupAsksServiceLines(["pet_waste"], true, true)).toBe(false);
  });

  it("shows a real answer as it is", () => {
    expect(setupAsksServiceLines(["mobile_grooming"], true, false)).toBe(false);
    expect(setupAsksServiceLines(["pet_waste", "dog_walking"], true, false)).toBe(false);
  });

  it("does not ask on an answer it has not read", () => {
    expect(setupAsksServiceLines(["pet_waste"], false, false)).toBe(false);
  });

  it("leaves the fail-open default alone", () => {
    expect(DEFAULT_SERVICE_LINES).toEqual(["pet_waste"]);
    expect(serviceLinesOrDefault(null)).toEqual(["pet_waste"]);
  });

  it("the first step starts empty, refuses an empty answer, and writes only a change", () => {
    const setup = read("src/routes/_authenticated/setup.tsx");
    expect(setup).toMatch(
      /unanswered: setupAsksServiceLines\(savedLines, linesKnown, alreadyDone\)/,
    );
    expect(setup).toMatch(
      /preselected: preselectedServiceLines\(savedLines, requestedLine, availability\)/,
    );
    expect(setup).toMatch(/const linesVal = lines \?\? startingLines;/);
    expect(setup).toMatch(
      /if \(linesVal\.length === 0\) \{\s*toast\.error\("Choose the services you offer\."\)/,
    );
    expect(setup).toMatch(/if \(linesChanged\) await saveLinesFn/);
  });
});

describe("setup step 1 with a ?service= request (#710) and without", () => {
  const avail = {
    bookable: ["pet_waste", "training", "dog_walking"],
    customerRequestable: [],
  } as never;
  const start = (requested: Parameters<typeof requestedServiceLine>[0], unanswered = true) => {
    const r = requestedServiceLine(requested);
    return setupStartingLines({
      unanswered,
      saved: ["pet_waste"],
      requested: r,
      preselected: preselectedServiceLines(["pet_waste"], r, avail),
    });
  };

  it("a valid request ticks that line alone", () => {
    expect(start("training")).toEqual(["training"]);
    expect(start("dog-walking")).toEqual(["dog_walking"]);
    expect(start("pet_waste")).toEqual(["pet_waste"]);
  });

  it("no request, an unknown one or a Coming soon one ticks nothing", () => {
    expect(start(undefined)).toEqual([]);
    expect(start("llama_grooming")).toEqual([]);
    expect(start("pet_sitting")).toEqual([]);
  });

  it("availability not loaded yet ticks nothing rather than pet waste", () => {
    const r = requestedServiceLine("training");
    expect(
      setupStartingLines({
        unanswered: true,
        saved: ["pet_waste"],
        requested: r,
        preselected: preselectedServiceLines(["pet_waste"], r, null),
      }),
    ).toEqual([]);
  });

  it("an answered business keeps #710's rules", () => {
    expect(
      setupStartingLines({
        unanswered: false,
        saved: ["mobile_grooming"],
        requested: "training",
        preselected: ["mobile_grooming"],
      }),
    ).toEqual(["mobile_grooming"]);
  });

  it("#711's draft keeps only what was touched, so a restore wins over the start", () => {
    const setup = read("src/routes/_authenticated/setup.tsx");
    // #769 added the workday and D14 the office email and the portal address,
    // all under the same null-means-untouched rule.
    expect(setup).toMatch(
      /value: \{ lines, name, phone, address, tz, dayStart, dayEnd, officeEmail, portalSlug \}/,
    );
    expect(setup).toMatch(/setLines\(d\.lines\)/);
  });
});

describe("the client wizard asks about a yard only of a business that scoops", () => {
  const keys = (lines: Parameters<typeof propertyHazardsFor>[0], ticked = {}) =>
    propertyHazardsFor(lines, ticked).map((h) => h.key);

  it("a scooping business is asked every hazard, as before", () => {
    expect(keys(["pet_waste"])).toEqual(PROPERTY_HAZARDS.map(([k]) => k));
  });

  it("a walker or a groomer is not asked about bees, sharp objects or the dog in the yard", () => {
    for (const lines of [["dog_walking"], ["mobile_grooming", "training"]] as const) {
      const k = keys([...lines]);
      expect(k).not.toContain("beesWasps");
      expect(k).not.toContain("sharpObjects");
      expect(k).not.toContain("dogInYardDuringService");
      expect(k).toContain("aggressiveDog");
      expect(k).toContain("escapeRisk");
    }
  });

  it("a ticked hazard is never hidden", () => {
    expect(keys(["dog_walking"], { beesWasps: true })).toContain("beesWasps");
  });

  it("the wizard draws the list from it", () => {
    const wizard = read("src/routes/_authenticated/clients.new.tsx");
    // #768: and from the plan's line, so a walk client of a business that
    // also scoops is not asked about the yard.
    expect(wizard).toMatch(/propertyHazardsFor\(lines, hz, planLine\)\.map/);
    expect(wizard).not.toMatch(/\["beesWasps", "Bees \/ wasps"\]/);
  });
});

describe("the portal's one-off price names pet waste only beside other lines", () => {
  it("reads", () => {
    expect(portalExtraVisitPriceLabel(["pet_waste"])).toBe("Price of an extra visit");
    expect(portalExtraVisitPriceLabel(["pet_waste", "dog_walking"])).toBe(
      "Price of an extra pet waste visit",
    );
    expect(portalExtraVisitPriceLabel(["training"])).toBe("Price of an extra visit");
    expect(portalExtraVisitPriceLabel(["dog_walking", "pet_sitting"])).toBe(
      "Price of an extra visit",
    );
  });

  it("the card uses it", () => {
    const card = read("src/components/settings/PortalBookingCard.tsx");
    expect(card).toMatch(/portalExtraVisitPriceLabel\(lines\)/);
    expect(card).not.toMatch(/otherServices \? "Price of an extra pet waste visit"/);
  });
});
