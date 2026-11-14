// Service lines, step 1: a business says what it runs, and a business that
// does not run pet waste stops being shown the pet-waste modules.
//
// What this file holds, and why each part is here rather than trusted:
//
//   * THE GATING TABLE, as behaviour: for a set of lines, which nav entries,
//     which tech tab, which wizard steps. Imported and called, not grepped,
//     where the module can be imported without a browser.
//   * FAIL-OPEN: every way the answer can be missing reads as pet waste,
//     because every business on the platform today is one.
//   * SEEDS: pet_waste produces exactly today's values, byte for byte, so
//     introducing lines changed nothing for anybody already here.
//   * HIDING ONLY: nothing on the server refuses a write because of lines.
//   * THE RULE: every signpost to a pet-waste page (PET_WASTE_ROUTES) carries
//     `petWasteOnly`. That is the part a future nav entry can break, and the
//     part CLAUDE.md and the Lovable knowledge carry.
//
// The database half -- the CHECK, the default, who can write it -- is
// tests/a-dog-walker-should-not-have-to-learn-about-dump-sites-in-a-real-database.test.ts.

import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  useServerFn: (f: unknown) => f,
  createServerFn: () => {
    const chain: any = () => chain;
    chain.validator = () => chain;
    chain.inputValidator = () => chain;
    chain.middleware = () => chain;
    chain.handler = () => chain;
    return chain;
  },
  createMiddleware: () => {
    const chain: any = {};
    chain.server = () => chain;
    chain.client = () => chain;
    chain.middleware = () => chain;
    return chain;
  },
}));

import {
  GROOMING_COMING_SOON,
  LAUNCH_DEFAULT,
  TRAINING_COMING_SOON,
} from "./support/service-line-availability";
import {
  DEFAULT_SERVICE_LINES,
  LINE_SEEDS,
  OFFERED_SERVICE_LINES,
  PET_WASTE_MODULES,
  PET_WASTE_ROUTES,
  SERVICE_LINES,
  addOnExampleFor,
  customerCanRequestService,
  newClientWizardSteps,
  runsPetWaste,
  serviceLinesAdditionProblem,
  serviceLinesOrDefault,
  serviceLinesProblem,
  suggestedChecklistFor,
  toggledServiceLines,
  type ServiceLine,
} from "@/lib/service-lines";
import { SUGGESTED_CHECKLIST } from "@/lib/visit-checklist";
import { DEFAULT_EST_TIME_CONFIG } from "@/lib/estimated-time";
import { NAV_GROUPS, isNavItemVisible, type NavVisibility } from "@/components/AppSidebar";
import { techSecondTab, techTabUrls } from "@/components/MobileTabBar";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION =
  "supabase/migrations/20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql";

