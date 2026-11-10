// D6, onboarding audit 2026-11-09: the full product sidebar during first-run
// setup.
//
// An owner who had just created a workspace landed on /onboarding and /setup
// with Dashboard, Schedule, Clients, Invoices, Payments, Inbox, Leads,
// Campaigns, Waste log, Neighbor canvassing and the rest down the side, before
// the business had a name, an address or a price. The pilot walkthrough read
// that as "everything is half-built".
//
// While the guided setup is open and not finished, the sidebar shows what the
// walkthrough needs (Setup, Schedule, Clients, Settings) and puts every other
// entry behind one "Show all menus" disclosure. Nothing is removed and nothing
// is unreachable: the disclosure opens the same groups, filtered the same way.
// Finishing setup, "Not now", "Finish later" or the checklist's dismiss each
// give the whole sidebar back.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: {} },
  isImpersonationTab: () => false,
}));

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const ALL_ON = {
  commercialEnabled: true,
  franchiseParent: true,
  petWaste: true,
  training: true,
  texting: true,
};

const steps = (done: boolean[]) =>
  ["business", "zones", "clients", "staff", "dump_site", "payouts"].map((id, i) => ({
    id,
    done: done[i] ?? false,
  }));

async function nav() {
  return import("@/components/AppSidebar");
}

describe("isFirstRun", () => {
  it("is on for an owner whose guide is open and whose setup is not finished", async () => {
    const { isFirstRun } = await nav();
    expect(
      isFirstRun({
        role: "owner",
        phase: "open",
        status: { dismissed: false, steps: steps([false]) },
        failed: false,
      }),
    ).toBe(true);
  });

  it("is on while the status is still loading, so the full list does not flash first", async () => {
    const { isFirstRun } = await nav();
    expect(isFirstRun({ role: "owner", phase: "open", status: undefined, failed: false })).toBe(
      true,
    );
  });

  it("is off once every step is done", async () => {
    const { isFirstRun } = await nav();
    expect(
      isFirstRun({
        role: "owner",
        phase: "open",
        status: { dismissed: false, steps: steps([true, true, true, true, true, true]) },
        failed: false,
      }),
    ).toBe(false);
  });

  it("is off once the guide is closed (Not now, Finish later, finished)", async () => {
    const { isFirstRun } = await nav();
    for (const phase of ["closed", "unknown"] as const) {
      expect(
        isFirstRun({
          role: "owner",
          phase,
          status: { dismissed: false, steps: steps([]) },
          failed: false,
        }),
      ).toBe(false);
    }
  });

  it("is off once the checklist is dismissed", async () => {
    const { isFirstRun } = await nav();
    expect(
      isFirstRun({
        role: "owner",
        phase: "open",
        status: { dismissed: true, steps: steps([]) },
        failed: false,
      }),
    ).toBe(false);
  });

  it("is off for everyone but the owner, and when the status read failed", async () => {
    const { isFirstRun } = await nav();
    for (const role of ["office_manager", "dispatcher", "tech", null] as const) {
      expect(
        isFirstRun({
          role,
          phase: "open",
          status: { dismissed: false, steps: steps([]) },
          failed: false,
        }),
      ).toBe(false);
    }
    expect(isFirstRun({ role: "owner", phase: "open", status: undefined, failed: true })).toBe(
      false,
    );
  });
});

describe("firstRunNav", () => {
  it("leads with Setup, Schedule, Clients, Services and Settings", async () => {
    const { firstRunNav, NAV_GROUPS } = await nav();
    const { core } = firstRunNav(NAV_GROUPS, "owner", ALL_ON);
    expect(core.map((i) => i.url)).toEqual([
      "/setup",
      "/routes",
      "/clients",
      "/settings/services",
      "/settings",
    ]);
  });

  it("puts every advanced entry behind the disclosure, not in the first list", async () => {
    const { firstRunNav, NAV_GROUPS } = await nav();
    const { core, rest } = firstRunNav(NAV_GROUPS, "owner", ALL_ON);
    const coreUrls = core.map((i) => i.url);
    const restUrls = rest.flatMap((g) => g.items.map((i) => i.url));
    for (const advanced of [
      "/dashboard",
      "/invoices",
      "/payments",
      "/inbox",
      "/leads",
      "/campaigns",
      "/waste-log",
      "/neighbors",
    ]) {
      expect(coreUrls, advanced).not.toContain(advanced);
      expect(restUrls, `${advanced} must still be reachable`).toContain(advanced);
    }
  });

  it("hides nothing for good: core plus the disclosure is the whole visible sidebar", async () => {
    const { firstRunNav, NAV_GROUPS, isNavItemVisible } = await nav();
    const { core, rest } = firstRunNav(NAV_GROUPS, "owner", ALL_ON);
    const full = NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => isNavItemVisible(i, "owner", ALL_ON))
      .map((i) => i.url)
      .sort();
    const shown = [...core.map((i) => i.url), ...rest.flatMap((g) => g.items.map((i) => i.url))]
      .filter((u) => u !== "/setup")
      .sort();
    expect(shown).toEqual(full);
  });

  it("applies the same filters as the full sidebar (no Waste log for a dog walker)", async () => {
    const { firstRunNav, NAV_GROUPS } = await nav();
    const { rest } = firstRunNav(NAV_GROUPS, "owner", { ...ALL_ON, petWaste: false });
    expect(rest.flatMap((g) => g.items.map((i) => i.url))).not.toContain("/waste-log");
  });
});

describe("AppSidebar", () => {
  const src = read("src/components/AppSidebar.tsx");

  it("renders the reduced list while first run is on, and a disclosure for the rest", () => {
    expect(src).toMatch(/useFirstRun\(\)/);
    expect(src).toMatch(/firstRunNav\(/);
    expect(src).toMatch(/aria-expanded=\{showAll\}/);
    expect(src).toMatch(/data-first-run-more/);
  });

  it("names the new entries in every interface language", () => {
    for (const [lang, dict] of Object.entries({ en, es, ar, zh })) {
      const n = (
        dict as unknown as {
          nav: {
            item: Record<string, string>;
            group: Record<string, string>;
            showAllMenus?: string;
            hideAllMenus?: string;
          };
        }
      ).nav;
      expect(n.item.setup, lang).toBeTruthy();
      expect(n.group["Get started"], lang).toBeTruthy();
      expect(n.showAllMenus, lang).toBeTruthy();
      expect(n.hideAllMenus, lang).toBeTruthy();
    }
  });
});
