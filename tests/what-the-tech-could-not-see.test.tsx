// What the tech could not see.
//
// The owner, using the app as a technician on 2026-10-02: "There's no way to
// see the yard area/outline, nor see how many dogs. I am not able to tell if
// this means stations wouldn't be visible as well. There's nothing to indicate
// that they paid cash. For the technician, it doesn't make sense to have the
// optional buttons for Knowledge Center and Weather; those should be hidden
// and not present in the settings."
//
// Each of those, rendered: the stop card's pieces drawn to markup in both
// languages, from the same props My Day hands them, and the rules behind them
// (lib/stop-facts) on their own. The database half -- who may record cash and
// who may confirm it -- is tests/a-tech-records-cash-and-the-office-applies-it.

import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "../src/lib/i18n/locales/en";
import es from "../src/lib/i18n/locales/es";
import {
  DogsLine,
  PaymentLine,
  StationsSummary,
  YardOutline,
  CollectForm,
} from "../src/components/my-day/StopFacts";
import {
  activeStations,
  areaParts,
  collectionAmountProblem,
  dogsLine,
  dueCents,
  lastServicedByStation,
  newClientKey,
  outlinePath,
  parseDollars,
  paymentMode,
  stopFactsFromRow,
  type StopFacts,
} from "../src/lib/stop-facts";
import { defaultInvoiceSelection, selectionTotals } from "../src/lib/field-collections";
import { headerControlsForRole } from "../src/lib/header-prefs";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

/** The markup, in a language chosen per call: i18n is one instance, so a
 *  call that does not say which language would inherit the last one's. */
async function markup(el: ReactElement, lng: "en" | "es" = "en"): Promise<string> {
  await i18n.changeLanguage(lng);
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, el));
}

