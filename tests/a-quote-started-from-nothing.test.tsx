// A quote started from nothing.
//
// Owner, 2026-10-01: "there's too many forms, for example; quotes, I'm not
// sure why zone pricing or base pricing isn't already pre-inputted or have
// them available as an option."
//
// The editor is RENDERED here, not read: the claim is about what the owner
// sees when the quote opens, so the test is the markup. The server functions
// are replaced with stubs (the editor only calls them through react-query,
// and the cache is seeded the way a real fetch would fill it); everything
// else -- the pricing rules, the zone match, the line card -- is the real code.
//
// Three cases the owner can be in, each pinned:
//   - the person has an address in a priced zone: the per-visit line opens at
//     that zone's price, saying "Priced from <zone>";
//   - no zone matches (or the zone has no price): the standard price, saying
//     "Priced from your standard pricing";
//   - nothing set at all: a blank line, no invented number.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/lib/clients.functions", () => ({ listClients: vi.fn(), searchClients: vi.fn() }));
vi.mock("@/lib/quotes.functions", () => ({ saveQuoteDraft: vi.fn(), sendQuote: vi.fn() }));
vi.mock("@/lib/first-cleanup.functions", () => ({ getFirstCleanupPricing: vi.fn() }));
vi.mock("@/lib/quote-pricing.functions", () => ({ getQuotePricing: vi.fn() }));

import {
  QuoteEditor,
  blankEditorLine,
  isBlankLine,
  prefillServiceLine,
  quotePricingKey,
  type QuoteEditorValues,
  type QuotePricingData,
} from "@/components/quotes/QuoteEditor";
import {
  pricingChoices,
  suggestedServicePrice,
  type QuotePricingZone,
  type QuoteStandardPricing,
} from "@/lib/quote-pricing";

const CLIENT = "c0000000-0000-4000-8000-000000000001";

const CENTRAL: QuotePricingZone = {
  id: "z0000000-0000-4000-8000-0000000000a1",
  name: "Central Austin",
  zip_codes: ["78701", "78702"],
  geo_match_mode: "zip",
  base_price_cents: 2800,
  per_dog_addl_cents: 600,
  pricing_mode: "flat",
};
const NORTH: QuotePricingZone = {
  id: "z0000000-0000-4000-8000-0000000000a2",
  name: "North Loop",
  zip_codes: ["78751"],
  geo_match_mode: "zip",
  base_price_cents: 3200,
  per_dog_addl_cents: 500,
  pricing_mode: "flat",
};
// A zone with coverage but no price of its own.
const UNPRICED: QuotePricingZone = {
  id: "z0000000-0000-4000-8000-0000000000a3",
  name: "Hill Country",
  zip_codes: ["78620"],
  geo_match_mode: "zip",
  base_price_cents: 0,
  per_dog_addl_cents: 0,
  pricing_mode: "flat",
};
const STANDARD: QuoteStandardPricing = {
  basePriceCents: 2500,
  perDogAddlCents: 500,
  frequencyMultipliers: { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 },
};

const VALUES: QuoteEditorValues = {
  mode: "client",
  clientId: CLIENT,
  prospectName: "",
  prospectEmail: "",
  prospectPhone: "",
  leadId: null,
  title: "",
  message: "",
  validUntil: "2026-10-31",
  deposit: "",
  lines: [blankEditorLine(true)],
};

function render(pricing: QuotePricingData | null, values: QuoteEditorValues = VALUES) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["first-cleanup-pricing"], { pricing: null, zones: [] });
  // The editor reads the client it opens holding by id (searchClients), not
  // the roster.
  qc.setQueryData(["client-search", "id", CLIENT], {
    clients: [
      {
        id: CLIENT,
        display_name: "Marisol Whitfield-Ramirez",
        active: true,
        primary_email: null,
        primary_phone: null,
        street: null,
      },
    ],
  });
  if (pricing) qc.setQueryData(quotePricingKey(CLIENT, null), pricing);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <QuoteEditor initial={values} today="2026-10-01" onSaved={() => {}} />
    </QueryClientProvider>,
  );
}

/** The value attribute of an input, by id prefix and suffix. */
function inputValue(html: string, suffix: string): string | null {
  const m = new RegExp(`<input[^>]*id="line-\\d+-${suffix}"[^>]*>`).exec(html);
  if (!m) return null;
  return /value="([^"]*)"/.exec(m[0])?.[1] ?? null;
}

