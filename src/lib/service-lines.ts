/** What a business runs: its service lines, and what each one decides.
 *
 *  `organizations.service_lines` (migration 20261008120000) is the owner's
 *  answer to "what do you run?". Pure data and pure functions live here so the
 *  sidebar, the tab bar, the onboarding checklist and the tests all read one
 *  copy of the rules:
 *
 *    which modules are pet-waste-only   PET_WASTE_MODULES / showsPetWasteModules
 *    what a line seeds                  LINE_SEEDS
 *    what the settings screen offers    OFFERED_SERVICE_LINES / BOOKABLE_SERVICE_LINES
 *
 *  Like `commercial_accounts`, this is a RENDERING preference with no
 *  adversary. It hides; it never refuses a write and never deletes. And it
 *  fails OPEN: an answer that cannot be read is treated as pet waste, because
 *  every business on the platform today is one, and a lookup that fails must
 *  not take a tech's waste log away mid-route. */

import { DEFAULT_EST_TIME_CONFIG, type EstTimeConfig } from "@/lib/estimated-time";
import { SUGGESTED_CHECKLIST } from "@/lib/visit-checklist";

/** Every value the database accepts (service_lines_are_valid). Order is the
 *  order the settings screen lists them in. */
export const SERVICE_LINES = [
  "pet_waste",
  "dog_walking",
  "pet_sitting",
  "mobile_grooming",
  "other",
] as const;

export type ServiceLine = (typeof SERVICE_LINES)[number];

/** What an org that has said nothing runs: the column's default. */
export const DEFAULT_SERVICE_LINES: readonly ServiceLine[] = ["pet_waste"];

/** Shown on Settings → Business defaults. `other` is accepted by the database
 *  so a future "something else" needs no migration, but it is not offered:
 *  it would hide pet-waste screens and give nothing in return. */
export const OFFERED_SERVICE_LINES: readonly ServiceLine[] = [
  "pet_waste",
  "dog_walking",
  "pet_sitting",
  "mobile_grooming",
];

/** Lines an owner can actually choose today. The others are "coming soon"
 *  until the service catalog lands (docs/other-trades-service-catalog.md):
 *  the data model cannot book a 30-minute walk at 11:00 and another at 16:00
 *  on one day, so selling the line before then would sell a broken product. */
export const BOOKABLE_SERVICE_LINES: readonly ServiceLine[] = ["pet_waste"];

export const SERVICE_LINE_LABEL: Record<ServiceLine, string> = {
  pet_waste: "Pet waste removal",
  dog_walking: "Dog walking",
  pet_sitting: "Pet sitting",
  mobile_grooming: "Mobile grooming",
  other: "Something else",
};

function isServiceLine(v: unknown): v is ServiceLine {
  return typeof v === "string" && (SERVICE_LINES as readonly string[]).includes(v);
}

/**
 * The same rule as the database's `service_lines_are_valid`, as a sentence:
 * non-empty, every element known, no duplicates. Null when the set is fine.
 */
export function serviceLinesProblem(lines: readonly unknown[]): string | null {
  if (lines.length === 0) return "Choose at least one service.";
  if (!lines.every(isServiceLine)) return "That isn't a service HoundStack knows about.";
  if (new Set(lines).size !== lines.length) return "A service is listed twice.";
  return null;
}

/**
 * What the org runs, out of whatever the features query holds.
 *
 * FAILS OPEN. Anything that is not a usable list -- the query failed, the
 * column does not exist yet on this database, a persisted copy from an older
 * build, a mocked server function in a test -- reads as the default,
 * {pet_waste}. The cost of being wrong that way is a slightly busier screen;
 * the cost of the other way is a tech whose waste log disappeared.
 */
export function serviceLinesOrDefault(raw: unknown): ServiceLine[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SERVICE_LINES];
  const known = raw.filter(isServiceLine);
  const unique = [...new Set(known)];
  return unique.length > 0 ? unique : [...DEFAULT_SERVICE_LINES];
}

export function runsPetWaste(lines: readonly ServiceLine[]): boolean {
  return lines.includes("pet_waste");
}