async function render(el: ReactElement, lng: "en" | "es" = "en"): Promise<string> {
  const html = await markup(el, lng);
  // Text only, entities decoded, whitespace collapsed: what a person reads.
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const FACTS: StopFacts = {
  dogCount: 2,
  autopay: false,
  cardOnFile: false,
  paysCashCheck: true,
  openBalanceCents: 4000,
  awaitingCents: 0,
};

// A 30 x 20 m yard in Chicago, closed ring.
const YARD = {
  type: "Polygon",
  coordinates: [
    [
      [-87.6483, 41.9217],
      [-87.64794, 41.9217],
      [-87.64794, 41.92188],
      [-87.6483, 41.92188],
      [-87.6483, 41.9217],
    ],
  ],
};

describe("the dogs line is never silent", () => {
  it("names the dogs from their records, aggressive ones in red", async () => {
    const dogs = [
      { name: "Max", temperament: "friendly" },
      { name: "Bella", temperament: "aggressive" },
    ];
    const text = await render(createElement(DogsLine, { dogs, dogCount: 5 }));
    expect(text).toContain("2 dogs");
    expect(text).toContain("Max");
    expect(text).toContain("Bella");
    expect(text).toContain("aggressive");
    // The records win over the priced count: five on the subscription and two
    // named is two dogs the tech can be told about by name.
    expect(text).not.toContain("5 dogs");
    const chips = (await markup(createElement(DogsLine, { dogs, dogCount: 5 }))).split(
      '<span class="inline-flex',
    );
    expect(chips.find((c) => c.includes(">Bella<"))).toMatch(/text-destructive/);
    expect(chips.find((c) => c.includes(">Max<"))).not.toMatch(/text-destructive/);
  });

  it("falls back to the subscription's count when no dog is on file", async () => {
    expect(await render(createElement(DogsLine, { dogs: [], dogCount: 2 }))).toBe(
      "2 dogs · names not on file",
    );
    expect(await render(createElement(DogsLine, { dogs: null, dogCount: 1 }))).toBe(
      "1 dog · name not on file",
    );
    expect(await render(createElement(DogsLine, { dogs: [], dogCount: 2 }), "es")).toBe(
      "2 perros · nombres no registrados",
    );
  });

  it("says there are none on file when there is neither", async () => {
    for (const dogCount of [null, undefined, 0]) {
      expect(await render(createElement(DogsLine, { dogs: [], dogCount }))).toBe("No dogs on file");
    }
    expect(await render(createElement(DogsLine, { dogs: [] }), "es")).toBe(
      "No hay perros registrados",
    );
  });

  it("is the rule, not the component, that decides", () => {
    expect(dogsLine([{ name: "A" }], 3)).toEqual({ kind: "named", dogs: [{ name: "A" }] });
    expect(dogsLine({ name: "Solo" }, null)).toMatchObject({ kind: "named" });
    expect(dogsLine([], 6)).toEqual({ kind: "count", count: 6 });
    expect(dogsLine(undefined, -1)).toEqual({ kind: "none" });
  });
});

describe("the yard outline, or plainly none", () => {
  it("draws the shape and its area, with no map until it is opened", async () => {
    const html = await markup(
      createElement(YardOutline, { boundary: YARD, areaSqm: 600, title: "412 Elm St" }),
    );
    expect(html).toMatch(/<svg[^>]*viewBox="0 0 56 56"/);
    expect(html).toMatch(/<path d="M[\d. L]+Z"/);
    expect(
      await render(createElement(YardOutline, { boundary: YARD, areaSqm: 600, title: "x" })),
    ).toContain("Property outline · 6,458 sq ft");
    // No Leaflet container on the card: the map is the dialog's, and lazy.
    expect(html).not.toMatch(/leaflet/i);
    expect(html).toMatch(/aria-label="Open the property outline on a map"/);
  });

  it("says so when nobody has sketched one, with no drawing and no map", async () => {
    for (const boundary of [
      null,
      undefined,
      { type: "Point", coordinates: [1, 2] },
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
    ]) {
      const html = await markup(createElement(YardOutline, { boundary, title: "x" }));
      expect(html).not.toMatch(/<svg[^>]*viewBox="0 0 56 56"/);
      expect(await render(createElement(YardOutline, { boundary, title: "x" }))).toBe(
        "No property outline yet",
      );
    }
    expect(await render(createElement(YardOutline, { boundary: null, title: "x" }), "es")).toBe(
      "Todavía no hay contorno de la propiedad",
    );
  });

  it("keeps a square yard square away from the equator, and north up", () => {
    const d = outlinePath(YARD, 56, 4)!;
    const pts = d
      .slice(1, -1)
      .split("L")
      .map((p) => p.split(" ").map(Number));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    // 0.00036 deg of longitude at 41.92N is ~29.8 m; 0.00018 deg of latitude
    // is ~20 m. So wider than tall by about 3:2, not the 2:1 of raw degrees.
    expect(w / h).toBeGreaterThan(1.4);
    expect(w / h).toBeLessThan(1.6);
    // The first point is the south-west corner: bottom-left in the drawing.
    expect(pts[0][1]).toBeGreaterThan(28);
  });

  it("quotes the area the way the office's sketch does", () => {
    expect(areaParts(600)).toEqual({ unit: "sqft", value: 6458 });
    expect(areaParts(5000)).toEqual({ unit: "acres", value: 1.24 });
    expect(areaParts(null)).toBeNull();
    expect(areaParts(0)).toBeNull();
  });
});

describe("a commercial stop's stations", () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({
    id: `s${i + 1}`,
    station_number: i + 1,
    label:
      i === 0 ? "Pool gate beside the clubhouse and the long walk to Building C" : `Bldg ${i + 1}`,
    sort_order: 9 - i,
    location_description: i === 0 ? "North fence" : null,
    active: true,
    last_serviced_on: i % 2 ? "2026-09-28" : null,
  }));

  it("counts them and lists the first few, with when each was last serviced", async () => {
    const text = await render(createElement(StationsSummary, { stations: nine }));
    expect(text).toContain("9 waste stations");
    expect(text).toContain("Show all 9");
    expect(text).toContain("Not serviced yet");
    expect(text).toContain("Last serviced");
    // In the office's order: sort_order first, so station 9 leads.
    expect(text.indexOf("Station 9")).toBeLessThan(text.indexOf("Station 8"));
    expect(await render(createElement(StationsSummary, { stations: nine }), "es")).toContain(
      "9 estaciones de desechos",
    );
  });

  it("leaves out inactive stations, and draws nothing for none", async () => {
    expect(activeStations([{ id: "a", active: false }, { id: "b" }]).map((s) => s.id)).toEqual([
      "b",
    ]);
    expect(await render(createElement(StationsSummary, { stations: [] }))).toBe("");
  });

  it("dates last service by the rule the office's panel uses", () => {
    expect(
      lastServicedByStation([
        {
          waste_station_id: "a",
          serviced_at: "2026-09-01T15:00:00Z",
          visits: { scheduled_on: "2026-08-31" },
        },
        { waste_station_id: "a", serviced_at: "2026-09-20T15:00:00Z", visits: null },
        { waste_station_id: "b", serviced_at: null, visits: [{ scheduled_on: "2026-09-02" }] },
      ]),
    ).toEqual({ a: "2026-09-20", b: "2026-09-02" });
    // And the office's list really does call it, rather than keeping a copy.
    expect(read("src/lib/stations.functions.ts")).toMatch(/lastServicedByStation\(/);
    expect(read("src/lib/my-day.functions.ts")).toMatch(/lastServicedByStation\(/);
  });
});

describe("how the customer pays, for the tech", () => {
  it("says autopay with a card on file", async () => {
    const f = {
      ...FACTS,
      autopay: true,
      cardOnFile: true,
      paysCashCheck: true,
      openBalanceCents: 0,
    };
    expect(await render(createElement(PaymentLine, { facts: f }))).toBe("Autopay · card on file");
  });

  it("says cash/check and what is due, with the button to record it", async () => {
    const text = await render(createElement(PaymentLine, { facts: FACTS, onCollect: () => {} }));
    expect(text).toContain("Pays cash/check");
    expect(text).toContain("$40.00 due");
    expect(text).toContain("Collected cash/check");
    expect(
      await render(createElement(PaymentLine, { facts: FACTS, locale: "es-US" }), "es"),
    ).toContain("Debe $40.00");
  });

  it("says invoiced, and offers no button when nothing is owed or nobody may record", async () => {
    const f = { ...FACTS, paysCashCheck: false, openBalanceCents: 0, hasInvoiceLine: true };
    expect(await render(createElement(PaymentLine, { facts: f, onCollect: () => {} }))).toBe(
      "Invoiced",
    );
    // A preview, or a dispatcher: owed, but no way to record from here.
    expect(await render(createElement(PaymentLine, { facts: FACTS }))).not.toContain(
      "Collected cash/check",
    );
  });

  it("counts what is already waiting against what is due", async () => {
    const f = { ...FACTS, awaitingCents: 1500 };
    const text = await render(createElement(PaymentLine, { facts: f, onCollect: () => {} }));
    expect(text).toContain("$25.00 due");
    expect(text).toContain("$15.00 collected · waiting for the office");
    const all = { ...FACTS, awaitingCents: 4000 };
    expect(
      await render(createElement(PaymentLine, { facts: all, onCollect: () => {} })),
    ).not.toContain("Collected cash/check");
  });

  it("autopay without a card is not autopay", () => {
    expect(paymentMode({ autopay: true, cardOnFile: false, paysCashCheck: false })).toBeNull();
    expect(paymentMode({ autopay: true, cardOnFile: false, paysCashCheck: true })).toBe(
      "cash_check",
    );
    expect(paymentMode({ autopay: true, cardOnFile: true, paysCashCheck: true })).toBe("autopay");
  });

  it("reads the RPC's row, bigint balances included", () => {
    expect(
      stopFactsFromRow({
        visit_id: "v",
        dog_count: null,
        autopay: null,
        card_on_file: true,
        pays_cash_check: false,
        open_balance_cents: "4000",
        awaiting_cents: null,
      }),
    ).toEqual({
      dogCount: null,
      autopay: false,
      cardOnFile: true,
      paysCashCheck: false,
      hasInvoiceLine: false,
      openBalanceCents: 4000,
      awaitingCents: 0,
    });
    expect(dueCents({ openBalanceCents: 1000, awaitingCents: 2500 })).toBe(0);
  });
});

describe("the collection form", () => {
  it("starts at what is owed, offers cash or a check, and says the office confirms", async () => {
    const text = await render(
      createElement(CollectForm, {
        idPrefix: "c",
        dueCents: 4000,
        pending: false,
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    expect(text).toContain("Record cash or a check");
    expect(text).toContain("Cash");
    expect(text).toContain("Check");
    expect(text).toContain("Invoices can't be marked paid from here");
    const html = await markup(
      createElement(CollectForm, {
        idPrefix: "c",
        dueCents: 4000,
        pending: false,
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
    expect(html).toMatch(/value="40\.00"/);
  });

  it("takes dollars as typed, and refuses nothing or more than is owed", () => {
    expect(parseDollars("40")).toBe(4000);
    expect(parseDollars("$1,040.5")).toBe(104050);
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(collectionAmountProblem(parseDollars("0"), 4000)).toBe("enterAmount");
    expect(collectionAmountProblem(parseDollars("40.01"), 4000)).toBe("moreThanDue");
    expect(collectionAmountProblem(parseDollars("25"), 4000)).toBeNull();
  });

  it("mints a fresh v4 key per collection", () => {
    const a = newClientKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newClientKey()).not.toBe(a);
  });
});

describe("the office applies whole invoices", () => {
  const invs = [
    { id: "a", open_cents: 2500 },
    { id: "b", open_cents: 3000 },
    { id: "c", open_cents: 1500 },
  ];
  it("proposes the oldest invoices that fit, skipping one that does not", () => {
    expect(defaultInvoiceSelection(invs, 4000)).toEqual(["a", "c"]);
    expect(defaultInvoiceSelection(invs, 1000)).toEqual([]);
    expect(selectionTotals(invs, ["a", "c"], 4000)).toEqual({
      appliedCents: 4000,
      unappliedCents: 0,
      overBy: 0,
    });
    expect(selectionTotals(invs, ["a", "b"], 4000).overBy).toBe(1500);
  });
});

describe("a technician's header has no Help or Weather, and no switch for them", () => {
  it("gives the office roles both and a tech neither", () => {
    for (const role of ["owner", "office_manager", "dispatcher"])
      expect(headerControlsForRole(role)).toEqual({ help: true, weather: true });
    expect(headerControlsForRole("tech")).toEqual({ help: false, weather: false });
    // Unknown while loading: off, so a tech's header never flashes them.
    expect(headerControlsForRole(null)).toEqual({ help: false, weather: false });
  });

  it("is asked by the header before the person's preference", () => {
    const shell = read("src/routes/_authenticated/route.tsx");
    expect(shell).toMatch(/headerControlsForRole\(role\)/);
    expect(shell).toMatch(/roleControls\.help && headerPrefs\.showHelp/);
    expect(shell).toMatch(/roleControls\.weather && headerPrefs\.showWeather/);
  });

  it("and by Preferences, which then draws no switch for a tech", () => {
    const prefs = read("src/routes/_authenticated/settings.preferences.tsx");
    const card = prefs.slice(prefs.indexOf("function AppearanceCard"));
    expect(card).toMatch(/headerControlsForRole\(role\)/);
    expect(card).toMatch(/roleControls\.help && \(\s*<label/);
    expect(card).toMatch(/roleControls\.weather && \(\s*<label/);
    expect(card).toMatch(/\(roleControls\.help \|\| roleControls\.weather\) && \(/);
  });
});

describe("the stop card draws all of it", () => {
  const myDay = read("src/routes/_authenticated/my-day.tsx");
  it("renders each piece from the day's data", () => {
    expect(myDay).toMatch(/<DogsLine dogs=\{p\?\.dogs\} dogCount=\{facts\?\.dogCount\} \/>/);
    expect(myDay).toMatch(/<YardOutline\s+boundary=\{p\?\.boundary\}/);
    expect(myDay).toMatch(/hasStations && <StationsSummary stations=\{p\?\.waste_stations\}/);
    expect(myDay).toMatch(/<PaymentLine/);
    // The old row that drew nothing without dog records is gone.
    expect(myDay).not.toMatch(/function DogsRow/);
  });

  it("records through the offline queue, with a key minted before the first attempt", () => {
    const block = myDay.slice(myDay.indexOf("const collect = useMutation"));
    const body = block.slice(0, block.indexOf("onSuccess"));
    expect(body).toMatch(/const clientKey = newClientKey\(\)/);
    expect(body).toMatch(/runOrQueue\(/);
    expect(body).toMatch(/kind: "collection"/);
    expect(body.indexOf("newClientKey()")).toBeLessThan(body.indexOf("runOrQueue("));
  });

  it("offers recording only to someone who may perform the visit", () => {
    expect(myDay).toMatch(/const mayCollect = canPerformVisit && inCollectWindow;/);
  });

  it("loads the outline and the stations with the day", () => {
    const fn = read("src/lib/my-day.functions.ts");
    expect(fn).toMatch(/boundary, boundary_area_sqm/);
    expect(fn).toMatch(/waste_stations\(id, label, station_number/);
    expect(fn).toMatch(/rpc\("my_day_stop_facts"/);
  });
});
