/** What a business runs: its service lines, and what each one decides.
 *
 *  `organizations.service_lines` (migration 20261008120000) is the owner's
 *  answer to "what do you run?". Pure data and pure functions live here so the
 *  sidebar, the tab bar, the onboarding checklist and the tests all read one
 *  copy of the rules:
 *
 *    which modules are pet-waste-only   PET_WASTE_MODULES / showsPetWasteModules
 *    what a line seeds                  LINE_SEEDS
 *    what the settings screen offers    OFFERED_SERVICE_LINES
 *    which lines are live               ServiceLineAvailability (read at runtime)
 *
 *  Like `commercial_accounts`, this is a RENDERING preference with no
 *  adversary. It hides; it never refuses a write and never deletes. And it
 *  fails OPEN: an answer that cannot be read is treated as pet waste, because
 *  every business on the platform today is one, and a lookup that fails must
 *  not take a tech's waste log away mid-route. */

import { DEFAULT_EST_TIME_CONFIG, type EstTimeConfig } from "@/lib/estimated-time";
import { SUGGESTED_CHECKLIST, type ChecklistItem } from "@/lib/visit-checklist";

/** Every value the database accepts (service_lines_are_valid). Order is the
 *  order the settings screen lists them in. */
export const SERVICE_LINES = [
  "pet_waste",
  "dog_walking",
  "pet_sitting",
  "mobile_grooming",
  "training",
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
  "training",
];

/** Which lines are live, as the platform switch says (#531).
 *
 *  The answer is not written down in code. It is the table
 *  `public.platform_service_lines` (migration 20261025200000), one row per
 *  line, read at runtime: on the server by loadServiceLineAvailability
 *  (service-line-availability.server.ts), in the browser through
 *  getServiceLineAvailability. A platform admin turns a line on or off with
 *  no new build.
 *
 *    bookable              an owner may add the line, and customers may be
 *                          sold it. Until then the picker shows it as Coming
 *                          soon. A business that already runs one keeps it;
 *                          setServiceLines refuses only adding one.
 *    customerRequestable   a customer or the receptionist may ask for it
 *                          from the portal or by text, once it is also
 *                          bookable. Training is sold and scheduled by the
 *                          office on those doors, so it is false. Mobile
 *                          grooming is true since #549, so a client may ask
 *                          for a groom from the portal; the office still
 *                          books it there (OFFICE_BOOKED_LINES). The public
 *                          booking link reads only `bookable` since #560
 *                          (bookingLinkOffersLine). */
export type ServiceLineAvailability = {
  bookable: readonly ServiceLine[];
  customerRequestable: readonly ServiceLine[];
};

/** service_line_availability()'s rows, typed. A row that is not the right
 *  shape, or names a line this build does not know, is dropped. */
export function serviceLineAvailabilityFromRows(raw: unknown): ServiceLineAvailability {
  const bookable: ServiceLine[] = [];
  const customerRequestable: ServiceLine[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      if (!isServiceLine(o.service_line)) continue;
      if (o.bookable === true && !bookable.includes(o.service_line)) bookable.push(o.service_line);
      if (o.customer_requestable === true && !customerRequestable.includes(o.service_line))
        customerRequestable.push(o.service_line);
    }
  }
  return { bookable, customerRequestable };
}

/** Whether an owner may add this line, and customers may be sold it. */
export function isBookableLine(line: string, availability: ServiceLineAvailability): boolean {
  return (availability.bookable as readonly string[]).includes(line);
}

/** Whether a customer, the public signup form, or the receptionist may ask
 *  for this line. Both switches: a Coming soon line is not for sale whatever
 *  its second column says. */
export function customerCanRequestService(
  line: string,
  availability: ServiceLineAvailability,
): boolean {
  return (
    isBookableLine(line, availability) &&
    (availability.customerRequestable as readonly string[]).includes(line)
  );
}

