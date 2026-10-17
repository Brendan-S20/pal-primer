// A walk's card in Arabic and Chinese (#410): the parts WalkParts.tsx adds to
// My Day, rendered, with no physical-direction utility and no English left on
// them. The same checks tests/my-day-in-arabic-reads-right-to-left.test.tsx
// makes of the page, made of every part a walk draws, because that page's
// fixture has no walk on it.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-start", () => ({
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

import i18n from "@/lib/i18n";
import {
  WalkAccess,
  WalkMeta,
  WalkReportFields,
  WalkTimer,
  type WalkReportState,
} from "@/components/my-day/WalkParts";

const walkService = { service_line: "dog_walking", default_duration_min: 30 };
const day = [
  {
    id: "w1",
    sequence: 1,
    status: "completed",
    walk_group_id: "g1",
    services: walkService,
    properties: { street: "1418 W Wolfram St", dogs: [{ name: "Bartholomew" }] },
  },
  {
    id: "w2",
    sequence: 2,
    status: "in_progress",
    walk_group_id: "g1",
    services: walkService,
    properties: { street: "2201 N Clybourn Ave", dogs: [{ name: "Tank" }] },
  },
];

const report = (over: Partial<WalkReportState> = {}): WalkReportState => ({
  pee: true,
  poo: null,
  note: "",
  setPee: () => {},
  setPoo: () => {},
  setNote: () => {},
  send: async () => ({ queued: false, sent: false }),
  reset: () => {},
  ...over,
});

/** The customer's and the office's own words, which stay as written. */
const NOT_ENGLISH = ["Bartholomew", "Tank", "1418 W Wolfram St", "2201 N Clybourn Ave", "K-12"];

async function render(lng: string) {
  await i18n.changeLanguage(lng);
  const parts: ReactNode[] = [
    createElement(WalkMeta, { visit: day[1], dayVisits: day }),
    createElement(WalkAccess, {
      property: { access_method: "lockbox", key_held: true, key_tag: "K-12" },
    }),
    createElement(WalkAccess, { property: { access_method: "person_home", key_held: true } }),
    createElement(WalkTimer, { startedAt: new Date(Date.now() - 22 * 60_000).toISOString() }),
    createElement(WalkReportFields, { visitId: "w2", report: report() }),
  ];
  const html = renderToStaticMarkup(createElement("div", null, ...parts));
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[⁦-⁩]/g, " ")
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

describe("a walk's card", () => {
  it("draws every part, in English", async () => {
    const { text } = await render("en");
    for (const s of [
      "30 min walk",
      "Group walk",
      "Pickup order",
      "This stop",
      "How you get in",
      "Lock box",
      "Someone is home",
      "Office holds the key, tag",
      "K-12",
      "Office holds the key",
      "Out 22 min",
      "Walk report",
      "Pee",
      "Poo",
      "Note for the client",
    ]) {
      expect(text, s).toContain(s);
    }
    // Pickup order is route order.
    expect(text.indexOf("Bartholomew")).toBeLessThan(text.indexOf("Tank"));
  });

  for (const lng of ["ar", "zh"]) {
    it(`leaves no English on it (${lng})`, async () => {
      const { text } = await render(lng);
      let rest = text;
      for (const w of NOT_ENGLISH) rest = rest.split(w).join(" ");
      const english = [...new Set(rest.match(/[A-Za-z][A-Za-z'’-]+/g) ?? [])];
      expect(english, `English on a walk card in ${lng}`).toEqual([]);
      expect(text).toContain("K-12");
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
    expect(classes.length, "classes were read").toBeGreaterThan(20);
  });

  it("gives every yes/no a 44px target and marks the chosen one", async () => {
    const { html } = await render("en");
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b).toMatch(/min-h-11/);
    expect(buttons.filter((b) => /aria-pressed="true"/.test(b))).toHaveLength(1);
  });

  it("draws nothing for a stop with no walk facts", async () => {
    await i18n.changeLanguage("en");
    const empty = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(WalkAccess, { property: { access_method: null, key_held: false } }),
        createElement(WalkMeta, {
          visit: { id: "x", services: { service_line: "dog_walking" } },
          dayVisits: [],
        }),
      ),
    );
    expect(empty).toBe("<div></div>");
  });
});
