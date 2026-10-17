// My Day in Arabic, rendered: right to left, and no English left on it.
//
// The owner asked for Arabic and Chinese "if possible". Translating the
// strings is the half tests/en-and-es-have-the-same-keys.test.ts checks. This
// is the other half, and the half that is particular to Arabic: the page has
// to READ right to left, which is three separate things and each is checked
// here on the real page, not on a description of it.
//
//   1. <html dir="rtl" lang="ar">. lib/i18n sets both the moment the language
//      changes. Every logical utility (ms-, pe-, start-, text-start) and every
//      `rtl:` variant keys off that attribute, so without it nothing mirrors.
//   2. No physical-direction utility on the rendered page. `ml-2` is a gap on
//      the LEFT in every language; in Arabic the gap that was meant is on the
//      right. The rendered class attributes are scanned rather than the source,
//      so a class assembled at run time is seen too.
//   3. No English. The static rule (a-tech-screen-has-no-english-left-in-it)
//      proves every literal goes through t(); this proves the Arabic file has
//      an answer for every key the page actually asked for, because a missing
//      one falls back to English and looks exactly like a translated page with
//      one English sentence on it.
//
// The page is the real route component, rendered to markup with its server
// functions stubbed and the day's data seeded into the query cache the way a
// fetch would fill it — the same approach as a-quote-started-from-nothing.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const DAY = "2026-10-06";

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
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({
    options: opts,
    useSearch: () => ({}),
    useNavigate: () => () => {},
  }),
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string }) =>
    createElement("a", { href: to, ...rest }, children),
  useNavigate: () => () => {},
  useRouterState: () => ({ location: { pathname: "/my-day" } }),
}));
vi.mock("@/hooks/useOrgToday", () => ({
  useOrgToday: () => DAY,
  useOrgTimezone: () => "America/Chicago",
}));
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ role: "tech", orgId: "org-1", loading: false }),
  usePermissions: () => ({ can: () => false }),
  canAccess: () => true,
}));
vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ docksFrom: "lg-mouse", isMobile: true, state: "expanded" }),
}));

import i18n, { applyDocumentLanguage } from "@/lib/i18n";
import { Route } from "@/routes/_authenticated/my-day";

/** One stop of each kind a technician's morning holds: a residential stop
 *  with dogs, hazards, a gate code and a balance due, and one in progress. */
function myDay() {
  const property = (over: Record<string, unknown>) => ({
    id: "p-" + Math.random().toString(36).slice(2, 8),
    street: "1418 W Wolfram St",
    city: "Chicago",
    postal_code: "60657",
    lat: 41.93,
    lng: -87.66,
    account_type: "residential",
    has_units: false,
    gate_code: "*5521#",
    lock_box_code: null,
    key_location: "Under the planter by the side gate.",
    yard_size: "medium",
    invisible_fence: true,
    escape_risk: true,
    dog_in_yard_during_service: false,
    aggressive_dog: true,
    bees_wasps: false,
    sharp_objects: false,
    slippery_surfaces: false,
    do_not_enter_if_dog_out: false,
    hazard_notes: "Loose paving slab by the back step.",
    dogs: [
      { name: "Bartholomew", temperament: "friendly" },
      { name: "Tank", temperament: "aggressive" },
    ],
    boundary: null,
    boundary_area_sqm: null,
    waste_stations: [],
    ...over,
  });
  const visit = (i: number, status: string, over: Record<string, unknown> = {}) => ({
    id: `v-${i}`,
    organization_id: "org-1",
    assigned_staff_id: "s-1",
    sequence: i,
    status,
    scheduled_on: DAY,
    eta_start: `${DAY}T14:15:00Z`,
    eta_end: `${DAY}T14:45:00Z`,
    earliest_time: null,
    latest_time: null,
    started_at: status === "in_progress" ? new Date(Date.now() - 22 * 60_000).toISOString() : null,
    completed_at: null,
    skipped_at: null,
    skip_reason: null,
    skip_reason_code: null,
    gate_reply: null,
    gate_reply_at: null,
    notes: null,
    visit_photos: [],
    zones: { name: "Lakeview East" },
    clients: {
      display_name: "Anastasia Vandermolen-Whitaker",
      primary_phone: "+1 (312) 555-0142",
      dna_compliance_enabled: false,
    },
    stop_facts: {
      dogCount: 2,
      autopay: false,
      cardOnFile: false,
      paysCashCheck: true,
      openBalanceCents: 5750,
      awaitingCents: 0,
    },
    properties: property({}),
    ...over,
  });
  return {
    staff: { id: "s-1", display_name: "Jordan Tech", organization_id: "org-1" },
    previewing: false,
    visits: [
      visit(1, "completed", { completed_at: `${DAY}T13:40:00Z` }),
      visit(2, "in_progress"),
      visit(3, "scheduled", {
        properties: property({ street: "2201 N Clybourn Ave", dogs: [], hazard_notes: null }),
        clients: {
          display_name: "Northbrook Homeowners Association #4471",
          primary_phone: null,
          dna_compliance_enabled: false,
        },
      }),
      // Skipped, with the office-facing reason and the tech's own words.
      visit(4, "skipped", {
        skipped_at: `${DAY}T15:05:00Z`,
        skip_reason_code: "gate_locked",
        skip_reason: "Padlock on the side gate.",
      }),
    ],
  };
}

