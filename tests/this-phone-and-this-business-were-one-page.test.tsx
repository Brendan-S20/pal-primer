// The settings half of the launch pass, held in place by rendering the pieces
// and reading the files that wire them. The browser half, at every width and
// at the iPad sizes with touch on, is
// tests/viewports/this-phone-and-this-business-were-one-page.spec.ts.
//
//   * Preferences is THIS DEVICE (language, light/dark, haptics, the phone
//     menu). What the whole business uses moved to Business defaults, which a
//     technician is never offered.
//   * Light, dark, or the device's own setting, stored on the device, applied
//     before the first paint, defaulting to light because dark has never been
//     reviewed (src/lib/theme.ts says why).
//   * The trial and billing banners are not drawn for a technician.
//   * The weekly digest's settings live on Settings → Emails, not Analytics.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useLocation: () => ({ pathname: "/my-day" }),
}));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@/lib/trial.functions", () => ({ getTrialState: vi.fn() }));
vi.mock("@/lib/billing.functions", () => ({ getBillingBannerStatus: vi.fn() }));

import i18n from "@/lib/i18n";
import {
  DEFAULT_THEME,
  THEME_BOOT_SCRIPT,
  THEME_KEY,
  resolvesDark,
  type ThemePref,
} from "@/lib/theme";
import { ThemeCard } from "@/components/settings/ThemeCard";
import { TrialBanner } from "@/components/TrialBanner";
import { SuspensionBanner } from "@/components/SuspensionBanner";
import { canAccess, type AppRole } from "@/hooks/useMyRole";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function render(node: ReactNode, seed: (qc: QueryClient) => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(qc);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const asRole = (role: AppRole) => (qc: QueryClient) =>
  qc.setQueryData(["my-org"], { organization: { id: "org", role } });

describe("light, dark, or the device's own setting", () => {
  it("decides dark only when chosen, or when 'system' meets a dark device", () => {
    const table: [ThemePref, boolean, boolean][] = [
      ["light", false, false],
      ["light", true, false],
      ["dark", false, true],
      ["dark", true, true],
      ["system", false, false],
      ["system", true, true],
    ];
    for (const [pref, sys, dark] of table)
      expect(resolvesDark(pref, sys), `${pref}/${sys}`).toBe(dark);
  });

  it("defaults to light, so nobody's app changes until they choose", () => {
    expect(DEFAULT_THEME).toBe("light");
  });

  it("the boot script that runs before paint makes the same decision", () => {
    // Run the exact string <head> runs, against a stand-in document, for
    // every stored value including garbage and nothing at all.
    const cases: [string | null, boolean, boolean][] = [
      [null, true, false],
      ["nonsense", true, false],
      ["light", true, false],
      ["dark", false, true],
      ["system", true, true],
      ["system", false, false],
    ];
    for (const [stored, sys, dark] of cases) {
      const classes = new Set<string>();
      const el = {
        classList: { add: (c: string) => classes.add(c) },
        style: { colorScheme: "" },
      };
      const env = {
        localStorage: { getItem: (k: string) => (k === THEME_KEY ? stored : null) },
        window: { matchMedia: () => ({ matches: sys }) },
        document: { documentElement: el },
      };
      new Function("localStorage", "window", "document", THEME_BOOT_SCRIPT)(
        env.localStorage,
        env.window,
        env.document,
      );
      expect(classes.has("dark"), `${stored}/${sys}`).toBe(dark);
      expect(el.style.colorScheme).toBe(dark ? "dark" : "light");
    }
  });

  it("is put in <head> by the root, before HeadContent", () => {
    const shell = read("src/routes/__root.tsx");
    expect(shell).toMatch(/__html: THEME_BOOT_SCRIPT/);
    expect(shell.indexOf("THEME_BOOT_SCRIPT }}")).toBeLessThan(shell.indexOf("<HeadContent />"));
    expect(shell).toMatch(/<html lang="en" suppressHydrationWarning>/);
    expect(shell).toMatch(/followSystemTheme\(\)/);
  });

  it("offers three choices, in the device's language", async () => {
    const en = render(<ThemeCard />);
    expect(en).toContain("Appearance");
    for (const label of ["System", "Light", "Dark"]) expect(en).toContain(`>${label}</button>`);
    expect(en.match(/role="radio"/g)).toHaveLength(3);
    expect(en).toMatch(/touch:min-h-11/);

    await i18n.changeLanguage("es");
    try {
      const es = render(<ThemeCard />);
      for (const label of ["Apariencia", "Sistema", "Claro", "Oscuro"]) expect(es).toContain(label);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("Preferences is this device; Business defaults is the business", () => {
  const prefs = read("src/routes/_authenticated/settings.preferences.tsx");
  const business = read("src/routes/_authenticated/settings.business.tsx");
  const BUSINESS_CARDS = [
    "TimeZoneCard",
    "PricingBaselineCard",
    "CommercialAccountsCard",
    "CompletionPhotoCard",
    "RecleanGuaranteeCard",
    "DemoDataCard",
  ];

  it("moved every business card off Preferences and onto Business defaults", () => {
    for (const card of BUSINESS_CARDS) {
      expect(prefs, `${card} is still on Preferences`).not.toMatch(new RegExp(`\\b${card}\\b`));
      expect(business, `${card} is not on Business defaults`).toMatch(new RegExp(`<${card} />`));
      expect(business).toMatch(new RegExp(`function ${card}\\(`));
    }
    for (const device of [
      "<ThemeCard />",
      "<AppearanceCard />",
      'id="lang"',
      "HAPTICS_KEY",
      "AWAKE_KEY",
      "MAP_KEY",
    ]) {
      expect(prefs).toContain(device);
      expect(business).not.toContain(device);
    }
  });

  it("is on the settings rail, and never offered to a technician", () => {
    const rail = read("src/routes/_authenticated/settings.tsx");
    expect(rail).toMatch(/\{ label: "Business defaults", to: "\/settings\/business" \}/);
    expect(rail).toMatch(
      /\{ label: "Preferences", to: "\/settings\/preferences", techVisible: true \}/,
    );
    expect(canAccess("tech", "/settings/business")).toBe(false);
    expect(canAccess("tech", "/settings/preferences")).toBe(true);
    expect(canAccess("owner", "/settings/business")).toBe(true);
    expect(canAccess("office_manager", "/settings/business")).toBe(true);
  });

  it("the copy that pointed at Preferences for a business setting points at the new page", () => {
    expect(read("src/routes/_authenticated/settings.scheduling.tsx")).toMatch(
      /to="\/settings\/business"[\s\S]{0,80}Settings → Business defaults/,
    );
    // Zones & pricing pointed here for the standard price until #860 moved
    // that price onto each service: it now points at Settings → Services.
    expect(read("src/routes/_authenticated/settings.zones.tsx")).toMatch(
      /to="\/settings\/services"/,
    );
    expect(read("src/lib/help-content.ts")).toMatch(
      /\[Business defaults\]\(\/settings\/business\) under \*\*Re-clean guarantee\*\*/,
    );
  });
});

describe("the banners a technician cannot act on", () => {
  const trial = (qc: QueryClient) =>
    qc.setQueryData(["trial", "state"], {
      phase: "expired",
      daysRemaining: null,
      endsOn: "2026-08-30",
      restricted: true,
      canManageBilling: false,
    });

  it("the trial banner draws for the office and not for a tech", () => {
    for (const role of ["owner", "office_manager", "dispatcher"] as const) {
      const html = render(<TrialBanner />, (qc) => {
        asRole(role)(qc);
        trial(qc);
      });
      // The owner's headline, or the non-owner's "This account's trial has
      // ended. Ask the owner to subscribe." (the fixture can't manage billing).
      expect(html, role).toMatch(/trial has ended/i);
    }
    const tech = render(<TrialBanner />, (qc) => {
      asRole("tech")(qc);
      trial(qc);
    });
    expect(tech).toBe("");
  });

  it("and the billing banner likewise", () => {
    const pastDue = (role: AppRole) => (qc: QueryClient) => {
      asRole(role)(qc);
      qc.setQueryData(["billing-banner-status"], { planStatus: "past_due", role });
    };
    expect(render(<SuspensionBanner />, pastDue("owner"))).toContain("Payment failed.");
    expect(render(<SuspensionBanner />, pastDue("dispatcher"))).toContain("Payment failed.");
    expect(render(<SuspensionBanner />, pastDue("tech"))).toBe("");
  });

  it("nor while the role is still loading, so a tech's phone never flashes one", () => {
    expect(render(<TrialBanner />, trial)).toBe("");
  });
});

describe("the weekly digest is an email setting", () => {
  it("is drawn on Settings → Emails for the people its server functions answer", () => {
    const emails = read("src/routes/_authenticated/settings.emails.tsx");
    expect(emails).toMatch(/<WeeklyDigestCard \/>/);
    expect(emails).toMatch(/can\("view_financials"\)/);
  });

  it("is no longer a tab on Analytics", () => {
    const analytics = read("src/routes/_authenticated/analytics.tsx");
    expect(analytics).not.toMatch(/value="digest"/);
    expect(analytics).not.toMatch(/getDigestSettings|DigestTab/);
  });

  it("the email and the error that send an owner to it name where it is now", () => {
    expect(read("src/lib/email-templates/weekly-digest.tsx")).toMatch(/under Settings →\s+Emails/);
    expect(read("src/lib/digest.functions.ts")).toMatch(/Set one in Settings → Emails/);
    for (const f of ["src/lib/email-templates/weekly-digest.tsx", "src/lib/digest.functions.ts"]) {
      expect(read(f)).not.toMatch(/Analytics →\s+Weekly digest/);
    }
  });
});
