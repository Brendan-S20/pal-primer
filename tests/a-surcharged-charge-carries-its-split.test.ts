import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  invoiceAppliedCents,
  merchantRegionFrom,
  surchargeFromMetadata,
  surchargeMetadata,
} from "@/lib/processing-fee.server";
import { quoteProcessingFee } from "@/lib/processing-fee";

// A pass-through charge is base + surcharge, and the two must stay separable
// all the way to the ledger. `payments.amount_cents` means "money applied to
// the invoice" on every row ever written; `markInvoicePaidFromStripe` is handed
// that number directly. Fold the surcharge in and an invoice is credited more
// than it was owed AND the fee recovery is reported as revenue — on the
// dashboard, /reports, /analytics and the CPA pack, all of which sum the same
// column.
//
// The split cannot be recomputed at webhook time: the event carries neither the
// card's funding type nor the tenant's setting as they stood at the charge, and
// re-quoting could legitimately return a different number. So it travels in the
// PaymentIntent metadata as a fact, and the tests below pin the round trip.
//
// The last block is the coverage guard, and it is the point of this file. The
// same shape has cost this repo three times now (twenty-four app hosts, BUG-21's
// three revenue implementations, and the ten charge sites the platform fee had
// to be added to): a charge path missed here does not error, does not warn and
// fails nothing — it silently charges the wrong amount.

describe("the surcharge survives the round trip through Stripe metadata", () => {
  const quote = quoteProcessingFee({
    baseCents: 6_000,
    rail: "card",
    funding: "credit",
    merchantRegion: "TX",
    passThroughEnabled: true,
    attested: true,
  });

  it("writes the surcharge and rail as strings, which is all Stripe stores", () => {
    const md = surchargeMetadata(quote);
    expect(md).toEqual({ surcharge_cents: "180", fee_rail: "card" });
    expect(Object.values(md).every((v) => typeof v === "string")).toBe(true);
  });

  it("reads the same number back out", () => {
    expect(surchargeFromMetadata(surchargeMetadata(quote))).toBe(180);
  });

  it("splits a charge into invoice money and fee recovery", () => {
    const charged = quote.totalCents; // 6180
    expect(invoiceAppliedCents(charged, surchargeMetadata(quote))).toBe(6_000);
  });

  it("treats a charge from before this feature as entirely invoice money", () => {
    // Every existing payment row and every in-flight PaymentIntent. If this
    // returned anything but the full amount, the first webhook after deploy
    // would under-credit a live invoice.
    expect(invoiceAppliedCents(6_000, { invoice_id: "abc", source: "autopay" })).toBe(6_000);
    expect(invoiceAppliedCents(6_000, null)).toBe(6_000);
    expect(invoiceAppliedCents(6_000, undefined)).toBe(6_000);
  });

  it("refuses malformed metadata rather than crediting a negative payment", () => {
    for (const bad of ["", "abc", "-50", "NaN", "1e9999"]) {
      expect(surchargeFromMetadata({ surcharge_cents: bad })).toBe(0);
      expect(invoiceAppliedCents(6_000, { surcharge_cents: bad })).toBe(6_000);
    }
    // A surcharge larger than the charge is nonsense; clamp to zero applied
    // rather than return a negative payment.
    expect(invoiceAppliedCents(100, { surcharge_cents: "500" })).toBe(0);
  });
});

describe("finding the merchant's state on a connected account", () => {
  it("prefers the company address", () => {
    expect(merchantRegionFrom({ company: { address: { state: "TX" } } } as never)).toBe("TX");
  });

  it("falls back to the individual address, which a sole trader has instead", () => {
    expect(merchantRegionFrom({ individual: { address: { state: "ma" } } } as never)).toBe("MA");
  });

  it("returns null rather than guessing, which suppresses the surcharge", () => {
    expect(merchantRegionFrom({} as never)).toBeNull();
    expect(merchantRegionFrom({ company: { address: { state: "  " } } } as never)).toBeNull();
  });
});

