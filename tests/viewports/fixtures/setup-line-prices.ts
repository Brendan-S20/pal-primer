// The stub answers for /setup's price step at a business that sits, grooms
// or trains (#959), shared by the viewport spec
// (setup-asks-sitting-grooming-and-training-prices.spec.ts) and the PR's
// screenshot script. Made-up data only.
//
// The step shapes are what src/lib/onboarding.functions.ts returns for each
// mix of lines; the services are what signup seeds (the sitting starters at
// $25 / $75 / $100, migration 20261024081200; the grooms; the lesson service
// unpriced), and the package is ensureTrainingDefaults' 6-session package,
// inactive at $0. Awkward on purpose where a fixture can be: a long
// sitting service name and a long skill, because a tidier fixture measures
// nothing (CLAUDE.md).

import * as fx from "./dataset";
import { BASE_STUBS, SERVICE_AREA_PART } from "./stub-backend";

const id = (n: string) => `aaaaaaaa-0000-4000-8000-00000000${n}`;
const svc = (
  n: string,
  name: string,
  line: string,
  unit: string,
  cents: number | null,
  minutes: number | null,
) => ({
  id: id(n),
  organization_id: fx.ORG_ID,
  name,
  service_line: line,
  price_unit: unit,
  base_price_cents: cents,
  extra_pet_cents: 0,
  default_duration_min: minutes,
  holiday_surcharge_pct: 0,
  active: true,
  created_at: "2026-11-16T12:00:00Z",
  updated_at: "2026-11-16T12:00:00Z",
});

export const SETUP_STAYS = [
  svc("c951", "Drop-in", "pet_sitting", "visit", 2500, 30),
  svc("c952", "Overnight stay", "pet_sitting", "night", 7500, null),
  svc(
    "c953",
    "House sit with plant watering and mail collection",
    "pet_sitting",
    "night",
    10000,
    null,
  ),
];
export const SETUP_GROOMS = [
  svc("c954", "Bath and tidy (60 min)", "mobile_grooming", "visit", 5000, 60),
  svc("c955", "Full groom (90 min)", "mobile_grooming", "visit", 8000, 90),
];
export const SETUP_LESSONS = [
  svc("c956", "Private lesson (60 min)", "training", "visit", null, 60),
];

const PART = {
  stays: {
    id: "stays",
    label: "Sitting",
    description: "What a Drop-in, an Overnight stay and a House sit cost.",
    to: "/settings/services",
    cta: "Price stays",
  },
  grooms: {
    id: "grooms",
    label: "Grooming",
    description: "The size grid, required vaccines, and setup, cleanup and travel minutes.",
    to: "/settings/services",
    cta: "Price grooms",
  },
  lessons: {
    id: "lessons",
    label: "Training",
    description: "Price your lesson package, turn it on, and add the skills a trainer scores.",
    to: "/settings/services",
    cta: "Price lessons",
  },
} as const;

const ONE_LINE: Record<string, Record<string, unknown>> = {
  pet_sitting: {
    label: "Price your sitting services",
    description:
      "Set what a Drop-in, an Overnight stay and a House sit cost before booking your first stay. New clients are quoted these prices. Clients book inside the service area you set here.",
    to: "/setup",
    cta: "Price stays",
    gate: "/settings/services",
  },
  mobile_grooming: {
    label: "Review your grooming prices, vaccines and buffer",
    description:
      "Price the size grid, and review required vaccines and setup, cleanup and travel minutes. New clients are quoted these prices. Clients book inside the service area you set here.",
    to: "/setup",
    cta: "Review grooming setup",
    gate: "/settings/services",
  },
  training: {
    label: "Price your lessons",
    description:
      "Price your lesson package, turn it on, and add the skills a trainer scores. New clients are quoted these prices. Clients book inside the service area you set here.",
    to: "/setup",
    cta: "Price lessons",
    gate: "/settings/services",
  },
};

const PART_OF: Record<string, keyof typeof PART> = {
  pet_sitting: "stays",
  mobile_grooming: "grooms",
  training: "lessons",
};

/** The price step for a business running these of the three lines, as the
 *  server words it with #958 merged: the service area is a part, first, and
 *  a one-line business keeps its line's wording with the area beside it. */
function zonesStep(lines: string[]) {
  const parts = [SERVICE_AREA_PART, ...lines.map((l) => ({ ...PART[PART_OF[l]], done: false }))];
  if (lines.length === 1) return { ...ONE_LINE[lines[0]], done: false, parts };
  const nouns = lines.map(
    (l) => ({ pet_sitting: "stays", mobile_grooming: "grooms", training: "lessons" })[l],
  );
  const list = `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
  return {
    label: "Price your services",
    description: `You run ${lines.length} services. Set your service area, and a price for each: ${list}. New clients are quoted these prices.`,
    done: false,
    to: "/setup",
    cta: "Set your prices",
    gate: "/settings/services",
    parts,
  };
}

/** installStubBackend overrides for /setup?step=zones at such a business.
 *  `skills` false leaves the trainer with none, so the form asks for one. */
export function setupLinePriceOverrides(lines: string[], opts: { skills?: boolean } = {}) {
  const onboarding = BASE_STUBS.getOnboardingStatus as {
    steps: Array<Record<string, unknown>>;
  };
  const services = [
    ...(lines.includes("pet_sitting") ? SETUP_STAYS : []),
    ...(lines.includes("mobile_grooming") ? SETUP_GROOMS : []),
    ...(lines.includes("training") ? SETUP_LESSONS : []),
  ];
  return {
    getOnboardingStatus: {
      ...onboarding,
      completed: 1,
      steps: onboarding.steps.map((s, i) =>
        s.id === "zones" ? { ...s, ...zonesStep(lines) } : { ...s, done: i === 0 },
      ),
    },
    listServices: { services },
    getVaccineSettings: {
      enabled: true,
      rule: "warn",
      required: ["rabies", "dhpp"],
      today: fx.TODAY,
      bufferMin: 15,
    },
    listServiceSizeRules: { rules: [] },
    ensureTrainingCatalog: { ok: true },
    listServicePackages: {
      packages: [
        {
          id: id("c957"),
          organization_id: fx.ORG_ID,
          service_id: SETUP_LESSONS[0].id,
          name: "6-session package",
          sessions_count: 6,
          price_cents: 0,
          expires_after_days: 90,
          active: false,
        },
      ],
    },
    listTrainingSkills: {
      skills:
        opts.skills === false
          ? []
          : [
              { id: id("c958"), name: "Sit", sort_order: 0, active: true },
              {
                id: id("c959"),
                name: "Loose-leash walking past the neighbour's very loud terrier",
                sort_order: 1,
                active: true,
              },
            ],
    },
  };
}
