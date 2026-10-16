// The client page a tech opens from a stop's "Client info" speaks the tech's
// language, and reads right to left in Arabic.
//
// It was written in English straight into the route ("Back to My Day",
// "Gate:", "Hazards:", "Dogs (2)") and printed a dog's size and temperament
// as stored, so a tech who picked Español read "large · friendly" under a
// Spanish tab bar. It is now components/client-detail/FieldClientView.tsx,
// on the TECH_SCREENS list, so the static rules cover its source; this renders
// it, which is what proves each key has an answer in each language and that
// the stored codes come out as words.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string }) =>
    createElement("a", { href: to, ...rest }, children),
}));
vi.mock("@/lib/page-title", () => ({
  pageTitle: (a: string, b: string) => `${a} · ${b}`,
  useDocumentTitle: () => {},
}));

import i18n from "@/lib/i18n";
import { FieldClientView } from "@/components/client-detail/FieldClientView";

const PROPERTY = {
  id: "p-1",
  street: "1418 W Wolfram St",
  label: null,
  city: "Chicago",
  region: "IL",
  postal_code: "60657",
  gate_code: "*5521#",
  lock_box_code: "0420",
  key_location: "Under the planter by the side gate.",
  parking_notes: "Alley behind the garage.",
  access_notes: "Side gate sticks.",
  hazard_notes: "Loose paving slab by the back step.",
  aggressive_dog: true,
  dog_in_yard_during_service: false,
  escape_risk: true,
  invisible_fence: false,
  bees_wasps: false,
  sharp_objects: false,
  slippery_surfaces: false,
  do_not_enter_if_dog_out: false,
};

const DOGS = [
  {
    id: "d-1",
    property_id: "p-1",
    name: "Bartholomew",
    breed: "Labrador",
    weight_class: "large",
    temperament: "friendly",
    notes: "Brings you a ball.",
  },
  {
    id: "d-2",
    property_id: "p-1",
    name: "Tank",
    breed: null,
    // Free text from an import, shown as the office wrote it.
    weight_class: "about 40 lb",
    temperament: "aggressive",
    notes: null,
  },
];

/** The office's and the client's own words, which stay as written. */
const AS_WRITTEN = [
  "Anastasia Vandermolen-Whitaker",
  "Back door only.",
  "1418 W Wolfram St",
  "Chicago IL",
  "Under the planter by the side gate.",
  "Alley behind the garage.",
  "Side gate sticks.",
  "Loose paving slab by the back step.",
  "Bartholomew",
  "Labrador",
  "Brings you a ball.",
  "Tank",
  "about 40 lb",
];

async function render(lng: string) {
  await i18n.changeLanguage(lng);
  const html = renderToStaticMarkup(
    createElement(FieldClientView, {
      client: {
        display_name: "Anastasia Vandermolen-Whitaker",
        primary_phone: "+1 (312) 555-0142",
        notes: "Back door only.",
      },
      properties: [PROPERTY],
      dogs: DOGS,
    }),
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

describe("the client page a tech opens from My Day", () => {
  it("reads as it always did in English", async () => {
    const { text } = await render("en");
    expect(text).toContain("Back to My Day");
    expect(text).toContain("Gate: *5521#");
    expect(text).toContain("Lock box: 0420");
    expect(text).toContain("Hazards: Aggressive dog, Escape risk: close gate immediately");
    expect(text).toContain("Dogs (2)");
    expect(text).toContain("Labrador · large · friendly");
    expect(text).toContain("about 40 lb · aggressive");
  });

  it("puts a size and a temperament into words, never the stored code", async () => {
    const es = (await render("es")).text;
    expect(es).toContain("Labrador · grande · amigable");
    expect(es).toContain("about 40 lb · agresivo");
    expect(es).toContain("Perros (2)");
    expect(es).toContain("Portón: *5521#");
    expect(es).not.toMatch(/\blarge\b|\bfriendly\b/);

    const zh = (await render("zh")).text;
    expect(zh).toContain("大型");
    expect(zh).toContain("友好");
  });

  it("keeps codes and the phone number left to right in Arabic", async () => {
    const { html, text } = await render("ar");
    expect(root.get("dir")).toBe("rtl");
    expect(text).toContain("البوابة:");
    expect(text).toContain("الكلاب (2)");
    expect(text).toContain("كبير"); // large
    expect(text).toContain("ودود"); // friendly
    expect(html).toContain('<span dir="ltr" class="font-mono">*5521#</span>');
    expect(html).toContain('<span dir="ltr" class="font-mono">0420</span>');
    expect(html).toContain('<span dir="ltr">+1 (312) 555-0142</span>');
    // The office's words keep their own direction inside the Arabic line.
    expect(html).toContain("<bdi>Under the planter by the side gate.</bdi>");
  });

  // Arabic and Chinese only: any Latin word left on those pages is English
  // that escaped, which is not a test Spanish can be put to.
  for (const lng of ["ar", "zh"]) {
    it(`leaves no English on the page (${lng})`, async () => {
      const { text } = await render(lng);
      let rest = text;
      for (const w of AS_WRITTEN) rest = rest.split(w).join(" ");
      const english = [...new Set(rest.match(/[A-Za-z][A-Za-z'’-]+/g) ?? [])];
      expect(english, `English on the client page in ${lng}`).toEqual([]);
    });
  }

  it("carries no physical-direction utility", async () => {
    const { html } = await render("ar");
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
    const physical = classes.filter((c) =>
      /^-?(ml|mr|pl|pr|left|right)-|^text-(left|right)$|^(rounded-(l|r)|border-(l|r))(-|$)/.test(
        c.split(":").pop() ?? "",
      ),
    );
    expect(physical).toEqual([]);
    expect(classes.length, "classes were read").toBeGreaterThan(10);
  });
});