// ── THE GATING TABLE ────────────────────────────────────────────────────────
//
// Every module that only means something to a pet-waste business, and where
// it is hidden. "Hidden" is the whole of it: the routes stay routable, the
// server functions answer, the rows stay put. A module that already holds the
// org's data (a configured first cleanup, area pricing on a zone, a seasonal
// campaign that is switched on) stays visible regardless, so hiding can never
// strand something that is charging a customer.
//
// tests/a-dog-walker-should-not-have-to-learn-about-dump-sites.test.ts walks
// this table against the code.

export type PetWasteModule =
  | "waste_log"
  | "dump_site_step"
  | "stations_dna"
  | "yard_step"
  | "yard_outline_prompt"
  | "area_pricing"
  | "first_cleanup"
  | "deep_clean"
  | "reclean";

export const PET_WASTE_MODULES: Record<PetWasteModule, string> = {
  waste_log:
    "Waste log: the tech's second tab (My schedule takes the slot), and the sidebar / More entry",
  dump_site_step:
    'Get-started step "Add your dump site" (becomes "Where does your day end?", pointing at each tech\'s route end)',
  stations_dna: "DNA compliance (also commercialOnly) and waste stations",
  yard_step: 'The "Yard" step of the new-client wizard (outline sketch)',
  yard_outline_prompt: 'My Day\'s "No yard outline yet" line (an outline that exists still shows)',
  area_pricing: "Per-sq-ft / per-acre zone pricing (shown anyway when a zone already uses it)",
  first_cleanup:
    "First cleanup pricing on Zones, and its offer in the new-client wizard (shown anyway when it is configured)",
  deep_clean:
    "Settings → Deep clean, and the seasonal deep-clean campaign (shown anyway when it is on)",
  reclean: "The re-clean guarantee setting, and the portal's Request a re-clean button",
};

/** The pages that ARE pet-waste modules. Any signpost to one of these -- a
 *  sidebar or More entry, a settings tab, a command-palette row -- carries
 *  `petWasteOnly: true`, and tests/a-dog-walker-should-not-have-to-learn-
 *  about-dump-sites.test.ts finds the one that does not. The pages stay
 *  routable: a link someone saved still opens. */
export const PET_WASTE_ROUTES = ["/waste-log", "/dna", "/settings/deep-clean"] as const;

/** One question for every module above. Kept as a function of the module so
 *  a module that later needs a different rule (grooming wants the yard step
 *  for mobile vans' parking, say) changes here and nowhere else. */
export function showsPetWasteModule(_module: PetWasteModule, lines: readonly ServiceLine[]): boolean {
  return runsPetWaste(lines);
}

/** The new-client wizard's steps, in order. */
export const NEW_CLIENT_STEPS = ["Contact", "Property", "Yard", "Dogs", "Plan"] as const;
export type NewClientStep = (typeof NEW_CLIENT_STEPS)[number];

/** "Yard" sketches the outline that area pricing and the waste-time estimate
 *  read, so only a pet-waste business is asked for it. The outline can still
 *  be drawn later from the client's property, by anybody who wants one. */
export function newClientWizardSteps(petWaste: boolean): readonly NewClientStep[] {
  return petWaste ? NEW_CLIENT_STEPS : NEW_CLIENT_STEPS.filter((s) => s !== "Yard");
}

// ── SEEDS: WHAT EACH LINE SUGGESTS ──────────────────────────────────────────
//
// Pure data. `pet_waste` produces EXACTLY today's values -- the checklist
// suggestions, the add-on placeholder, the database's frequency_multipliers
// default and the estimator's defaults -- and a test holds it byte-identical,
// so introducing lines changes nothing for a pet-waste business.
//
// The other lines' numbers are first proposals for step 2, when signup seeds
// an org per line. Today only the checklist suggestions and the add-on
// placeholder are read, and only for an org whose lines include them.

