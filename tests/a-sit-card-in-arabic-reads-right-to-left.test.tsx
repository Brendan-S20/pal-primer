// A pet sitting visit's card in Arabic and Chinese (#411): the parts
// SitParts.tsx adds to My Day, rendered, with no physical-direction utility
// and no English left on them. The same checks
// tests/a-walk-card-in-arabic-reads-right-to-left.test.tsx makes of a walk.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createServerOnlyFn: (fn: unknown) => fn,
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

import i18n from "@/lib/i18n";
import {
  SitCareLog,
  SitMeta,
  SitNoteField,
  SitPetsCare,
  sitStepLabel,
  type SitCareState,
} from "@/components/my-day/SitParts";
import type { WalkReportState } from "@/components/my-day/WalkParts";
import { sitPets, type CareEntry, type SitFacts } from "@/lib/sit-day";

const facts = (over: Partial<SitFacts> = {}): SitFacts => ({
  visit_id: "s1",
  stay_id: "stay-1",
  kind: "drop_in",
  starts_on: "2026-10-19",
  ends_on: "2026-10-23",
  pet_ids: ["luna", "max"],
  visit_number: 3,
  visit_total: 10,
  window_earliest: "07:30:00",
  window_latest: "09:30:00",
  ...over,
});

const DOGS = [
  {
    id: "luna",
    name: "Luna",
    species: "cat",
    active: true,
    pet_care_instructions: {
      feeding: "Half a can",
      meds: [{ name: "Insulin", dose: "2 units", times: ["08:00"], notes: "With food" }],
      other_care: "Brush her",
    },
  },
  {
    id: "max",
    name: "Max",
    species: "dog",
    active: true,
    pet_care_instructions: {
      feeding: null,
      meds: [{ name: "Apoquel", dose: null, times: ["20:00"], notes: null }],
      other_care: null,
    },
  },
  { id: "old", name: "Ghost", species: "dog", active: false },
];

const visit = { id: "s1", sit_facts: facts(), properties: { dogs: DOGS } };
const pets = sitPets(DOGS, visit.sit_facts);

const ENTRIES: CareEntry[] = [
  {
    id: "e1",
    pet_id: "luna",
    kind: "feed",
    med_name: null,
    status: "done",
    missed_reason: null,
    at: "2026-10-19T13:05:00Z",
    given_by_name: "Taylor Brooks",
  },
  {
    id: "e2",
    pet_id: "max",
    kind: "water",
    med_name: null,
    status: "done",
    missed_reason: null,
    at: "2026-10-19T13:06:00Z",
  },
];

const care = (over: Partial<SitCareState> = {}): SitCareState => ({
  entries: ENTRIES,
  sessionIds: new Set(["e2"]),
  log: async () => ({ queued: false }),
  undo: async () => {},
  hasQueued: async () => false,
  ...over,
});

const report: WalkReportState = {
  pee: null,
  poo: null,
  note: "",
  setPee: () => {},
  setPoo: () => {},
  setNote: () => {},
  send: async () => ({ queued: false, sent: false }),
  reset: () => {},
};

/** The customer's and the office's own words, which stay as written. */
const NOT_ENGLISH = [
  "Taylor Brooks",
  "Half a can",
  "With food",
  "Brush her",
  "2 units",
  "Insulin",
  "Apoquel",
  "Luna",
  "Max",
];

const LOCALE: Record<string, string> = { en: "en-US", ar: "ar", zh: "zh-CN" };

