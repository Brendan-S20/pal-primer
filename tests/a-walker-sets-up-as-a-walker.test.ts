// #768 and #769: first-run setup read as a scooping product to a dog walker,
// and never asked a walker the two things a walk is sold from.
//
//   #768  "Where your trucks start the day", a dump site as the whole of the
//         day-end step for a business that scoops AND walks, "pet waste zones
//         and walks", a yard outline and "Do NOT enter if dog is outside" for
//         a walk client, and a Business defaults blurb that named only the
//         pet-waste tools.
//   #769  the walk prices were a link to Settings (done when ANY walk had a
//         price), and the 08:00-17:00 workday was never shown.
//
// Behaviour where the code can be imported (the onboarding status, the
// wizard's steps, the hazards, the price and hours rules), source where it is
// a page that needs a browser. The browser half, at four widths, is
// tests/viewports/a-business-that-does-not-scoop.spec.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => builder, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { loadOnboardingStatus, type OnboardingStep } from "@/lib/onboarding.functions";
import {
  dayEndQuestion,
  newClientWizardSteps,
  runsPetWaste,
  serviceLineToolsBlurb,
  type ServiceLine,
} from "@/lib/service-lines";
import { propertyHazardsFor } from "@/lib/new-client-plan";
import {
  setupWalkFields,
  setupWalkPricesProblem,
  walkPriceCents,
  walksPricedForSetup,
} from "@/lib/setup-walk-prices";
import { workdayField, workdayProblem } from "@/lib/setup-workday";
import { DEFAULT_SERVICE_SEEDS } from "@/lib/services";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Comment lines out, so prose about a string cannot satisfy or defeat a
 *  test about the string. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

type Walk = { default_duration_min: number | null; base_price_cents: number | null };

/** The seeded walks, as signup leaves them: blank prices. */
const SEEDED_WALKS: Walk[] = DEFAULT_SERVICE_SEEDS.dog_walking.map((s) => ({
  default_duration_min: s.default_duration_min,
  base_price_cents: s.base_price_cents,
}));
const priced = (cents: Record<number, number | null>): Walk[] =>
  SEEDED_WALKS.map((w) => ({ ...w, base_price_cents: cents[w.default_duration_min!] ?? null }));

function context(lines: ServiceLine[], walks: Walk[], counts: Record<string, number> = {}) {
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      const eqs: Record<string, unknown> = {};
      for (const m of ["gt", "not"]) q[m] = () => q;
      q.eq = (k: string, v: unknown) => {
        eqs[k] = v;
        return q;
      };
      q.select = (c: string) => {
        cols = c;
        return q;
      };
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: "org-a" } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: lines } };
          return { data: { contact_address: "1 Main St" } };
        }
        if (table === "services" && eqs.service_line === "dog_walking") {
          // The done test has to read the walk's LENGTH to know which walk
          // is which; a select without it would see every walk as optional.
          expect(cols).toMatch(/default_duration_min/);
          return { data: walks };
        }
        return { count: counts[table] ?? 0 };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
  return { supabase, userId: "owner" } as never;
}

async function steps(lines: ServiceLine[], walks: Walk[] = SEEDED_WALKS, counts = {}) {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[] }>;
  return (await load(context(lines, walks, counts))).steps;
}
const step = (all: OnboardingStep[], id: string) => all.find((s) => s.id === id)!;
const words = (s: OnboardingStep) =>
  [
    s.label,
    s.description,
    s.cta,
    ...(s.parts ?? []).flatMap((p) => [p.label, p.description, p.cta]),
  ].join(" ");

const WALKER: ServiceLine[] = ["dog_walking"];
const SCOOPER: ServiceLine[] = ["pet_waste"];
const MIXED: ServiceLine[] = ["pet_waste", "dog_walking"];
const SCOOP_WORDS = /\btrucks?\b|dump|crew unloads|yard|zones/i;

// ── #768 ──────────────────────────────────────────────────────────────────