export type LineSeeds = {
  /** One-tap suggestions on the visit checklist editor. */
  checklist: readonly { label: string; required: boolean }[];
  /** The placeholder on Settings → Add-ons' "New service" form. */
  addOnExample: { code: string; name: string };
  /** Per-visit price multiplier by cadence. Pet waste accumulates, so a
   *  monthly visit is a bigger job than a weekly one; a walk is not. */
  frequencyMultipliers: Readonly<Record<"weekly" | "biweekly" | "twice_weekly" | "monthly", number>>;
  /** The estimator's constants (estimated-time.ts). */
  estTime: EstTimeConfig;
};

/** Every cadence costs the same per visit: nothing accumulates between walks. */
const FLAT_MULTIPLIERS = { weekly: 1.0, biweekly: 1.0, twice_weekly: 1.0, monthly: 1.0 } as const;

/** A fixed-length visit: no yard area, no cadence scaling, no first-visit factor. */
function fixedVisit(baseMin: number, perExtraPetMin: number): EstTimeConfig {
  return {
    baseMin,
    sqftPerMinute: 0,
    perExtraDogMin: perExtraPetMin,
    perHazardMin: 0,
    biweeklyFactor: 1,
    monthlyFactor: 1,
    initialCleanupFactor: 1,
  };
}

export const LINE_SEEDS: Readonly<Record<ServiceLine, LineSeeds>> = {
  pet_waste: {
    checklist: SUGGESTED_CHECKLIST,
    addOnExample: { code: "deodorize", name: "Yard deodorize" },
    // organizations.frequency_multipliers' column default, migration
    // 20260701215820.
    frequencyMultipliers: { weekly: 1.0, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 },
    estTime: DEFAULT_EST_TIME_CONFIG,
  },
  dog_walking: {
    checklist: [
      { label: "Dog collected and returned", required: true },
      { label: "Door locked and gate latched", required: true },
      { label: "Water refreshed", required: false },
      { label: "Walk note left for the owner", required: false },
    ],
    addOnExample: { code: "extra_15", name: "Extra 15 minutes" },
    frequencyMultipliers: FLAT_MULTIPLIERS,
    estTime: fixedVisit(30, 5),
  },
  pet_sitting: {
    checklist: [
      { label: "Fed and water refreshed", required: true },
      { label: "Medication given as instructed", required: false },
      { label: "Litter or yard cleaned up", required: false },
      { label: "Doors locked, lights as asked", required: true },
    ],
    addOnExample: { code: "overnight", name: "Overnight stay" },
    frequencyMultipliers: FLAT_MULTIPLIERS,
    estTime: fixedVisit(30, 5),
  },
  mobile_grooming: {
    checklist: [
      { label: "Coat and skin checked before starting", required: true },
      { label: "Nails trimmed", required: false },
      { label: "Ears cleaned", required: false },
      { label: "Pet returned dry and secured", required: true },
    ],
    addOnExample: { code: "teeth", name: "Teeth brushing" },
    frequencyMultipliers: FLAT_MULTIPLIERS,
    estTime: fixedVisit(60, 45),
  },
  other: {
    checklist: [],
    addOnExample: { code: "extra", name: "Extra service" },
    frequencyMultipliers: FLAT_MULTIPLIERS,
    estTime: fixedVisit(30, 0),
  },
};

/** The checklist suggestions for a set of lines: each line's in order, a label
 *  that two lines share offered once. For {pet_waste} this IS
 *  SUGGESTED_CHECKLIST. */
export function suggestedChecklistFor(
  lines: readonly ServiceLine[],
): readonly { label: string; required: boolean }[] {
  if (lines.length === 1) return LINE_SEEDS[lines[0]].checklist;
  const seen = new Set<string>();
  const out: { label: string; required: boolean }[] = [];
  for (const line of lines) {
    for (const item of LINE_SEEDS[line].checklist) {
      const key = item.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** The add-on placeholder: the first line's. Pet waste first when present, so
 *  a pet-waste business sees exactly what it saw before lines existed. */
export function addOnExampleFor(lines: readonly ServiceLine[]): { code: string; name: string } {
  const first = runsPetWaste(lines) ? "pet_waste" : (lines[0] ?? "pet_waste");
  return LINE_SEEDS[first].addOnExample;
}