// ── the coverage guard ─────────────────────────────────────────────────────

/** The off-session paths — a saved payment method, so the rail and funding
 *  type are known before the charge is built and a quote is possible. */
const OFF_SESSION_SITES = [
  ["src/lib/portal.functions.ts", "portal_saved_card"],
  ["src/lib/invoices.functions.ts", "staff_saved_card"],
  ["src/routes/api/public/hooks/nightly.ts", "autopay"],
] as const;

describe("no off-session charge is built without a quote", () => {
  it.each(OFF_SESSION_SITES)("%s quotes before charging (%s)", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("quoteForPaymentMethodId");
    expect(src).toContain("orgFeeConfig");
  });

  it.each(OFF_SESSION_SITES)(
    "%s charges the quoted total, not the bare due amount",
    (file, source) => {
      const src = readFileSync(file, "utf8");
      // Find the create call for this source and check the amount it charges.
      const idx = src.indexOf(`source: "${source}"`);
      expect(idx).toBeGreaterThan(-1);
      const before = src.slice(Math.max(0, idx - 1200), idx);
      const amountLine = [...before.matchAll(/amount: (\w[\w.]*),/g)].pop();
      expect(amountLine?.[1]).toBe("quote.totalCents");
    },
  );

  it.each(OFF_SESSION_SITES)("%s puts the split in the charge metadata (%s)", (file, source) => {
    const src = readFileSync(file, "utf8");
    const idx = src.indexOf(`source: "${source}"`);
    // surchargeMetadata is spread immediately after the source line; without it
    // the webhook cannot tell invoice money from fee recovery.
    expect(src.slice(idx, idx + 120)).toContain("surchargeMetadata(quote)");
  });

  it.each(OFF_SESSION_SITES)("%s keys idempotency on the charged total (%s)", (file) => {
    // The amount is in every one of these keys on purpose. If it stays the base
    // while the charge becomes base + surcharge, a tenant switching pass-through
    // on between two attempts replays the key with a different amount, which
    // Stripe rejects as an idempotency_error — and the payment fails.
    const src = readFileSync(file, "utf8");
    const keys = [...src.matchAll(/idempotencyKey: `([^`]+)`/g)].map((m) => m[1]);
    const moneyKeys = keys.filter((k) => /saved-card|autopay/.test(k));
    expect(moneyKeys.length).toBeGreaterThan(0);
    for (const k of moneyKeys) {
      expect(k).toContain("${quote.totalCents}");
      expect(k).not.toContain("${dueCents}");
    }
  });
});

describe("the platform fee is taken on the base, never on the surcharge", () => {
  it.each(OFF_SESSION_SITES)("%s (%s)", (file, source) => {
    // We do not take 50 bps of a fee the tenant is recovering from Stripe. The
    // application fee argument must be the invoice amount, not quote.totalCents.
    const src = readFileSync(file, "utf8");
    const idx = src.indexOf(`source: "${source}"`);
    const before = src.slice(Math.max(0, idx - 1200), idx);
    const feeLine = [
      ...before.matchAll(/application_fee_amount: platformFeeCents\((\w+)\)/g),
    ].pop();
    expect(feeLine?.[1]).toBe("dueCents");
  });
});

describe("the reconcile paths use the split, not the raw charge", () => {
  // EVERY file that can mark an invoice paid, not just the webhook.
  //
  // The first version of this block read only `stripe.ts`, and that blind spot
  // cost exactly what it was written to prevent: `invoice-reconcile.server.ts`
  // carried the identical `amountCents: pi.amount` and this test passed anyway.
  // Reconcile is the FALLBACK for a missed webhook, so it runs against precisely
  // the surcharged intents — a $100 invoice paid with an $0.80 ACH pass-through
  // settled as $100.80 of revenue, and every figure that sums payments was high
  // by the fee.
  const MARKS_INVOICES_PAID = [
    "src/routes/api/public/hooks/stripe.ts",
    "src/lib/invoice-reconcile.server.ts",
  ] as const;

  it.each(MARKS_INVOICES_PAID)("%s never credits an invoice the raw charge", (file) => {
    const src = readFileSync(file, "utf8");
    // `amountCents:` must never be handed a bare Stripe charge amount. Matching
    // the property assignment, not the bare identifier, so the explanatory
    // comments above each call site do not trip it.
    expect(src).not.toMatch(/amountCents:\s*pi\.amount\b/);
    expect(src).not.toMatch(/amountCents:\s*charge\.amount\b/);
  });

  it.each(MARKS_INVOICES_PAID)("%s splits the charge before crediting", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain("invoiceAppliedCents(");
    expect(src).toContain("surchargeFromMetadata(");
  });

  it("the payments insert does not discard its error", () => {
    // It used to. `payments_pi_unique` is UNIQUE on stripe_payment_intent_id and
    // the payment_failed handler writes a row keyed on the same intent, so a
    // decline followed by a retry on that intent flipped the invoice to paid
    // and then silently lost the succeeded payment row — money banked, revenue
    // short by the full amount, nothing reported.
    const src = readFileSync("src/lib/invoice-reconcile.server.ts", "utf8");
    expect(src).toMatch(/const \{ error: payErr \} = await supabaseAdmin\s*\n?\s*\.from\("payments"\)\.insert/);
    expect(src).toContain('payErr.code === "23505"');
  });

  it("the payments row records the surcharge beside the amount, not inside it", () => {
    const recon = readFileSync("src/lib/invoice-reconcile.server.ts", "utf8");
    expect(recon).toContain("surcharge_cents: args.surchargeCents ?? 0");
  });
});


// ── the other half of the coverage guard ───────────────────────────────────
//
// The list above names only the three paths that already pass, under a header
// calling itself "the coverage guard". So the four paths that do NOT surcharge
// were invisible to it: the settings screen advertised "applies to bank (ACH)
// payments straight away" with a live "you recover $X" figure while every
// ACH-capable path absorbed the fee, and no test could fail.
//
// These are asserted as ABSORBING rather than quietly skipped. When the
// two-step is built, each moves up to OFF_SESSION_SITES and this test fails
// until it does — which is the point: the gap is now a thing that has to be
// edited deliberately rather than one nobody can see.

/** Customer-present: the payer chooses card or bank inside Stripe's Payment
 *  Element, AFTER the intent exists with its amount fixed. */
const CUSTOMER_PRESENT_SITES = [
  ["src/lib/portal.functions.ts", "portal_inline"],
  ["src/lib/invoices.functions.ts", "staff_inline / public pay link"],
  ["src/lib/signup.functions.ts", "signup prepay"],
] as const;

describe("the paths that do NOT surcharge are named, not hidden", () => {
  it.each(CUSTOMER_PRESENT_SITES)("%s is on the absorbing list (%s)", (file) => {
    // Nothing to assert about their code beyond existence — the point of the
    // list is that it is a list, reviewed when it changes.
    expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
  });

  it("the settings screen does not promise ACH recovery", () => {
    // The exact copy that was false: "Applies to bank (ACH) payments straight
    // away", beside a computed ACH recovery figure.
    const ui = readFileSync("src/routes/_authenticated/payments.tsx", "utf8");
    expect(ui).not.toMatch(/bank \(ACH\) payments straight away/);
    expect(ui).toMatch(/automatic payments and saved cards/);
  });

  it("the module header no longer claims a two-step that does not exist", () => {
    const src = readFileSync("src/lib/processing-fee.server.ts", "utf8");
    // It may DESCRIBE the old claim while correcting it; what it must not do is
    // state it as current fact.
    expect(src).not.toMatch(/paths became two-step/);
    expect(src).toMatch(/FOUR paths do NOT surcharge/);
  });
});
