// QA row 36, 2026-10-15: Schedule was fourth under Operations, Invoices sat
// in the lower half of a sidebar of about 25 entries, on the phone's More
// sheet Invoices was below the first screen, and there was no "Team" entry.
//
// Dashboard, Schedule, Clients, Invoices and Payments are the first group
// now, in that order; what is opened once a season is at the bottom; and a
// Team entry points at the page that already exists, Settings → Users &
// roles. Order only: who can see what is unchanged (role permissions are
// issue #460), and this holds every role's visible set to the rule it had.

import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canAccess, type AppRole } from "@/hooks/useMyRole";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

// AppSidebar pulls in the Supabase client at import time; a list of entries
// needs none of it.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const root = join(import.meta.dirname, "..");
const ROLES: AppRole[] = ["owner", "office_manager", "dispatcher", "tech"];
// texting: since #458 the Messages entry is shown only when texting is on.
const ALL_ON = {
  commercialEnabled: true,
  franchiseParent: true,
  petWaste: true,
  training: true,
  texting: true,
};
/** MobileTabBar's OFFICE_TAB_URLS: the three the More sheet leaves out. */
const OFFICE_TABS = ["/dashboard", "/routes", "/clients"];

async function nav() {
  return import("@/components/AppSidebar");
}

describe("the owner's sidebar", () => {
  it("opens on Dashboard, Schedule, Clients, Invoices and Payments, in that order", async () => {
    const { NAV_GROUPS } = await nav();
    expect(NAV_GROUPS[0].items.map((i) => i.url)).toEqual([
      "/dashboard",
      "/routes",
      "/clients",
      "/invoices",
      "/payments",
    ]);
  });

  it("puts the rarely opened setup entries last", async () => {
    const { NAV_GROUPS } = await nav();
    const last = NAV_GROUPS[NAV_GROUPS.length - 1];
    expect(last.label).toBe("Setup");
    expect(last.items.map((i) => i.url)).toEqual([
      "/zones",
      // #861: beside Zones, because both answer "what do I charge".
      "/settings/services",
      "/imports",
      "/settings/users",
      "/settings",
    ]);
  });

  it("lists every entry exactly once", async () => {
    const { NAV_GROUPS } = await nav();
    const urls = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.url));
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("the phone's More sheet", () => {
  it("opens on Invoices and Payments for an owner, after the three on the tab bar", async () => {
    const { NAV_GROUPS, isNavItemVisible } = await nav();
    const more = NAV_GROUPS.flatMap((g) => g.items)
      .filter((it) => isNavItemVisible(it, "owner", ALL_ON) && !OFFICE_TABS.includes(it.url))
      .map((it) => it.url);
    expect(more.slice(0, 2)).toEqual(["/invoices", "/payments"]);
    // Built from the list, so the order cannot drift from the sidebar's.
    const bar = readFileSync(join(root, "src/components/MobileTabBar.tsx"), "utf8");
    expect(bar).toMatch(/const moreGroups = NAV_GROUPS\.map/);
  });
});

describe("the Team entry", () => {
  it("points at the team page that already exists", async () => {
    const { NAV_GROUPS } = await nav();
    const team = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.title === "Team");
    expect(team?.url).toBe("/settings/users");
    expect(existsSync(join(root, "src/routes/_authenticated/settings.users.tsx"))).toBe(true);
  });

  it("is shown to exactly the roles Settings shows Users & roles to", async () => {
    const { NAV_GROUPS, isNavItemVisible } = await nav();
    const team = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.url === "/settings/users")!;
    for (const role of ROLES) {
      // settings.tsx: `(role !== "tech" || t.techVisible) && canAccess(role, t.to)`,
      // and Users & roles has no techVisible.
      const settingsShowsIt = role !== "tech" && canAccess(role, "/settings/users");
      expect(isNavItemVisible(team, role, ALL_ON), role).toBe(settingsShowsIt);
    }
    expect(isNavItemVisible(team, "tech", ALL_ON)).toBe(false);
    expect(isNavItemVisible(team, "owner", ALL_ON)).toBe(true);
  });

  it("changes nobody's access to anything else: every other entry still follows canAccess", async () => {
    const { NAV_GROUPS, isNavItemVisible } = await nav();
    for (const role of ROLES) {
      for (const it of NAV_GROUPS.flatMap((g) => g.items)) {
        if (it.officeOnly) continue;
        expect(isNavItemVisible(it, role, ALL_ON), `${role} ${it.url}`).toBe(
          canAccess(role, it.url),
        );
      }
    }
    // Only the Team entry carries the new flag.
    const flagged = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.officeOnly);
    expect(flagged.map((i) => i.url)).toEqual(["/settings/users"]);
  });

  it("is named in all four languages", () => {
    for (const [lng, l] of Object.entries({ en, es, ar, zh })) {
      const item = (l as { nav: { item: Record<string, string> } }).nav.item;
      expect(item["settings/users"], lng).toBeTruthy();
    }
  });
});