/** Lines a customer may ASK for but never book themselves through the
 *  receptionist or the portal's one-off: the office books them. Neither door
 *  asks for a pet's size or prices add-ons, and a groom is priced by each
 *  pet's size and coat and timed with its add-ons, so a client asks through
 *  the portal (portal_request_groom) and the office books it (Book this
 *  groom).
 *
 *  The booking link is not one of these doors any more (#560): it asks each
 *  pet's size and prices the add-ons with the office's own groomQuote, so it
 *  lists every line that is live (bookingLinkOffersLine).
 *
 *  The database has the same list, public.office_booked_service_lines()
 *  (migration 20261027200000). It changes with code, not with the platform
 *  switch; a change here is a new migration restating that function, and
 *  tests/a-stranger-is-not-sold-a-groom.test.ts fails until the two agree. */
export const OFFICE_BOOKED_LINES: readonly ServiceLine[] = ["mobile_grooming"];

/** Whether the public booking link (/signup/{slug}) offers this line: every
 *  line that is live on the platform switch (#560). Walking, sitting,
 *  training and grooming are each self-serve there, with a base price and
 *  the line's add-ons, a size per pet where the service prices by size, and
 *  a request when a step cannot be done online (a stay, a groom's
 *  appointment, a service with no price yet).
 *
 *  It does not read customer_requestable. That column still gates the doors
 *  that cannot ask the questions the link asks: the portal's one-off and the
 *  receptionist. public_services and public_quote read the same rule
 *  (20261028120000). */
export function bookingLinkOffersLine(
  line: string,
  availability: ServiceLineAvailability,
): boolean {
  return isBookableLine(line, availability);
}

/** Whether a customer, the public signup form, or the receptionist may BOOK
 *  this line themselves: requestable on the switch, and not one the office
 *  books (OFFICE_BOOKED_LINES). */
export function customerCanBookService(
  line: string,
  availability: ServiceLineAvailability,
): boolean {
  return (
    customerCanRequestService(line, availability) &&
    !(OFFICE_BOOKED_LINES as readonly string[]).includes(line)
  );
}

/** Whether a client may ask for a stay from the portal. Sitting is Coming
 *  soon until the switch turns it on, the same gate the service picker and
 *  training's portal read. */
export function customerCanRequestStay(availability: ServiceLineAvailability): boolean {
  return customerCanRequestService("pet_sitting", availability);
}

