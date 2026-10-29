import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADDON_LAUNCHED, addonCardState } from "@/lib/addon-launch";
import { HELP_ARTICLES } from "@/lib/help-content";
import { ANY_AI_FEATURE_LIVE } from "@/lib/ai-launch";
import i18n from "@/lib/i18n";
import { launchCopy } from "@/lib/launch-copy";
import {
  describeStripeCardRate,
  describeStripeRates,
  suppressionExplanation,
} from "@/lib/processing-fee";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

const read = (file: string) => readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");

/** A paragraph mentioning a held feature must describe its future availability. */
function claimsHeldFeatureIsLive(text: string): boolean {
  return /AI Receptionist|white[ -]label/i.test(text) && !/coming soon/i.test(text);
}

const falsePromises =
  /we['’]ll text you|Text us to get on the route|cards and ACH accepted|plus ACH bank transfers|Add it from Billing|Also available:.*(?:texting|white.label)/i;

describe("held features cannot be sold as live", () => {
  for (const [slug, launched] of Object.entries(ADDON_LAUNCHED)) {
    if (launched) continue;
    it(`${slug} stays Coming soon even when subscribed or waived`, () => {
      for (const subscribed of [false, true]) {
        for (const billing_interval of ["month", "one_time"]) {
          for (const waivedReason of [null, "Included"]) {
            expect(
              addonCardState({
                slug,
                subscribed,
                status: "active",
                billing_interval,
                waivedReason,
              }),
            ).toBe("coming_soon");
          }
        }
      }
    });
  }

  it("launched Managed texting alone (2026-10-29)", () => {
    expect(
      Object.entries(ADDON_LAUNCHED)
        .filter(([, on]) => on)
        .map(([s]) => s),
    ).toEqual(["managed-sms"]);
    expect(
      addonCardState({
        slug: "managed-sms",
        subscribed: true,
        status: "active",
        billing_interval: "month",
      }),
    ).toBe("active");
    // The catalog row still has the last word: coming_soon there is coming soon here.
    expect(
      addonCardState({
        slug: "managed-sms",
        subscribed: false,
        status: "coming_soon",
        billing_interval: "month",
      }),
    ).toBe("coming_soon");
  });

  it("keeps a live paid add-on Active", () => {
    expect(
      addonCardState({
        slug: "priority-support",
        subscribed: true,
        status: "active",
        billing_interval: "month",
      }),
    ).toBe("active");
  });

  it("does not show an AI configuration failure before any AI feature launches", () => {
    expect(ANY_AI_FEATURE_LIVE).toBe(false);
    const ui = read("routes/_authenticated/settings.ai.tsx");
    expect(ui).toContain("enabled: ANY_AI_FEATURE_LIVE");
    expect(ui).toContain("!ANY_AI_FEATURE_LIVE ? (");
    expect(ui).toContain("AI features are coming soon");
  });
});

describe("help and portal copy makes no unavailable promises", () => {
  it("checks every help paragraph and step", () => {
    for (const article of HELP_ARTICLES) {
      for (const text of [...article.body, ...(article.steps ?? [])]) {
        expect(claimsHeldFeatureIsLive(text), `${article.slug}: ${text}`).toBe(false);
        expect(text).not.toMatch(falsePromises);
      }
    }
  });

  it("detects the claims that caused the regression", () => {
    expect(
      claimsHeldFeatureIsLive("The AI Receptionist answers client texts for you day and night."),
    ).toBe(true);
    expect(claimsHeldFeatureIsLive("Also available: white-label portal links.")).toBe(true);
    expect(claimsHeldFeatureIsLive("Coming soon: the AI Receptionist and white label.")).toBe(
      false,
    );
    expect("We'll text you when the next one is on the calendar.").toMatch(falsePromises);
  });

  it("checks customer portal source and the localized copy it renders", () => {
    for (const file of ["visits", "account", "billing", "pay.$invoiceId", "index"]) {
      expect(read(`routes/portal.$slug.$token.${file}.tsx`)).not.toMatch(falsePromises);
    }
    for (const text of Object.values(en.launch)) expect(text).not.toMatch(falsePromises);
    expect(read("routes/portal.$slug.$token.account.tsx")).toContain("!textsLive &&");
    expect(read("routes/portal.$slug.$token.visits.tsx")).toContain(en.launch.visits);
    expect(read("routes/portal.$slug.$token.tsx")).toContain(
      "ctx.textsLive === true && c.contact_phone",
    );
  });

  it("removes engineering setup from tenant receptionist settings", () => {
    const ui = read("routes/_authenticated/settings.ai-receptionist.tsx");
    expect(ui).not.toMatch(/YOUR_TWILIO_INBOUND_SECRET|get_pricing_quote|Twilio Console/);
    expect(ui).toContain(en.launch.receptionistBuy);
  });

  it("offers clients card payments only (bank payments are post-launch, #461)", () => {
    // Comments are stripped: the payments page and processing-fee.ts explain the
    // ACH rail in comments, and that rail still exists for a payment that
    // arrives. What is checked is what a tenant or client can read. "Bank
    // payments take a few days to clear" is allowed: it is shown only on a bank
    // payment that is actually processing.
    const shown = (file: string) =>
      read(file)
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
    const bankAsAWayToPay =
      /card or bank|card and bank|on bank payments|bank \(ACH\)|\bACH fees|bank fees|Bank payments recover|Bank debits show|Bank:\s/i;
    for (const file of [
      "routes/_authenticated/payments.tsx",
      "components/StaffInvoicePayForm.tsx",
      "components/RefundPaymentAction.tsx",
      "lib/processing-fee.functions.ts",
      "lib/processing-fee.ts",
    ]) {
      expect(shown(file), file).not.toMatch(bankAsAWayToPay);
    }
    const payForm = shown("components/StaffInvoicePayForm.tsx");
    expect(payForm).toContain('"Enter card details"');
    expect(payForm).toContain("by card`");
    expect(shown("routes/_authenticated/payments.tsx")).not.toMatch(/ex\.ach/);

    for (const reason of [
      "absorbed",
      "debit",
      "prepaid",
      "region",
      "unknown_funding",
      "unknown_region",
      "not_attested",
    ] as const) {
      expect(suppressionExplanation(reason)).not.toMatch(/bank|ACH/i);
    }
    expect(describeStripeRates()).toBe(`${describeStripeCardRate()} per card payment`);

    for (const article of HELP_ARTICLES) {
      for (const text of [...article.body, ...(article.steps ?? [])]) {
        expect(text, article.slug).not.toMatch(/\bACH\b|pay by bank|bank payment|bank debit/i);
      }
    }
    for (const locale of [en, es, ar, zh]) {
      expect(JSON.stringify(locale)).not.toMatch(/\bACH\b|card or bank|bank payment|bank debit/i);
    }
  });

  it("has translated launch copy with matching placeholders in all four locales", async () => {
    for (const [lang, locale] of Object.entries({ en, es, ar, zh })) {
      expect(Object.keys(locale.launch).sort()).toEqual(Object.keys(en.launch).sort());
      for (const key of Object.keys(en.launch) as Array<keyof typeof en.launch>) {
        expect(locale.launch[key].match(/\{\{\w+\}\}/g) ?? []).toEqual(
          en.launch[key].match(/\{\{\w+\}\}/g) ?? [],
        );
        if (lang !== "en") expect(locale.launch[key]).not.toBe(en.launch[key]);
      }
      await i18n.changeLanguage(lang);
      expect(launchCopy(en.launch.visits)).toBe(locale.launch.visits);
      expect(launchCopy(en.launch.help3)).toBe(locale.launch.help3);
    }
    await i18n.changeLanguage("en");
  });
});
