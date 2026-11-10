// R2-37 / D12 (Brendan, 2026-11-08): one-time cleanup pricing is the
// business's. The owner sets the visit price and the first-cleanup fee; the
// customer sees both lines and their sum before confirming; the card is
// charged that sum.
//
// What this file holds:
//   1. The visit price is the owner's extra-visit price when set, the zone's
//      one-visit price otherwise. No number in the code.
//   2. The total shown is the amount charged: oneTimeCleanupTotal and
//      signupChargeFromQuote agree on every case, at prices that are not the
//      $18 + $75 the audit suggested.
//   3. The booking link's price panel renders both lines and the total.
//   4. Both server paths (the quote and the PaymentIntent) price through the
//      same function, so the quote cannot show one number and charge another.
//   5. A quote for a one-time cleanup lists both lines, its One-time total is
//      their sum, and "Invoice the one-time charges" bills exactly those lines.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ONE_TIME_CLEANUP_COPY,
  asOneTimeCleanupQuote,
  isOneTimeCleanup,
  oneTimeCleanupQuoteLine,
  oneTimeCleanupTotal,
  oneTimeCleanupVisitCents,
} from "@/lib/one-time-cleanup";
import { signupChargeFromQuote } from "@/lib/signup-charge";
import { oneTimeInvoiceItems, quoteTotals } from "@/lib/quotes";
import { firstCleanupQuoteLine } from "@/lib/first-cleanup";
import { OneTimeCleanupPriceLines } from "@/components/signup/OneTimeCleanupPriceLines";
import { QuoteDocument } from "@/components/quotes/QuoteDocument";
import { quotedPublicService, type PublicService } from "@/lib/public-services";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/** A public_quote row, as the database returns it for a pet-waste service. */
function quoteRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    organization_id: "00000000-0000-4000-8000-000000000001",
    recurring_price_cents: 2000 as number | null,
    initial_cleanup_cents: 9500 as number | null,
    first_cleanup_mode: "flat" as string | null,
    first_cleanup_label: null as string | null,
    ...over,
  };
}

describe("the visit is priced by the owner", () => {
  it("uses the owner's extra-visit price when it is set", () => {
    expect(oneTimeCleanupVisitCents({ zoneVisitCents: 2000, oneOffPriceCents: 4000 })).toBe(4000);
  });

  it("falls back to the zone's one-visit price when it is blank", () => {
    expect(oneTimeCleanupVisitCents({ zoneVisitCents: 2000, oneOffPriceCents: null })).toBe(2000);
    expect(oneTimeCleanupVisitCents({ zoneVisitCents: 2000, oneOffPriceCents: undefined })).toBe(
      2000,
    );
  });

  it("takes a free visit as a price, and refuses a value nobody could have saved", () => {
    expect(oneTimeCleanupVisitCents({ zoneVisitCents: 2000, oneOffPriceCents: 0 })).toBe(0);
    for (const bad of [-1, 12.5, 1_000_001, Number.NaN]) {
      expect(oneTimeCleanupVisitCents({ zoneVisitCents: 2000, oneOffPriceCents: bad })).toBe(2000);
    }
  });

  it("reprices only the visit: the first cleanup is public_quote's, untouched", () => {
    const q = asOneTimeCleanupQuote(quoteRow(), 4000);
    expect(q.recurring_price_cents).toBe(4000);
    expect(q.initial_cleanup_cents).toBe(9500);
    expect(q.first_cleanup_mode).toBe("flat");
  });

  it("is a one-time cleanup only for pet waste sold as one visit", () => {
    expect(isOneTimeCleanup("one_time", { service_line: "pet_waste" })).toBe(true);
    expect(isOneTimeCleanup("recurring", { service_line: "pet_waste" })).toBe(false);
    expect(isOneTimeCleanup("one_time", { service_line: "training" })).toBe(false);
    expect(isOneTimeCleanup("one_time", null)).toBe(false);
  });

  it("has no price written into the code", () => {
    const src = read("src/lib/one-time-cleanup.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // $18 and $75, in cents or dollars: the numbers the decision ruled out.
    expect(src).not.toMatch(/\b(1800|7500|18\.00|75\.00)\b/);
  });
});

describe("the total shown is the amount charged", () => {
  const cases = [
    { name: "owner's visit + flat fee", oneOff: 4000, zone: 2000, fee: 9500 },
    { name: "no extra-visit price: the zone's visit", oneOff: null, zone: 2600, fee: 6000 },
    { name: "first cleanup off", oneOff: 3500, zone: 2000, fee: 0 },
    { name: "a free visit, a fee only", oneOff: 0, zone: 2000, fee: 12000 },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const q = asOneTimeCleanupQuote(
        quoteRow({ recurring_price_cents: c.zone, initial_cleanup_cents: c.fee }),
        c.oneOff,
      );
      const shown = oneTimeCleanupTotal({
        visitCents: q.recurring_price_cents,
        firstCleanupCents: q.initial_cleanup_cents,
      });
      const charged = signupChargeFromQuote(q);
      expect(shown?.totalCents).toBe(charged.amountCents);
      expect(shown?.lines.reduce((n, l) => n + l.cents, 0)).toBe(charged.amountCents);
      expect(charged.firstCleanupCents).toBe(c.fee);
      expect(charged.recurringCents).toBe(c.oneOff ?? c.zone);
    });
  }

  it("lists the first cleanup only when it costs something, and the visit always", () => {
    expect(oneTimeCleanupTotal({ visitCents: 4000, firstCleanupCents: 0 })?.lines).toEqual([
      { key: "visit", label: ONE_TIME_CLEANUP_COPY.visitLine, cents: 4000 },
    ]);
    expect(
      oneTimeCleanupTotal({ visitCents: 4000, firstCleanupCents: 9500 })?.lines.map((l) => l.key),
    ).toEqual(["first_cleanup", "visit"]);
  });

  it("shows no total until both parts are priced", () => {
    expect(oneTimeCleanupTotal({ visitCents: 4000, firstCleanupCents: null })).toBeNull();
    expect(oneTimeCleanupTotal({ visitCents: null, firstCleanupCents: 9500 })).toBeNull();
  });
});