describe("a new quote opens priced", () => {
  it("from the client's zone, and says so", () => {
    const html = render({
      zones: [CENTRAL, NORTH],
      standard: STANDARD,
      subject: { zoneId: CENTRAL.id, postalCode: "78701", dogCount: 2, frequency: "weekly" },
    });
    expect(inputValue(html, "desc")).toBe("Weekly visit, 2 dogs");
    expect(inputValue(html, "price")).toBe("34.00"); // 28 + 6 for the second dog
    expect(html).toContain("Priced from Central Austin.");
    expect(html).toContain("$28.00 base + $6.00 for 1 dog more");
    // Editable, like any line: a plain input, not text.
    expect(html).toMatch(/<input[^>]*id="line-\d+-price"(?![^>]*readonly)(?![^>]*disabled)[^>]*>/);
  });

  it("from the ZIP when the property was never matched, by the zone matcher's rules", () => {
    const html = render({
      zones: [CENTRAL, NORTH],
      standard: STANDARD,
      subject: { postalCode: "78751", dogCount: 1, frequency: "biweekly" },
    });
    expect(inputValue(html, "desc")).toBe("Every-2-weeks visit, 1 dog");
    expect(inputValue(html, "price")).toBe("54.40"); // 32.00 x 1.7
    expect(html).toContain("Priced from North Loop.");
  });

  it("from the standard price when no zone matches", () => {
    const html = render({
      zones: [CENTRAL, NORTH],
      standard: STANDARD,
      subject: { postalCode: "90210", dogCount: 3 },
    });
    expect(inputValue(html, "price")).toBe("35.00"); // 25 + 2 x 5
    expect(html).toContain("Priced from your standard pricing.");
  });

  it("from the standard price when the matched zone has no price of its own", () => {
    const html = render({
      zones: [UNPRICED],
      standard: STANDARD,
      subject: { zoneId: UNPRICED.id, dogCount: 1 },
    });
    expect(inputValue(html, "price")).toBe("25.00");
    expect(html).toContain("Priced from your standard pricing.");
    expect(html).not.toContain("Hill Country");
  });

  it("not at all when nothing is set: a blank line, no invented number", () => {
    const html = render({
      zones: [UNPRICED],
      standard: { basePriceCents: null, perDogAddlCents: null, frequencyMultipliers: {} },
      subject: { postalCode: "78620", dogCount: 2 },
    });
    expect(inputValue(html, "price")).toBe("");
    expect(inputValue(html, "desc")).toBe("");
    expect(html).not.toContain("Priced from");
  });

  it("offers the picker for a quote with no address to go on", () => {
    const html = render({ zones: [CENTRAL], standard: STANDARD, subject: null });
    expect(inputValue(html, "price")).toBe("");
    expect(html).toContain("Add service from pricing");
  });

  it("ends the unmeasured yard pricing note with one period", () => {
    const html = render({
      zones: [{ ...CENTRAL, pricing_mode: "area" }],
      standard: STANDARD,
      subject: { zoneId: CENTRAL.id, dogCount: 1 },
    });
    expect(html).toContain("without the area charge.</span>");
    expect(html).not.toContain("area charge..");
  });

  it("starts with one line and keeps the optional extras one tap away", () => {
    const html = render(null);
    expect(html.match(/id="line-\d+-desc"/g)).toHaveLength(1);
    expect(html).toContain("Ask for a deposit");
    // CHANGED 2026-10-02: staff copy says "client" for the person who pays
    // (tests/one-word-for-the-person-who-pays.test.ts).
    expect(html).toContain("Add a note to the client");
    expect(html).not.toContain('id="quote-deposit"');
    expect(html).not.toContain('id="quote-message"');
  });

  it("but a draft that already has a deposit and a note shows them", () => {
    const html = render(null, { ...VALUES, deposit: "50", message: "See you Tuesday" });
    expect(html).toContain('id="quote-deposit"');
    expect(html).toContain("See you Tuesday");
  });
});

describe("the prefill never takes what somebody typed", () => {
  const pricing: QuotePricingData = {
    zones: [CENTRAL],
    standard: STANDARD,
    subject: { zoneId: CENTRAL.id, dogCount: 1 },
  };

  it("leaves a typed line alone", () => {
    const typed = {
      ...blankEditorLine(true),
      description: "Weekly, gate on the left",
      price: "40",
    };
    const out = prefillServiceLine({ ...VALUES, lines: [typed] }, pricing);
    expect(out.lines).toEqual([typed]);
  });

  it("re-prices its own untouched line for a different client, and blanks it for nobody", () => {
    const first = prefillServiceLine(VALUES, pricing);
    expect(first.lines[0].price).toBe("28.00");
    const other = prefillServiceLine(first, {
      ...pricing,
      subject: { postalCode: "90210", dogCount: 1 },
    });
    expect(other.lines[0].price).toBe("25.00");
    expect(other.lines[0].key).toBe(first.lines[0].key);
    const none = prefillServiceLine(other, { ...pricing, subject: null });
    expect(isBlankLine(none.lines[0])).toBe(true);
  });

  it("once edited, the line is the owner's", () => {
    const first = prefillServiceLine(VALUES, pricing);
    const edited = { ...first, lines: [{ ...first.lines[0], price: "30.00" }] };
    const again = prefillServiceLine(edited, { ...pricing, subject: { postalCode: "90210" } });
    expect(again.lines[0].price).toBe("30.00");
  });
});

describe("the picker lists every price the owner set", () => {
  it("matched zone first, then standard, then the other zones; unpriced zones left out", () => {
    const choices = pricingChoices([CENTRAL, NORTH, UNPRICED], STANDARD, {
      postalCode: "78751",
      dogCount: 1,
    });
    expect(choices.map((c) => c.label)).toEqual([
      "North Loop",
      "Standard pricing",
      "Central Austin",
    ]);
  });

  it("prices a commercial account from commercial rates, and never from the per-dog standard", () => {
    const hoa: QuotePricingZone = {
      ...CENTRAL,
      commercial_base_cents: 10000,
      commercial_per_unit_cents: 350,
    };
    const c = suggestedServicePrice([hoa], STANDARD, {
      zoneId: hoa.id,
      accountType: "commercial",
      unitCount: 40,
    });
    expect(c?.priceCents).toBe(10000 + 40 * 350);
    expect(c?.description).toBe("Weekly visit, 40 units");
    expect(suggestedServicePrice([], STANDARD, { accountType: "commercial" })).toBeNull();
  });
});