export const SERVICE_LINE_LABEL: Record<ServiceLine, string> = {
  pet_waste: "Pet waste removal (scooping)",
  dog_walking: "Dog walking",
  pet_sitting: "Pet sitting",
  mobile_grooming: "Mobile grooming",
  training: "Dog training",
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
 * Null when `next` adds no line that is still Coming soon. A line the org
 * already runs is kept, so a business that runs walking can still save an
 * unrelated change. Once it turns walking off, it cannot turn it on again.
 */
export function serviceLinesAdditionProblem(
  current: readonly ServiceLine[],
  next: readonly ServiceLine[],
  availability: ServiceLineAvailability,
): string | null {
  const added = next.filter((l) => !current.includes(l));
  return added.every((l) => isBookableLine(l, availability))
    ? null
    : "That service is coming soon.";
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

/**
 * Whether the first step of /setup starts with nothing ticked and asks
 * (F-06): the step is not done yet, the answer was read, and it is still the
 * column's default. Every new business is created holding {pet_waste}, so
 * showing that ticked told a groomer they scoop. The column default and the
 * fail-open read are unchanged: an answer that could not be read (`known`
 * false) shows what it shows today, and a finished step shows what is
 * stored, pet waste included.
 */
export function setupAsksServiceLines(
  saved: readonly ServiceLine[],
  known: boolean,
  stepDone: boolean,
): boolean {
  return (
    known &&
    !stepDone &&
    saved.length === DEFAULT_SERVICE_LINES.length &&
    saved.every((l) => DEFAULT_SERVICE_LINES.includes(l))
  );
}

/**
 * The set after ticking or unticking one line, in the order the screens list
 * them, or null when the change would leave nothing ticked: the database
 * refuses an empty set, and "runs nothing" is not a business. One copy for
 * Settings → Business defaults and the first step of /setup.
 */
export function toggledServiceLines(
  lines: readonly ServiceLine[],
  line: ServiceLine,
  on: boolean,
): ServiceLine[] | null {
  const next = on
    ? OFFERED_SERVICE_LINES.filter((l) => l === line || lines.includes(l))
    : lines.filter((l) => l !== line);
  return next.length > 0 ? next : null;
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
    'The setup step "Where the day ends" asks for a dump site (becomes "Where does your day end?", saved as each tech\'s route end)',
  stations_dna: "DNA compliance (also commercialOnly) and waste stations",
  yard_step: 'The "Outline" step of the new-client wizard (property outline sketch)',
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
export function showsPetWasteModule(
  _module: PetWasteModule,
  lines: readonly ServiceLine[],
): boolean {
  return runsPetWaste(lines);
}

/** Whether Zones shows a zone's per-visit price and per-dog charge (R2-38).
 *  They are what a scooping plan is quoted from; a walk, a sit, a groom or
 *  a lesson is priced from its own service. Shown to a business that runs
 *  pet waste, and to any business while the zone prices a yard some other
 *  way (area pricing, a first-cleanup fee), so nothing that is charging a
 *  customer is hidden. A new zone (`zone` null) is flat with no fee. */
export function showsZoneVisitPrice(
  lines: readonly ServiceLine[],
  zone: { pricing_mode?: string | null; initial_cleanup_cents?: number | null } | null,
): boolean {
  return (
    runsPetWaste(lines) ||
    (zone?.pricing_mode ?? "flat") !== "flat" ||
    Number(zone?.initial_cleanup_cents ?? 0) > 0
  );
}

/** Settings → Client portal's one-off price field (F-06). It is the pet-waste
 *  one-off's price, so it says so beside a business's other lines; a
 *  business that runs no pet waste reads "an extra visit". */
export function portalExtraVisitPriceLabel(lines: readonly ServiceLine[]): string {
  return runsPetWaste(lines) && lines.some((l) => l !== "pet_waste")
    ? "Price of an extra pet waste visit"
    : "Price of an extra visit";
}

/** The new-client wizard's steps, in order. */
export const NEW_CLIENT_STEPS = ["Contact", "Property", "Outline", "Dogs", "Plan"] as const;
export type NewClientStep = (typeof NEW_CLIENT_STEPS)[number];

/** "Outline" sketches the outline that area pricing and the waste-time estimate
 *  read, so only a pet-waste business is asked for it. The outline can still
 *  be drawn later from the client's property, by anybody who wants one. */
export function newClientWizardSteps(petWaste: boolean): readonly NewClientStep[] {
  return petWaste ? NEW_CLIENT_STEPS : NEW_CLIENT_STEPS.filter((s) => s !== "Outline");
}

// ── SEEDS: WHAT EACH LINE SUGGESTS ──────────────────────────────────────────
//
// Pure data. `pet_waste` produces EXACTLY today's values -- the checklist
// suggestions, the add-on placeholder, the database's frequency_multipliers
// default and the estimator's defaults -- and a test holds it byte-identical,
// so introducing lines changes nothing for a pet-waste business.
//
// Checklist suggestions and add-on examples are read for the business's lines.
// Sitting starter services are seeded in the database by
// 20261024081200_a-sitting-business-starts-with-its-services.sql.
// The other lines' estimator and multiplier values remain proposals.

export type LineSeeds = {
  /** One-tap suggestions on the visit checklist editor. */
  checklist: readonly { label: string; required: boolean }[];
  /** The placeholder on Settings → Add-ons' "New service" form. */
  addOnExample: { code: string; name: string };
  /** Per-visit price multiplier by cadence. Pet waste accumulates, so a
   *  monthly visit is a bigger job than a weekly one; a walk is not. */
  frequencyMultipliers: Readonly<
    Record<"weekly" | "biweekly" | "twice_weekly" | "monthly", number>
  >;
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
    addOnExample: { code: "extra_visit", name: "Extra visit" },
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
    addOnExample: { code: "extra_pet", name: "Extra pet" },
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
  training: {
    checklist: [
      { label: "Training goal reviewed", required: true },
      { label: "Homework left for the client", required: true },
      { label: "Progress note recorded", required: false },
      { label: "Next session recommended", required: false },
    ],
    addOnExample: { code: "extra_training", name: "Extra training session" },
    frequencyMultipliers: FLAT_MULTIPLIERS,
    estTime: fixedVisit(60, 10),
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

/** The suggestions the checklist editor offers, each with the line it is
 *  saved under (#565). One line: that line's list, as suggestedChecklistFor
 *  gives it. More than one: every line's own list, not merged, so "Gate
 *  latched" can be asked on a scoop and on a walk as two items. */
export function checklistSuggestionsFor(
  lines: readonly ServiceLine[],
): { label: string; required: boolean; line: ServiceLine }[] {
  if (lines.length <= 1) {
    const line = lines[0] ?? "pet_waste";
    return suggestedChecklistFor([line]).map((s) => ({ ...s, line }));
  }
  return lines.flatMap((line) => LINE_SEEDS[line].checklist.map((s) => ({ ...s, line })));
}

/** How the editor lays the list out. Null for a one-line business: one list,
 *  as it always was. Otherwise the every-visit items first, then one group
 *  per line the business runs, and one for any line an item still names
 *  after the business stopped running it, so that item can be seen. */
export function checklistGroupsFor(
  items: readonly ChecklistItem[],
  lines: readonly ServiceLine[],
): { line: ServiceLine | null; items: ChecklistItem[] }[] | null {
  if (lines.length <= 1) return null;
  const named = new Set(items.map((i) => i.line));
  const shown = SERVICE_LINES.filter((l) => lines.includes(l) || named.has(l));
  return [
    { line: null, items: items.filter((i) => !i.line) },
    ...shown.map((line) => ({ line, items: items.filter((i) => i.line === line) })),
  ];
}

/** Pet-waste suggestions that make no sense on a walk, a sit, a groom or a
 *  lesson. Saved before lines existed, they have no line, so they are asked
 *  on every visit (#565). "Gate latched" is not here: a walker and a sitter
 *  latch gates too. "Water bowl checked" is: it is the yard's bowl, and the
 *  other lines have their own water item. */
export const WASTE_ONLY_CHECKLIST_LABELS: readonly string[] = [
  "All areas walked",
  "Waste bagged and disposed",
  "Water bowl checked",
];

/** What a non-waste visit is called in the callout below. */
const VISIT_NOUN: Record<ServiceLine, string> = {
  pet_waste: "scoops",
  dog_walking: "walks",
  pet_sitting: "sits",
  mobile_grooming: "grooms",
  training: "lessons",
  other: "other visits",
};

/** The every-visit items that read as pet-waste work, for a business that
 *  scoops and runs another line. Empty for anyone else: a business that only
 *  scoops is asked them on scoops anyway, and one that does not scoop would
 *  lose them entirely by moving them to pet waste. Matched on the label, as
 *  the owner sees it, ignoring case and spaces at the ends. */
export function everyVisitWasteItems(
  items: readonly ChecklistItem[],
  lines: readonly ServiceLine[],
): ChecklistItem[] {
  if (!lines.includes("pet_waste") || !lines.some((l) => l !== "pet_waste")) return [];
  const waste = new Set(WASTE_ONLY_CHECKLIST_LABELS.map((l) => l.toLowerCase()));
  return items.filter((i) => !i.line && waste.has(i.label.trim().toLowerCase()));
}

/** The same list with the named items asked on pet waste visits only. Ids,
 *  labels, order and every other item are kept, so a completion queued on a
 *  phone before the change still finds its items. */
export function askOnPetWasteOnly(
  items: readonly ChecklistItem[],
  ids: readonly string[],
): ChecklistItem[] {
  const move = new Set(ids);
  return items.map((i) => (move.has(i.id) && !i.line ? { ...i, line: "pet_waste" } : i));
}

/** "walks and sits", "walks, sits and lessons": the business's other lines. */
export function otherVisitsPhrase(lines: readonly ServiceLine[]): string {
  const nouns = SERVICE_LINES.filter((l) => l !== "pet_waste" && lines.includes(l)).map(
    (l) => VISIT_NOUN[l],
  );
  if (nouns.length <= 1) return nouns[0] ?? "";
  return `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
}

/** The add-on placeholder: the first line's. Pet waste first when present, so
 *  a pet-waste business sees exactly what it saw before lines existed. */
export function addOnExampleFor(lines: readonly ServiceLine[]): { code: string; name: string } {
  const first = runsPetWaste(lines) ? "pet_waste" : (lines[0] ?? "pet_waste");
  return LINE_SEEDS[first].addOnExample;
}