async function render(lng: string, careState = care()) {
  await i18n.changeLanguage(lng);
  const locale = LOCALE[lng];
  const parts: ReactNode[] = [
    createElement(SitMeta, { visit, locale }),
    createElement(SitMeta, {
      visit: { ...visit, sit_facts: facts({ kind: "overnight", visit_number: 2, visit_total: 5 }) },
      locale,
    }),
    createElement(SitPetsCare, { pets, locale }),
    createElement(SitCareLog, { visit, pets, care: careState, tz: "America/Chicago", locale }),
    createElement(SitNoteField, { visitId: "s1", report }),
  ];
  const html = renderToStaticMarkup(createElement("div", null, ...parts));
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    // The isolates around a name in a sentence ("Luna's insulin") are not
    // spaces.
    .replace(/[⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { html, text };
}

const root = new Map<string, string>([["lang", "en"]]);
beforeAll(() => {
  vi.stubGlobal("document", {
    documentElement: {
      getAttribute: (k: string) => root.get(k) ?? null,
      setAttribute: (k: string, v: string) => void root.set(k, v),
    },
  });
});
afterAll(async () => {
  await i18n.changeLanguage("en");
  vi.unstubAllGlobals();
});

const PHYSICAL =
  /^-?(ml|mr|pl|pr|left|right)-|^text-(left|right)$|^(rounded-(l|r|tl|tr|bl|br)|border-(l|r))(-|$)/;

describe("a pet sitting visit's card", () => {
  it("draws the stay, the pets' care and the care log, in English", async () => {
    const { text } = await render("en");
    for (const s of [
      "Drop-in",
      "Visit 3 of 10",
      "Overnight",
      "Night 2 of 5",
      "Check-in",
      "Cat",
      "Dog",
      "Feeding",
      "Half a can",
      "Insulin",
      "2 units",
      "Care log",
      "Fed",
      "Water",
      "Litter or yard",
      "Walked",
      "Given",
      "Missed",
      "Taylor Brooks",
      "You",
      "Undo",
      "Before you finish",
      "Luna's Insulin is not logged",
      "Note for the client",
    ]) {
      expect(text, s).toContain(s);
    }
    // The stay names two pets; the inactive one is not drawn.
    expect(text).not.toContain("Ghost");
    // Apoquel is due at 8pm, not at this 7:30 to 9:30 visit.
    expect(text).not.toContain("Apoquel is not logged");
  });

  it("offers a walk only for a dog", async () => {
    const { html } = await render("en");
    const logStart = html.indexOf("Care log");
    const luna = html.indexOf("Luna", logStart);
    const max = html.indexOf("Max", luna + 1);
    expect(html.slice(luna, max)).not.toContain("Walked");
    expect(html.slice(max)).toContain("Walked");
  });

  it("drops the warning once the dose is logged, given or missed", async () => {
    for (const status of ["done", "missed"] as const) {
      const { text } = await render(
        "en",
        care({
          entries: [
            ...ENTRIES,
            {
              id: "e3",
              pet_id: "luna",
              kind: "meds",
              med_name: "insulin",
              status,
              missed_reason: status === "missed" ? "Hid under the bed" : null,
              at: "2026-10-19T13:10:00Z",
            },
          ],
        }),
      );
      expect(text, status).not.toContain("Before you finish");
    }
  });

  it("says Start and End for a drop-in, Check in and out for an overnight", async () => {
    await i18n.changeLanguage("en");
    const t = i18n.t.bind(i18n) as any;
    expect(sitStepLabel(t, facts(), "start")).toBe("Start visit");
    expect(sitStepLabel(t, facts(), "end")).toBe("End visit");
    expect(sitStepLabel(t, facts({ kind: "overnight" }), "start")).toBe("Check in");
    expect(sitStepLabel(t, facts({ kind: "overnight" }), "end")).toBe("Check out");
    expect(sitStepLabel(t, null, "end")).toBe("End visit");
  });

  for (const lng of ["ar", "zh"]) {
    it(`leaves no English on it (${lng})`, async () => {
      const { text } = await render(lng);
      let rest = text;
      for (const w of NOT_ENGLISH) rest = rest.split(w).join(" ");
      const english = [...new Set(rest.match(/[A-Za-z][A-Za-z'’-]+/g) ?? [])];
      expect(english, `English on a sit card in ${lng}`).toEqual([]);
      expect(text).toContain("Insulin");
    });
  }

  it("carries no physical-direction utility", async () => {
    const { html } = await render("ar");
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
    const physical = classes.filter((c) => {
      const variants = c.split(":");
      const utility = variants.pop() ?? "";
      if (variants.includes("rtl") || variants.includes("ltr")) return false;
      return PHYSICAL.test(utility);
    });
    expect([...new Set(physical)]).toEqual([]);
    expect(classes.length, "classes were read").toBeGreaterThan(40);
  });

  it("gives every button a 44px target", async () => {
    const { html } = await render("en");
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    // Fed, Water, Litter for two pets, Walked for the dog, Given and Missed
    // for each med, and Undo for the entry tapped on this card.
    expect(buttons).toHaveLength(12);
    for (const b of buttons) expect(b).toMatch(/min-h-11/);
  });

  it("wraps what a person typed so it keeps its own direction", async () => {
    const { html } = await render("ar");
    for (const s of ["Luna", "Insulin", "2 units", "Half a can", "Taylor Brooks"])
      expect(html, s).toContain(`>${s}</bdi>`);
  });

  it("draws no stay line for a visit that is not part of a stay", async () => {
    await i18n.changeLanguage("en");
    const empty = renderToStaticMarkup(
      createElement("div", null, createElement(SitMeta, { visit: { id: "x", sit_facts: null } })),
    );
    expect(empty).toBe("<div></div>");
  });
});