/** Words that are the customer's, the office's or a product's, and stay as
 *  written in every language. Everything else in Latin script is English
 *  that escaped. */
const NOT_ENGLISH = [
  "Anastasia Vandermolen-Whitaker",
  "Northbrook Homeowners Association",
  "1418 W Wolfram St",
  "2201 N Clybourn Ave",
  "Chicago",
  "Lakeview East",
  "Under the planter by the side gate.",
  "Loose paving slab by the back step.",
  "Padlock on the side gate.",
  "Bartholomew",
  "Tank",
  "US$", // Intl's own currency symbol in Arabic
];

async function render(lng: string) {
  await i18n.changeLanguage(lng);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["my-day", DAY, ""], myDay());
  const MyDay = (Route as unknown as { options: { component: () => ReactNode } }).options.component;
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MyDay)),
  );
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { html, text };
}

/** A minimal <html> for lib/i18n to write to: this suite runs in Node, with
 *  no DOM, and what is under test is the two attributes, not a browser. */
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

/** A utility that names a side of the SCREEN rather than of the text. */
const PHYSICAL =
  /^-?(ml|mr|pl|pr|left|right)-|^text-(left|right)$|^(rounded-(l|r|tl|tr|bl|br)|border-(l|r))(-|$)/;

describe("My Day in Arabic", () => {
  it("turns the document right to left, and back", async () => {
    await i18n.changeLanguage("ar");
    expect(root.get("dir")).toBe("rtl");
    expect(root.get("lang")).toBe("ar");
    await i18n.changeLanguage("zh");
    expect(root.get("dir")).toBe("ltr");
    expect(root.get("lang")).toBe("zh-Hans");
    await i18n.changeLanguage("en");
    expect(root.get("dir")).toBe("ltr");
    expect(root.get("lang")).toBe("en");
    // A regional tag is the same language.
    applyDocumentLanguage("ar-EG");
    expect(root.get("dir")).toBe("rtl");
    applyDocumentLanguage("en-US");
    expect(root.get("dir")).toBe("ltr");
  });

  it("renders the day, in Arabic", async () => {
    const { text } = await render("ar");
    // Proof the page drew rather than an empty or loading state: the
    // heading, the fixture's own client, and a card's Arabic controls.
    expect(text).toContain("يومي");
    expect(text).toContain("Anastasia Vandermolen-Whitaker");
    expect(text).toContain("ملاحة"); // Navigate
    expect(text).toContain("خيارات أكثر"); // More options
    // Arabic agreement, chosen by i18next from Intl.PluralRules("ar"):
    // two dogs is the dual, not "2 dogs".
    expect(text).toContain("كلبان");
    // Money with Western digits, which the office's invoice also uses.
    expect(text).toMatch(/57\.50/);
    expect(text).not.toMatch(/[\u0660-\u0669]/); // no Arabic-Indic digits
  });

  for (const lng of ["ar", "zh"]) {
    it(`leaves no English on the page (${lng})`, async () => {
      const { text } = await render(lng);
      let rest = text;
      for (const w of NOT_ENGLISH) rest = rest.split(w).join(" ");
      const english = [...new Set(rest.match(/[A-Za-z][A-Za-z'’-]+/g) ?? [])].filter(
        // Abbreviations kept as they are in Arabic and Chinese usage.
        (w) => !["DNA", "SMS", "US"].includes(w),
      );
      expect(english, `English on My Day in ${lng}`).toEqual([]);
      // Not vacuous: the same page in English is full of it.
      const en = await render("en");
      expect(en.text).toContain("Navigate");
      expect(en.text).toContain("More options");
    });
  }

  it("renders the day in Chinese too, with a 12-hour clock", async () => {
    const { text } = await render("zh");
    expect(text).toContain("我的一天");
    expect(text).toContain("导航"); // Navigate
    expect(text).toContain("2 只狗");
    // The office's schedule says 9:15 AM; so does the Chinese card.
    expect(text).toMatch(/上午9:15/);
  });

  it("carries no physical-direction utility", async () => {
    const { html } = await render("ar");
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
    // `left-1/2` with `-translate-x-1/2` CENTRES something, which is the same
    // in both directions, so it is not a finding; neither is a physical side
    // chosen per direction (`rtl:`/`ltr:` prefixed).
    const physical = classes.filter((c) => {
      const variants = c.split(":");
      const utility = variants.pop() ?? "";
      if (variants.includes("rtl") || variants.includes("ltr")) return false;
      if (/^-?left-1\/2$/.test(utility)) return false;
      // A side that pads by THAT side's safe-area inset is physical on
      // purpose: a notch is on the device's left or right whatever the
      // reading direction, so PageShell's gutter (and PAGE_BLEED_X, its exact
      // inverse) pairs pl- with safe-area-inset-left and pr- with -right.
      // Logical ps-/pe- would put the left inset on the right edge in Arabic.
      if (/^-?(p|m)l-\[.*safe-area-inset-left/.test(utility)) return false;
      if (/^-?(p|m)r-\[.*safe-area-inset-right/.test(utility)) return false;
      return PHYSICAL.test(utility);
    });
    expect([...new Set(physical)]).toEqual([]);
    expect(classes.length, "classes were read").toBeGreaterThan(200);
  });
});