/** Comment lines stripped, so prose describing a pattern cannot satisfy or
 *  defeat an assertion about code. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
    })
    .join("\n");

const navItem = (url: string) => {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.url === url);
  if (!item) throw new Error(`no nav entry for ${url}`);
  return item;
};

const vis = (lines: ServiceLine[], commercial = true): NavVisibility => ({
  commercialEnabled: commercial,
  franchiseParent: false,
  texting: false,
  petWaste: runsPetWaste(lines),
  training: lines.includes("training"),
});

// ── The gating table ──────────────────────────────────────────────────────
const CASES: Array<{
  lines: ServiceLine[];
  wasteLog: boolean;
  dna: boolean;
  secondTab: string;
  wizard: string[];
}> = [
  {
    lines: ["pet_waste"],
    wasteLog: true,
    dna: true,
    secondTab: "/waste-log",
    wizard: ["Contact", "Property", "Outline", "Dogs", "Plan"],
  },
  {
    lines: ["pet_waste", "dog_walking"],
    wasteLog: true,
    dna: true,
    secondTab: "/waste-log",
    wizard: ["Contact", "Property", "Outline", "Dogs", "Plan"],
  },
  {
    lines: ["dog_walking"],
    wasteLog: false,
    dna: false,
    secondTab: "/my-schedule",
    wizard: ["Contact", "Property", "Dogs", "Plan"],
  },
  {
    lines: ["pet_sitting", "mobile_grooming"],
    wasteLog: false,
    dna: false,
    secondTab: "/my-schedule",
    wizard: ["Contact", "Property", "Dogs", "Plan"],
  },
  {
    lines: ["other"],
    wasteLog: false,
    dna: false,
    secondTab: "/my-schedule",
    wizard: ["Contact", "Property", "Dogs", "Plan"],
  },
];

describe("the gating table: what each set of lines shows", () => {
  for (const c of CASES) {
    const name = `{${c.lines.join(",")}}`;

    it(`${name}: the waste log is ${c.wasteLog ? "shown" : "hidden"} in the sidebar and More`, () => {
      for (const role of ["owner", "tech"] as const) {
        expect(isNavItemVisible(navItem("/waste-log"), role, vis(c.lines)), role).toBe(c.wasteLog);
      }
    });

    it(`${name}: DNA compliance needs commercial accounts AND pet waste`, () => {
      expect(isNavItemVisible(navItem("/dna"), "owner", vis(c.lines, true))).toBe(c.dna);
      expect(isNavItemVisible(navItem("/dna"), "owner", vis(c.lines, false))).toBe(false);
    });

    it(`${name}: a tech's second tab is ${c.secondTab}`, () => {
      expect(techSecondTab(runsPetWaste(c.lines))).toBe(c.secondTab);
      // And whatever is a tab is not ALSO in More, which is built by
      // excluding these.
      expect(techTabUrls(runsPetWaste(c.lines))).toEqual([
        "/my-day",
        c.secondTab,
        "/notifications",
      ]);
    });

    it(`${name}: the new-client wizard is ${c.wizard.join(" → ")}`, () => {
      expect([...newClientWizardSteps(runsPetWaste(c.lines))]).toEqual(c.wizard);
    });
  }

  it("My schedule is always somewhere a tech can reach it", () => {
    // A tab for a non-waste business; the More sheet (built from NAV_GROUPS)
    // for a pet-waste one.
    const mySchedule = navItem("/my-schedule");
    expect(mySchedule.petWasteOnly).toBeFalsy();
    expect(isNavItemVisible(mySchedule, "tech", vis(["pet_waste"]))).toBe(true);
  });

  it("only the pet-waste modules are flagged — nothing universal is", () => {
    const flagged = NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => i.petWasteOnly)
      .map((i) => i.url)
      .sort();
    expect(flagged).toEqual(["/dna", "/waste-log"]);
  });

  it("every module in the table is wired somewhere in src/", () => {
    // The table is the documentation; this keeps it from describing gates
    // that no longer exist. Each module names a piece of code that asks.
    const wiring: Record<string, [string, RegExp]> = {
      waste_log: ["src/components/MobileTabBar.tsx", /techSecondTab\(navVisibility\.petWaste\)/],
      dump_site_step: [
        "src/lib/onboarding.functions.ts",
        /const dayEnd = dayEndQuestion\(orgLines\)[\s\S]*?id: "dump_site",\s*label: endOfDay\.label/,
      ],
      stations_dna: [
        "src/components/client-detail/stations-panel.tsx",
        /!petWaste && known && data && stations\.length === 0/,
      ],
      yard_step: [
        "src/routes/_authenticated/clients.new.tsx",
        /newClientWizardSteps\(petWaste, planLine\)/,
      ],
      yard_outline_prompt: [
        "src/routes/_authenticated/my-day.tsx",
        /promptWhenMissing=\{petWaste\}/,
      ],
      area_pricing: ["src/components/ZoneDrawer.tsx", /showAreaPricing = petWaste \|\|/],
      first_cleanup: [
        "src/routes/_authenticated/settings.zones.tsx",
        /showFirstCleanup =\s*petWaste \|\|/,
      ],
      deep_clean: [
        "src/routes/_authenticated/settings.automation.tsx",
        /showSeasonal = petWaste \|\|/,
      ],
      reclean: ["src/lib/portal.functions.ts", /reclean_window_hours: petWaste \?/],
    };
    expect(Object.keys(wiring).sort()).toEqual(Object.keys(PET_WASTE_MODULES).sort());
    for (const [mod, [file, re]] of Object.entries(wiring)) {
      expect(codeOnly(read(file)), `${mod} in ${file}`).toMatch(re);
    }
  });
});

// ── The end-of-day step, on the checklist and on /setup ───────────────────
//
// /setup walks the step ids, so the step stays "dump_site" for every
// business; what changes is the question. A business without pet waste must
// not read the words "dump site" anywhere in it: not in the wording the
// server sends, and not in the panel /setup draws for it.
describe("a business without pet waste is asked where its day ends", () => {
  const status = codeOnly(read("src/lib/onboarding.functions.ts"));

  // #768 split this into three answers (dayEndQuestion): scoop-only, no
  // scooping, and both. The wording of each is asserted as behaviour in
  // tests/a-walker-sets-up-as-a-walker.test.ts; here, that the server words
  // the step from the one function the page draws from.
  it("the server words the step from the column, in every branch", () => {
    expect(status).toMatch(/const dayEnd = dayEndQuestion\(orgLines\)/);
    const branches = status.match(
      /dayEnd === "dump_site"\s*\?([\s\S]*?)\n\s*: dayEnd === "both"\s*\?([\s\S]*?)\n\s*:([\s\S]*?);\n/,
    );
    expect(branches, "endOfDay's three branches not found").toBeTruthy();
    const [, pet, both, other] = branches!;
    expect(pet).toMatch(/dump site/i);
    expect(both).toMatch(/Where does your day end\?/);
    expect(both).not.toMatch(/crew unloads|Add dump site/i);
    expect(other).toMatch(/Where does your day end\?/);
    expect(other).not.toMatch(/dump/i);
  });

  it("/setup draws the dump-site panel only for a pet-waste business", () => {
    const page = codeOnly(read("src/routes/_authenticated/setup.tsx"));
    expect(page).toMatch(/case "dump_site":\s*return <EndOfDayPanel /);
    expect(page).toMatch(/const asks = dayEndQuestion\(lines\)/);
    expect(page).toMatch(/if \(asks === "dump_site"\) return <DumpSitePanel /);
    expect(page).toMatch(/if \(asks === "day_end"\) return <DayEndPanel /);
    expect(codeOnly(read("src/components/SetupDayEndPanel.tsx"))).not.toMatch(/dump/i);
  });

  it("/setup's first step asks what the business runs, with the Settings component", () => {
    const page = codeOnly(read("src/routes/_authenticated/setup.tsx"));
    const business = page.slice(
      page.indexOf("function BusinessPanel"),
      page.indexOf("function ServiceAreaPanel"),
    );
    // First in the form: before the business name.
    expect(business.indexOf("<ServiceLinesChoices")).toBeGreaterThan(-1);
    expect(business.indexOf("<ServiceLinesChoices")).toBeLessThan(
      business.indexOf('htmlFor="setup-name"'),
    );
    expect(business).toMatch(/saveLinesFn\(\{ data: \{ lines: linesVal \} \}\)/);
    expect(codeOnly(read("src/routes/_authenticated/settings.business.tsx"))).toMatch(
      /<ServiceLinesChoices/,
    );
  });
});

// ── Fail open ─────────────────────────────────────────────────────────────
describe("an answer that cannot be read is pet waste", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty list", []],
    ["an object", {}],
    ["a string", "pet_waste"],
    ["only unknown values", ["lawn_care"]],
    ["a server-fn chain from a mocked test", () => undefined],
  ])("%s", (_label, raw) => {
    expect(serviceLinesOrDefault(raw)).toEqual(["pet_waste"]);
    expect(runsPetWaste(serviceLinesOrDefault(raw))).toBe(true);
  });

  it("a real answer is respected, unknown values dropped, duplicates collapsed", () => {
    expect(serviceLinesOrDefault(["dog_walking"])).toEqual(["dog_walking"]);
    expect(serviceLinesOrDefault(["dog_walking", "lawn_care", "dog_walking"])).toEqual([
      "dog_walking",
    ]);
  });

  it("the hook falls open on error and guesses pet waste while loading", () => {
    const hook = codeOnly(read("src/components/CommercialOnly.tsx"));
    expect(hook).toMatch(
      /if \(q\.isLoading\) return \{ lines: \[\.\.\.DEFAULT_SERVICE_LINES\], petWaste: true, known: false \}/,
    );
    expect(hook).toMatch(/serviceLinesOrDefault\(q\.isError \? null : q\.data\?\.serviceLines\)/);
    expect([...DEFAULT_SERVICE_LINES]).toEqual(["pet_waste"]);
  });

  it("the server reads the column on its own, so a missing column fails only that read", () => {
    // A build that reaches a database the migration has not reached must not
    // null the whole features row (commercial accounts, the photo rule, the
    // checklist) along with it.
    for (const file of [
      "src/lib/org-features.functions.ts",
      "src/lib/onboarding.functions.ts",
      "src/lib/portal.functions.ts",
    ]) {
      expect(codeOnly(read(file)), file).toMatch(
        /from\("organizations"\)\.select\("service_lines"\)\.eq\("id", [\w.]+\)\.maybeSingle\(\)/,
      );
    }
  });
});

// ── Seeds ─────────────────────────────────────────────────────────────────
describe("pet_waste seeds exactly what the product seeded before lines existed", () => {
  // The values as they stood on 2026-10-08, written out rather than imported,
  // so a change to the constant AND the seed together still fails here.
  const TODAY = {
    checklist: [
      { label: "All areas walked", required: true },
      { label: "Waste bagged and disposed", required: true },
      { label: "Gate latched", required: true },
      { label: "Water bowl checked", required: false },
    ],
    addOnExample: { code: "extra_visit", name: "Extra visit" },
    frequencyMultipliers: { weekly: 1.0, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 },
    estTime: {
      baseMin: 5,
      sqftPerMinute: 2000,
      perExtraDogMin: 2,
      perHazardMin: 2,
      biweeklyFactor: 1.25,
      monthlyFactor: 1.5,
      initialCleanupFactor: 2,
    },
  };

  it("byte-identical to today's literal values", () => {
    expect(JSON.stringify(LINE_SEEDS.pet_waste)).toBe(JSON.stringify(TODAY));
  });

  it("byte-identical to the constants the product still reads", () => {
    expect(JSON.stringify(LINE_SEEDS.pet_waste.checklist)).toBe(
      JSON.stringify(SUGGESTED_CHECKLIST),
    );
    expect(JSON.stringify(LINE_SEEDS.pet_waste.estTime)).toBe(
      JSON.stringify(DEFAULT_EST_TIME_CONFIG),
    );
    expect(JSON.stringify(suggestedChecklistFor(["pet_waste"]))).toBe(
      JSON.stringify(SUGGESTED_CHECKLIST),
    );
    expect(addOnExampleFor(["pet_waste"])).toEqual(TODAY.addOnExample);
    expect(addOnExampleFor(["dog_walking", "pet_waste"])).toEqual(TODAY.addOnExample);
  });

  it("the frequency multipliers are the database column's own default", () => {
    const m = read("supabase/migrations/20260701215820_4512337b-2f80-4abb-87fa-423f545cd1c3.sql");
    const def = m.match(/frequency_multipliers jsonb NOT NULL DEFAULT '([^']+)'::jsonb/);
    expect(def, "the column default moved").not.toBeNull();
    expect(JSON.stringify(LINE_SEEDS.pet_waste.frequencyMultipliers)).toBe(
      JSON.stringify(JSON.parse(def![1])),
    );
  });

  it("the settings placeholders read the seed, not their old literals", () => {
    const addons = codeOnly(read("src/routes/_authenticated/settings.addons.tsx"));
    expect(addons).toMatch(/placeholder=\{example\.code\}/);
    expect(addons).toMatch(/placeholder=\{example\.name\}/);
    const editor = codeOnly(read("src/components/VisitChecklistEditor.tsx"));
    // checklistSuggestionsFor is suggestedChecklistFor for one line, with the
    // line attached (#565); visit-checklist-per-line.test.ts holds that.
    expect(editor).toMatch(/checklistSuggestionsFor\(lines\)/);
    expect(editor).not.toMatch(/SUGGESTED_CHECKLIST/);
  });

  it("every line has a seed, and the other lines do not carry waste arithmetic", () => {
    for (const line of SERVICE_LINES) expect(LINE_SEEDS[line], line).toBeDefined();
    for (const line of SERVICE_LINES.filter((l) => l !== "pet_waste")) {
      expect(LINE_SEEDS[line].estTime.sqftPerMinute, line).toBe(0);
      expect(new Set(Object.values(LINE_SEEDS[line].frequencyMultipliers)), line).toEqual(
        new Set([1]),
      );
    }
  });

  it("a multi-line business gets each line's suggestions once", () => {
    const both = suggestedChecklistFor(["pet_waste", "dog_walking"]);
    expect(both.slice(0, 4)).toEqual(LINE_SEEDS.pet_waste.checklist);
    expect(new Set(both.map((i) => i.label.toLowerCase())).size).toBe(both.length);
  });
});

// ── The settings screen and the database agree ────────────────────────────
describe("what an owner can choose", () => {
  it("offers five lines, and all five are bookable since #549", () => {
    expect([...OFFERED_SERVICE_LINES]).toEqual([
      "pet_waste",
      "dog_walking",
      "pet_sitting",
      "mobile_grooming",
      "training",
    ]);
    expect([...LAUNCH_DEFAULT.bookable]).toEqual([
      "pet_waste",
      "dog_walking",
      "pet_sitting",
      "training",
      "mobile_grooming",
    ]);
  });

  it("a Coming soon line can be kept or dropped, never added", () => {
    expect(
      serviceLinesAdditionProblem(
        ["pet_waste"],
        ["pet_waste", "mobile_grooming"],
        GROOMING_COMING_SOON,
      ),
    ).toMatch(/coming soon/);
    expect(
      serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", "mobile_grooming"], LAUNCH_DEFAULT),
    ).toBeNull();
    expect(
      serviceLinesAdditionProblem(["dog_walking"], ["dog_walking", "training"], LAUNCH_DEFAULT),
    ).toBeNull();
    expect(
      serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", "pet_sitting"], LAUNCH_DEFAULT),
    ).toBeNull();
    // Set some other way before the hotfix: it stays, and it can go.
    const kept = ["mobile_grooming"] as const;
    expect(
      serviceLinesAdditionProblem(kept, [...kept, "pet_waste"], GROOMING_COMING_SOON),
    ).toBeNull();
    expect(
      serviceLinesAdditionProblem(
        ["pet_waste", "mobile_grooming"],
        ["pet_waste"],
        GROOMING_COMING_SOON,
      ),
    ).toBeNull();
    // The setter's own gate is serviceLinesAdditionProblem, pinned by
    // tests/pet-waste-and-walking-can-be-turned-on.test.ts.
  });

  it("training is bookable for an owner (#548), and a customer still cannot ask for it", () => {
    expect(OFFERED_SERVICE_LINES).toContain("training");
    expect(LAUNCH_DEFAULT.bookable).toContain("training");
    expect(TRAINING_COMING_SOON.bookable).not.toContain("training");
    expect(customerCanRequestService("training", LAUNCH_DEFAULT)).toBe(false);
    expect(customerCanRequestService("dog_walking", LAUNCH_DEFAULT)).toBe(true);
    // The row draws the badge and refuses the tick for any line that is not
    // bookable, so a line with the switch off (grooming before #549, training
    // before #548) reads Coming soon and its box cannot be ticked.
    const rows = codeOnly(read("src/components/ServiceLinesChoices.tsx"));
    expect(rows).toMatch(/const bookable = known && isBookableLine\(line, availability\);/);
    expect(rows).toMatch(/\{known && !bookable && <ComingSoonBadge \/>\}/);
  });

  it("refuses what the database's CHECK refuses, with a sentence", () => {
    expect(serviceLinesProblem([])).toMatch(/at least one/);
    expect(serviceLinesProblem(["lawn_care"])).toMatch(/isn't a service/);
    expect(serviceLinesProblem(["pet_waste", "pet_waste"])).toMatch(/twice/);
    expect(serviceLinesProblem(["pet_waste", "dog_walking"])).toBeNull();
  });

  it("the database knows the same values", () => {
    const m =
      read(MIGRATION) + read("supabase/migrations/20261011170000_training-is-a-service-line.sql");
    for (const line of SERVICE_LINES) expect(m).toContain(`'${line}'`);
    expect(m).toMatch(
      /ADD COLUMN IF NOT EXISTS service_lines text\[\] NOT NULL DEFAULT '\{pet_waste\}'::text\[\]/,
    );
    expect(m).toMatch(/CHECK \(public\.service_lines_are_valid\(service_lines\)\)/);
  });

  it("the card is office-only and never offers an empty set", () => {
    const card = codeOnly(read("src/routes/_authenticated/settings.business.tsx"));
    expect(card).toMatch(/if \(role === "tech"\) return null;[\s\S]{0,900}<ServiceLinesChoices/);
    // The rows (Settings and /setup draw the same component).
    const rows = codeOnly(read("src/components/ServiceLinesChoices.tsx"));
    expect(rows).toMatch(/onlyOne \|\| \(!checked && !bookable\)/);
    expect(rows).toMatch(/if \(next\) onChange\(next\);/);
    // And the rule itself: never empty, a ticked line can always go, and a
    // tick keeps the order the screens list them in.
    expect(toggledServiceLines(["pet_waste"], "pet_waste", false)).toBeNull();
    expect(toggledServiceLines(["pet_waste", "dog_walking"], "pet_waste", false)).toEqual([
      "dog_walking",
    ]);
    expect(toggledServiceLines(["dog_walking"], "pet_waste", true)).toEqual([
      "pet_waste",
      "dog_walking",
    ]);
  });

  it("is not on /get-started (the Twilio-reviewed signup)", () => {
    expect(read("src/routes/get-started.tsx")).not.toMatch(
      /service_lines|serviceLines|What do you run|Which services do you offer/,
    );
  });
});

// ── Hiding only ───────────────────────────────────────────────────────────
describe("lines hide; they never refuse a write and never delete", () => {
  it("no server function asserts a line", () => {
    const libs = readdirSync(join(ROOT, "src/lib")).filter((f) => f.endsWith(".ts"));
    for (const f of libs) {
      expect(codeOnly(read(`src/lib/${f}`)), f).not.toMatch(
        /requirePetWaste|assertPetWaste|assertServiceLine/,
      );
    }
  });

  it("the migration deletes nothing and adds no trigger, and is not platform-protected", () => {
    const m = codeOnly(read(MIGRATION));
    expect(m).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|CREATE TRIGGER/i);
    expect(m).not.toMatch(/tg_orgs_protect_platform_columns/);
  });

  it("the setter goes through updateOwnOrg after manage_settings — nothing widened", () => {
    const fns = read("src/lib/org-features.functions.ts");
    const setter = fns.slice(fns.indexOf("export const setServiceLines"));
    expect(setter).toMatch(
      /requirePermission\(context\.supabase, context\.userId, "manage_settings"\)/,
    );
    expect(setter).toMatch(
      /updateOwnOrg\(context\.supabase, orgId, \{ service_lines: data\.lines \}\)/,
    );
    expect(codeOnly(read(MIGRATION))).not.toMatch(
      /\bGRANT\s+(UPDATE|ALL)\b|CREATE POLICY|ALTER POLICY/i,
    );
  });

  it("the setter idempotently seeds services for the selected lines", () => {
    const fns = codeOnly(read("src/lib/org-features.functions.ts"));
    expect(fns).toMatch(/defaultServiceSeedsFor\(lines\)/);
    expect(fns).toMatch(
      /from\("services"\)\s*\.select\("name, service_line"\)\s*\.eq\("organization_id", orgId\)/,
    );
    expect(fns).toMatch(/if \(have\.has\(key\)\) continue/);
    expect(fns).toMatch(/if \(error\.code === "23505"\)/);
    expect(fns).toMatch(/ensureDefaultServicesForLines\(context\.supabase, orgId, data\.lines\)/);
  });

  it("a module still in use stays visible", () => {
    // A first cleanup, area pricing, a zone fee or a seasonal campaign that is
    // configured is charging somebody; its switch must stay findable.
    expect(read("src/routes/_authenticated/settings.zones.tsx")).toMatch(
      /firstCleanupQ\.data\.pricing\.mode !== "off"/,
    );
    expect(read("src/components/ZoneDrawer.tsx")).toMatch(
      /\(zone\?\.pricing_mode \?\? "flat"\) !== "flat"/,
    );
    expect(read("src/components/ZoneDrawer.tsx")).toMatch(
      /Number\(zone\?\.initial_cleanup_cents \?\? 0\) > 0/,
    );
    expect(read("src/routes/_authenticated/settings.automation.tsx")).toMatch(
      /!!data\.seasonal_deepclean_enabled/,
    );
    expect(read("src/routes/_authenticated/settings.tsx")).toMatch(
      /deepClean\.data\?\.enabled === true/,
    );
  });
});

// ── THE RULE: every signpost to a pet-waste page is gated ─────────────────
//
// CLAUDE.md, "A pet-waste page is signposted only to a pet-waste business".
// A navigation entry is an object literal with a title or label and a url or
// to on ONE line -- the shape of NavItem (AppSidebar), Tab (settings) and
// NavEntry (CommandPalette). One whose path is in PET_WASTE_ROUTES and that
// does not say `petWasteOnly: true` is a waste log in a dog walker's menu.
//
// Deliberately silent on: JSX <Link to=…> inside a page (a link from inside a
// commercial unit to /dna is reached only by someone already holding that
// data), the Knowledge Center's appLink (documentation of a page, not a menu
// of the business), and multi-line objects (the onboarding step, which is
// gated by a branch and pinned above).
describe("every signpost to a pet-waste page carries petWasteOnly", () => {
  const SKIP = new Set(["src/lib/help-content.ts"]);

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [p] : [];
    });
  }

  const ENTRY = new RegExp(
    String.raw`\{[^{}\n]*\b(?:title|label):\s*"[^"]*"[^{}\n]*\b(?:url|to):\s*"(${PET_WASTE_ROUTES.map((r) => r.replace(/\//g, "\\/")).join("|")})"[^{}\n]*\}`,
    "g",
  );

  it("finds the entries it is meant to find", () => {
    // Guard against a regex that matches nothing and passes vacuously.
    const sidebar = read("src/components/AppSidebar.tsx");
    expect([...sidebar.matchAll(ENTRY)].map((m) => m[1]).sort()).toEqual(["/dna", "/waste-log"]);
    expect(
      [...read("src/routes/_authenticated/settings.tsx").matchAll(ENTRY)].map((m) => m[1]),
    ).toEqual(["/settings/deep-clean"]);
    expect([...read("src/components/CommandPalette.tsx").matchAll(ENTRY)].map((m) => m[1])).toEqual(
      ["/waste-log"],
    );
  });

  it("and every one of them is gated", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const rel = repoRelative(file, ROOT);
      if (SKIP.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        for (const m of line.matchAll(ENTRY)) {
          if (!/\bpetWasteOnly:\s*true\b/.test(m[0])) offenders.push(`${rel}:${i + 1}  ${m[0]}`);
        }
      });
    }
    expect(
      offenders,
      "A menu entry for a pet-waste page without `petWasteOnly: true` shows a dog walker the waste log. " +
        "Add the flag (and make the list it is in filter on it).",
    ).toEqual([]);
  });

  it("and each list filters on it", () => {
    expect(read("src/components/AppSidebar.tsx")).toMatch(/\(!it\.petWasteOnly \|\| v\.petWaste\)/);
    expect(read("src/routes/_authenticated/settings.tsx")).toMatch(
      /\(!t\.petWasteOnly \|\| petWaste/,
    );
    expect(read("src/components/CommandPalette.tsx")).toMatch(
      /\(!item\.petWasteOnly \|\| petWaste\)/,
    );
  });
});

describe("Messages follows client texting availability", () => {
  it("hides the entry until this business can text and restores it when ready", () => {
    const item = navItem("/messages");
    for (const role of ["owner", "office_manager", "dispatcher"] as const) {
      expect(isNavItemVisible(item, role, vis(["pet_waste"]))).toBe(false);
      expect(isNavItemVisible(item, role, { ...vis(["pet_waste"]), texting: true })).toBe(true);
    }
  });
});