describe("a business whose only service is a one-time cleanup", () => {
  const scoop = (booking_mode: PublicService["booking_mode"]): PublicService => ({
    id: "00000000-0000-4000-8000-0000000d1201",
    name: "One-time yard cleanup",
    service_line: "pet_waste",
    price_unit: "visit",
    base_price_cents: null,
    extra_pet_cents: 0,
    default_duration_min: 30,
    booking_mode,
  });

  it("quotes it by its id, so the server sees One visit and sells one visit", () => {
    expect(quotedPublicService([scoop("one_time")], "")?.booking_mode).toBe("one_time");
  });

  it("leaves a repeating pet-waste plan as it was: no id, the zone's plan", () => {
    expect(quotedPublicService([scoop("recurring")], "")).toBeNull();
    expect(quotedPublicService([scoop(undefined)], "")).toBeNull();
  });
});

describe("the booking link renders both lines and the total", () => {
  it("first cleanup, visit and total, before the button", () => {
    const html = renderToStaticMarkup(
      <OneTimeCleanupPriceLines
        visitCents={4000}
        firstCleanupCents={9500}
        showsFirstCleanup
        lastCleanedLabel="1–3 months"
        currency="usd"
      />,
    );
    const t = text(html);
    expect(t).toContain(
      `${ONE_TIME_CLEANUP_COPY.firstCleanupLine} Last cleaned: 1–3 months $95.00`,
    );
    expect(t).toContain(`${ONE_TIME_CLEANUP_COPY.visitLine} $40.00`);
    expect(t).toContain(`${ONE_TIME_CLEANUP_COPY.totalLabel} $135.00`);
    expect(html).toContain('data-testid="one-time-cleanup-total"');
  });

  it("no fee: the visit alone is the total", () => {
    const t = text(
      renderToStaticMarkup(
        <OneTimeCleanupPriceLines
          visitCents={3500}
          firstCleanupCents={0}
          showsFirstCleanup={false}
          lastCleanedLabel={null}
          currency="usd"
        />,
      ),
    );
    expect(t).not.toContain(ONE_TIME_CLEANUP_COPY.firstCleanupLine);
    expect(t).toContain(`${ONE_TIME_CLEANUP_COPY.totalLabel} $35.00`);
  });

  it("an unanswered tier: asks, and shows no total", () => {
    const html = renderToStaticMarkup(
      <OneTimeCleanupPriceLines
        visitCents={4000}
        firstCleanupCents={null}
        showsFirstCleanup
        lastCleanedLabel={null}
        currency="usd"
      />,
    );
    expect(text(html)).toContain("Answer above");
    expect(html).not.toContain("one-time-cleanup-total");
  });

  it("SignupFlow draws it for a pet-waste service sold as one visit", () => {
    const flow = read("src/components/signup/SignupFlow.tsx");
    expect(flow).toMatch(/quotedCleanupOnce = quotedOnce && line === "pet_waste"/);
    expect(flow).toMatch(/quotedCleanupOnce \? \(\s*<OneTimeCleanupPriceLines/);
  });
});

describe("the quote and the charge are priced by one function", () => {
  const src = read("src/lib/signup.functions.ts");
  const body = (name: string) => {
    const start = src.indexOf(`export const ${name} = createServerFn`);
    expect(start, name).toBeGreaterThan(-1);
    const next = src.indexOf("\nexport const ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it("getSignupQuote reprices a one-time cleanup", () => {
    expect(body("getSignupQuote")).toMatch(/asOneTimeCleanupIfOne\(/);
  });

  it("createSignupPaymentIntent reprices it the same way before the charge", () => {
    const pi = body("createSignupPaymentIntent");
    const repriced = pi.indexOf("asOneTimeCleanupIfOne(");
    const charged = pi.indexOf("signupChargeFromQuote(q)");
    expect(repriced).toBeGreaterThan(-1);
    expect(charged).toBeGreaterThan(repriced);
  });

  it("reads the owner's price from the database, never the request", () => {
    const helper = src.slice(src.indexOf("async function asOneTimeCleanupIfOne"));
    expect(helper.slice(0, 900)).toMatch(/\.select\("one_off_price_cents"\)/);
  });
});

describe("a quote for a one-time cleanup", () => {
  const visit = oneTimeCleanupQuoteLine(4000);
  const fee = firstCleanupQuoteLine(
    { mode: "flat", tiers: [], perExtraDogCents: 1000 },
    { tierId: null, zoneFlatCents: 9500, dogCount: 2 },
  )!;
  const asLine = (l: { description: string; quantity: string; price: string }) => {
    const cents = Math.round(parseFloat(l.price) * 100);
    return {
      description: l.description,
      quantity: Number(l.quantity),
      unitAmountCents: cents,
      amountCents: cents,
      recurring: false,
    };
  };
  const lines = [asLine(visit), asLine(fee)];

  it("the visit line is the owner's price, or blank for the office to type", () => {
    expect(visit).toEqual({
      description: ONE_TIME_CLEANUP_COPY.visitLine,
      quantity: "1",
      price: "40.00",
      recurring: false,
    });
    expect(oneTimeCleanupQuoteLine(null).price).toBe("");
  });

  it("the document lists both lines and their sum as the One-time total", () => {
    const t = text(
      renderToStaticMarkup(
        <QuoteDocument
          orgName="Riverbend Scoop Co."
          label="Q-0042"
          status="sent"
          title="One-time cleanup"
          recipientName="Dana"
          validUntil={null}
          message={null}
          lines={lines}
        />,
      ),
    );
    expect(t).toContain(`${ONE_TIME_CLEANUP_COPY.visitLine} 1 × $40.00, one time $40.00`);
    expect(t).toContain("$105.00"); // $95 + $10 for the second dog
    expect(t).toContain("One-time total $145.00");
  });

  it("invoicing it bills exactly what the document totalled", () => {
    const stored = lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_amount_cents: l.unitAmountCents,
      amount_cents: l.amountCents,
      recurring: l.recurring,
    }));
    const billed = oneTimeInvoiceItems(stored).reduce((n, i) => n + i.amountCents, 0);
    expect(billed).toBe(quoteTotals(stored).oneTimeCents);
    expect(billed).toBe(14500);
  });

  it("the editor offers it to a business that scoops", () => {
    const editor = read("src/components/quotes/QuoteEditor.tsx");
    expect(editor).toMatch(
      /runsPetWaste\(orgLines\) && \(\s*<Button[\s\S]{0,300}Add one-time cleanup/,
    );
    expect(editor).toMatch(/oneTimeCleanupQuoteLine\(pricing\?\.oneTimeVisitCents/);
    expect(read("src/lib/quote-pricing.functions.ts")).toMatch(/one_off_price_cents/);
  });
});