describe("#768 a walker-only business never reads scooping words in setup", () => {
  it("no step it is shown says trucks, dump site, crew unloads, yard or zones", async () => {
    for (const s of await steps(WALKER)) {
      if (s.id === "zones") {
        // "Your service area is on Zones" names a page, not a product.
        expect(words(s).replace(/Your service area is on Zones\./, "")).not.toMatch(SCOOP_WORDS);
      } else {
        expect(words(s), s.id).not.toMatch(SCOOP_WORDS);
      }
    }
  });

  it("the day-end step is 'Where does your day end?', the DayEndPanel path", async () => {
    const s = step(await steps(WALKER), "dump_site");
    expect(s.label).toBe("Where does your day end?");
    expect(s.cta).toBe("Set day's end");
    expect(dayEndQuestion(WALKER)).toBe("day_end");
  });

  it("the new-client wizard has no Outline step, whatever the plan", () => {
    for (const line of [null, "dog_walking", "pet_waste"] as const) {
      expect(newClientWizardSteps(runsPetWaste(WALKER), line)).not.toContain("Outline");
    }
  });

  it("is not asked 'Do NOT enter if dog is outside', a yard's hazard", () => {
    const labels = propertyHazardsFor(WALKER).map((h) => h.label);
    expect(labels).not.toContain("Do NOT enter if dog is outside");
    expect(labels).toContain("Aggressive dog");
    // One already ticked on a client stays visible, so nothing is lost.
    expect(propertyHazardsFor(WALKER, { doNotEnterIfDogOut: true }).map((h) => h.key)).toContain(
      "doNotEnterIfDogOut",
    );
  });

  it("step 1's address help says routes, not trucks", () => {
    const page = codeOnly(read("src/routes/_authenticated/setup.tsx"));
    expect(page).not.toMatch(/trucks/i);
    expect(page).toMatch(/Where routes start each day/);
  });
});

describe("#768 a scoop-only business keeps the dump site and the Outline (no regression)", () => {
  it("the day-end step asks for the dump site", async () => {
    const s = step(await steps(SCOOPER), "dump_site");
    expect(s.label).toBe("Where the day ends");
    expect(s.cta).toBe("Add dump site");
    expect(s.description).toMatch(/crew unloads/);
    expect(dayEndQuestion(SCOOPER)).toBe("dump_site");
  });

  it("the wizard has the Outline step and every yard hazard", () => {
    expect([...newClientWizardSteps(true)]).toEqual([
      "Contact",
      "Property",
      "Outline",
      "Dogs",
      "Plan",
    ]);
    expect([...newClientWizardSteps(true, "pet_waste")]).toContain("Outline");
    expect(propertyHazardsFor(SCOOPER).map((h) => h.key)).toEqual([
      "doNotEnterIfDogOut",
      "aggressiveDog",
      "escapeRisk",
      "invisibleFence",
      "dogInYardDuringService",
      "beesWasps",
      "sharpObjects",
      "slipperySurfaces",
    ]);
  });
});

