import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADDON_LAUNCHED, addonCardState } from "@/lib/addon-launch";
import { HELP_ARTICLES } from "@/lib/help-content";
import { ANY_AI_FEATURE_LIVE } from "@/lib/ai-launch";
import i18n from "@/lib/i18n";
import { launchCopy } from "@/lib/launch-copy";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

const read = (file: string) => readFileSync(join(import.meta.dirname, "..", "src", file), "utf8");

/** A paragraph mentioning a held feature must describe its future availability. */
function claimsHeldFeatureIsLive(text: string): boolean {
  return /AI Receptionist|managed texting|white[ -]label/i.test(text) && !/coming soon/i.test(text);
}

const falsePromises =
  /we['’]ll text you|Text us to get on the route|cards and ACH accepted|plus ACH bank transfers|Add it from Billing|Also available:.*(?:texting|white.label)/i;

describe("held features cannot be sold as live", () => {
  for (const [slug, launched] of Object.entries(ADDON_LAUNCHED)) {
    it(`${slug} stays Coming soon even when subscribed or waived`, () => {
      expect(launched).toBe(false);
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
    expect(
      claimsHeldFeatureIsLive("Also available: managed texting and white-label portal links."),
    ).toBe(true);
    expect(claimsHeldFeatureIsLive("Coming soon: the AI Receptionist and managed texting.")).toBe(
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