describe("#768 a business that scoops AND walks", () => {
  it("the day-end step is worded for everybody, and offers the dump site as the pet-waste half", async () => {
    const s = step(await steps(MIXED), "dump_site");
    expect(dayEndQuestion(MIXED)).toBe("both");
    expect(s.label).toBe("Where does your day end?");
    expect(s.cta).toBe("Set day's end");
    expect(s.description).not.toMatch(/crew unloads|trucks/i);
    expect(s.description).toMatch(/Pet waste routes can end at a dump site/);
  });

  it("/setup draws the day-end form, with the dump site under 'For your pet waste routes'", () => {
    const page = codeOnly(read("src/routes/_authenticated/setup.tsx"));
    const panel = page.slice(
      page.indexOf("function EndOfDayPanel("),
      page.indexOf("function DumpSitePanel("),
    );
    const dayEndAt = panel.lastIndexOf("<DayEndPanel");
    const petWasteAt = panel.indexOf("For your pet waste routes");
    const dumpAt = panel.lastIndexOf("<DumpSitePanel");
    expect(dayEndAt).toBeGreaterThan(-1);
    expect(petWasteAt).toBeGreaterThan(dayEndAt);
    expect(dumpAt).toBeGreaterThan(petWasteAt);
  });

  it("the price step names what a client buys, not 'pet waste zones'", async () => {
    const s = step(await steps(MIXED), "zones");
    expect(s.description).toBe(
      "You run 2 services. Set a price for each: pet waste visits and walks. New clients are quoted these prices.",
    );
    expect(s.parts?.map((p) => p.id)).toEqual(["area", "walks"]);
    const walks = s.parts!.find((p) => p.id === "walks")!;
    expect(`${walks.label} ${walks.description}`).not.toMatch(SCOOP_WORDS);
  });

  it("the Outline step is there for a pet-waste client and gone for a walk client", () => {
    expect(newClientWizardSteps(true, "pet_waste")).toContain("Outline");
    expect(newClientWizardSteps(true, null)).toContain("Outline");
    expect([...newClientWizardSteps(true, "dog_walking")]).toEqual([
      "Contact",
      "Property",
      "Dogs",
      "Plan",
    ]);
  });

  it("the yard's hazards are asked for a pet-waste client only", () => {
    const keys = (line: ServiceLine | null) =>
      propertyHazardsFor(MIXED, {}, line).map((h) => h.key);
    expect(keys("pet_waste")).toContain("doNotEnterIfDogOut");
    expect(keys("pet_waste")).toContain("beesWasps");
    expect(keys("dog_walking")).not.toContain("doNotEnterIfDogOut");
    expect(keys("dog_walking")).not.toContain("beesWasps");
  });

  it("the new-client wizard decides the steps from the plan's line, and asks it before Outline", () => {
    const page = codeOnly(read("src/routes/_authenticated/clients.new.tsx"));
    expect(page).toMatch(/const planLine = chosenService\?\.service_line \?\? null/);
    expect(page).toMatch(/newClientWizardSteps\(petWaste, planLine\)/);
    expect(page).toMatch(/propertyHazardsFor\(lines, hz, planLine\)/);
    // The early picker is drawn on the Property step, which comes before
    // Outline, and only for a business that scoops and sells something else.
    const property = page.slice(page.indexOf('current === "Property" && ('));
    expect(property.slice(0, 600)).toMatch(/asksServiceEarly && \(/);
    expect(page).toMatch(
      /asksServiceEarly =\s*linesKnown && petWaste && offersServicePicker && lines\.some\(\(l\) => l !== "pet_waste"\)/,
    );
    // Staying on the same step, by name, when the list changes under them.
    expect(page).toMatch(/const now = steps\.indexOf\(was\)/);
  });

  it("the client's property drawer offers the same hazards by the same rule", () => {
    const drawer = codeOnly(read("src/components/client-detail/PropertyDrawer.tsx"));
    expect(drawer).toMatch(/propertyHazardsFor\(serviceLines, form\)/);
    expect(drawer).not.toMatch(/HAZARD_FIELDS/);
  });
});

describe("#768 Settings → Business defaults names the tools of the lines turned on", () => {
  it("a walker reads walk tools and nothing about dump sites or yards", () => {
    const blurb = serviceLineToolsBlurb(WALKER);
    expect(blurb).toMatch(/Dog walking turns on walk prices/);
    expect(blurb).not.toMatch(/dump|yard|waste/i);
  });

  it("a scooper reads the pet-waste tools, as before", () => {
    expect(serviceLineToolsBlurb(SCOOPER)).toBe(
      "Pet waste removal turns on the waste log, dump sites, yard outlines, first cleanups and deep cleans.",
    );
  });

  it("a mixed business reads each line's tools, pet waste first", () => {
    const blurb = serviceLineToolsBlurb(["dog_walking", "pet_waste"]);
    expect(blurb.indexOf("Pet waste removal")).toBe(0);
    expect(blurb).toMatch(/Dog walking turns on/);
  });

  it("the card draws the blurb from the lines, not a fixed sentence", () => {
    const page = codeOnly(read("src/routes/_authenticated/settings.business.tsx"));
    expect(page).toMatch(/\{serviceLineToolsBlurb\(lines\)\}/);
    expect(page).not.toMatch(/Pet waste removal turns on the waste/);
  });
});

// ── #769 ──────────────────────────────────────────────────────────────────

describe("#769 the walks are priced in setup, and both lengths have to be", () => {
  it("signup's seeded walks are a 30, a 60 and a drop-in, all unpriced", () => {
    expect(SEEDED_WALKS.map((w) => w.default_duration_min)).toEqual([30, 60, 20]);
    expect(walksPricedForSetup(SEEDED_WALKS)).toBe(false);
  });

  it("one priced walk is NOT done: the old test ticked the step for this", () => {
    expect(walksPricedForSetup(priced({ 30: 2500 }))).toBe(false);
    expect(walksPricedForSetup(priced({ 60: 4000 }))).toBe(false);
    expect(walksPricedForSetup(priced({ 20: 1800 }))).toBe(false);
  });

  it("the 30- and 60-minute walk priced is done; the drop-in is optional", () => {
    expect(walksPricedForSetup(priced({ 30: 2500, 60: 4000 }))).toBe(true);
    expect(walksPricedForSetup(priced({ 30: 2500, 60: 4000, 20: 1800 }))).toBe(true);
  });

  it("a length the business stopped selling is not demanded", () => {
    const no60 = SEEDED_WALKS.filter((w) => w.default_duration_min !== 60).map((w) => ({
      ...w,
      base_price_cents: w.default_duration_min === 30 ? 2500 : null,
    }));
    expect(walksPricedForSetup(no60)).toBe(true);
  });

  for (const lines of [WALKER, MIXED]) {
    it(`{${lines.join(",")}}: the price step stays open until both walks are priced`, async () => {
      const counts = { zones: 1 };
      const open = step(await steps(lines, priced({ 30: 2500 }), counts), "zones");
      expect(open.done).toBe(false);
      const done = step(await steps(lines, priced({ 30: 2500, 60: 4000 }), counts), "zones");
      expect(done.done).toBe(true);
    });
  }

  it("a walker's price step is on /setup, not a link out to Settings", async () => {
    const s = step(await steps(WALKER), "zones");
    expect(s.to).toBe("/setup");
    expect(s.label).toBe("Price your walks");
    expect(s.description).toMatch(/a drop-in if you offer one/);
  });

  it("/setup draws the walk price form for a walker and as the walks part, with no Settings button", () => {
    const page = codeOnly(read("src/routes/_authenticated/setup.tsx"));
    const pricing = page.slice(
      page.indexOf("function PricingPanel("),
      page.indexOf("function BusinessPanel("),
    );
    expect(pricing).toMatch(/return <WalkPricesForm done=\{step\.done\} onSaved=\{onSaved\} \/>/);
    const prices = page.slice(
      page.indexOf("function PricesPanel("),
      page.indexOf("function ServiceAreaPanel("),
    );
    expect(prices).toMatch(/part\.id !== "area" && part\.id !== "walks" && \(/);
    expect(prices).toMatch(/<WalkPricesForm/);
  });

  it("the form writes the same services Settings → Services and the plan picker read", () => {
    const form = codeOnly(read("src/components/SetupWalkPrices.tsx"));
    expect(form).toMatch(/useOrgServices\(\)/);
    expect(form).toMatch(/useMutation\(\s*stepSave\(/);
    expect(form).toMatch(/refresh: \[\["services"\], \["onboarding-status"\]\]/);
    const server = codeOnly(read("src/lib/setup-walk-prices.functions.ts"));
    expect(server).toMatch(/requirePermission\([^)]*"manage_pricing"\)/);
    expect(server).toMatch(/\.update\(\{ base_price_cents: p\.cents \}\)/);
    expect(server).toMatch(/\.eq\("organization_id", orgId\)/);
    expect(server).toMatch(/\.eq\("service_line", "dog_walking"\)/);
  });

  it("the form puts the required walks first and marks the drop-in optional", () => {
    const walks = DEFAULT_SERVICE_SEEDS.dog_walking.map((s, i) => ({
      id: `w${i}`,
      name: s.name,
      default_duration_min: s.default_duration_min,
      base_price_cents: null,
    }));
    expect(setupWalkFields([...walks].reverse()).map((f) => [f.walk.name, f.required])).toEqual([
      ["30-minute walk", true],
      ["60-minute walk", true],
      ["Drop-in visit (20 min)", false],
    ]);
  });

  it("refuses a missing required price and nonsense, and lets the drop-in be blank", () => {
    expect(walkPriceCents("25")).toBe(2500);
    expect(walkPriceCents("$25.50")).toBe(2550);
    expect(walkPriceCents("")).toBeNull();
    expect(walkPriceCents("abc")).toBeNaN();
    expect(walkPriceCents("0")).toBeNaN();
    const f = (required: boolean, cents: number | null) => ({
      name: "30-minute walk",
      required,
      cents,
    });
    expect(setupWalkPricesProblem([f(true, null)])).toBe("Enter what a 30-minute walk costs.");
    expect(setupWalkPricesProblem([f(false, Number.NaN)])).toMatch(/Enter a price/);
    expect(setupWalkPricesProblem([f(true, 2500), f(false, null)])).toBeNull();
  });
});

describe("#769 setup shows and saves the workday", () => {
  it("starts from what is stored, the 08:00-17:00 default for a new business", () => {
    expect(workdayField("07:30:00", "08:00")).toBe("07:30");
    expect(workdayField(null, "08:00")).toBe("08:00");
    expect(workdayField(undefined, "17:00")).toBe("17:00");
  });

  it("refuses a day that ends before it starts", () => {
    expect(workdayProblem("08:00", "17:00")).toBeNull();
    expect(workdayProblem("17:00", "08:00")).toMatch(/end after it starts/);
    expect(workdayProblem("", "17:00")).toMatch(/starts and ends/);
  });

  it("step 1 draws both fields and saves them with the step, every time", () => {
    const page = codeOnly(read("src/routes/_authenticated/setup.tsx"));
    const business = page.slice(
      page.indexOf("function BusinessPanel("),
      page.indexOf("const MILES ="),
    );
    expect(business).toMatch(/id="setup-workday-start"/);
    expect(business).toMatch(/id="setup-workday-end"/);
    expect(business).toMatch(
      /await saveDispatchFn\(\{\s*data: \{[\s\S]*?workday_start: dayStartVal,\s*workday_end: dayEndVal,/,
    );
    expect(business).toMatch(/workdayProblem\(dayStartVal, dayEndVal\)/);
  });
});
