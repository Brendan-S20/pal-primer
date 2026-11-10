// #861 (onboarding QA, 2026-11-10): an owner saved a $20 standard price on
// Settings, Business defaults, added services, a client and a completed
// visit, and the Guided setup banner still read "Next: Your service area and
// price" on every page. The price step was done only when a ZONE row existed
// (`areaDone = zones.count > 0`), so the price every quote falls back to when
// no zone has one did not count. And the sidebar had no Services entry: the
// page lived only under Settings.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@tanstack/react-start", async (orig) => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return {
    ...(await orig<typeof import("@tanstack/react-start")>()),
    createServerFn: () => builder,
    createServerOnlyFn: (fn: unknown) => fn,
  };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: {} },
  isImpersonationTab: () => false,
}));

import { loadOnboardingStatus, type OnboardingStep } from "@/lib/onboarding.functions";

type Counts = Record<string, number>;

/** A pet-waste business with an address, a client and the given standard
 *  price. Counts not named are zero: no zone, in particular. */
function context(lines: string[], counts: Counts, stdBasePriceCents: number | null) {
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      for (const m of ["eq", "gt", "not", "is"]) q[m] = () => q;
      q.select = (c: string) => {
        cols = c;
        return q;
      };
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: "org-a" } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: lines } };
          if (cols.includes("contact_address")) {
            // Whatever the step reads the price from, it must be on the
            // organization row; answer every column the read asks for.
            return {
              data: { contact_address: "1 Main St", std_base_price_cents: stdBasePriceCents },
            };
          }
          return { data: {} };
        }
        return { count: counts[table] ?? 0, data: [] };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
  return { supabase, userId: "owner" } as never;
}

async function status(lines: string[], counts: Counts, std: number | null) {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[]; completed: number }>;
  return load(context(lines, counts, std));
}

/** What the banner reads as "Next": the first step not done. */
const next = (steps: OnboardingStep[]) => steps.find((s) => !s.done);

describe("a saved standard price finishes the setup price step", () => {
  it("is done after a $20 standard price, with no zone drawn", async () => {
    const { steps } = await status(["pet_waste"], { clients: 1 }, 2000);
    expect(steps.find((s) => s.id === "zones")!.done).toBe(true);
  });

  it("does not say 'Next: Your service area and price' once a price is saved and a client added", async () => {
    const { steps } = await status(["pet_waste"], { clients: 1 }, 2000);
    expect(next(steps)?.label).not.toBe("Your service area and price");
    expect(next(steps)?.id).not.toBe("zones");
  });

  it("still counts a zone on its own, as before", async () => {
    const { steps } = await status(["pet_waste"], { zones: 1 }, null);
    expect(steps.find((s) => s.id === "zones")!.done).toBe(true);
  });

  it("stays open with no zone and no price, or a $0 price", async () => {
    for (const std of [null, 0]) {
      const { steps } = await status(["pet_waste"], { clients: 1 }, std);
      expect(steps.find((s) => s.id === "zones")!.done, `std=${std}`).toBe(false);
      expect(next(steps)?.id).toBe("zones");
    }
  });

  it("finishes the pet-waste part of a multi-line business's price step too", async () => {
    const { steps } = await status(["pet_waste", "dog_walking"], {}, 2000);
    const area = steps.find((s) => s.id === "zones")!.parts!.find((p) => p.id === "area")!;
    expect(area.done).toBe(true);
  });

  it("saving the standard price refreshes the checklist", () => {
    const card = readFileSync(
      join(__dirname, "..", "src/components/StandardPricingCard.tsx"),
      "utf8",
    );
    expect(card).toMatch(/invalidateQueries\(\{ queryKey: \["onboarding-status"\] \}\)/);
  });
});

const OWNER_ALL_ON = {
  commercialEnabled: true,
  franchiseParent: true,
  petWaste: true,
  training: true,
  texting: true,
};

describe("Services is in the main sidebar", () => {
  it("is a sidebar entry of its own, to Settings, Services", async () => {
    const { NAV_GROUPS, isNavItemVisible } = await import("@/components/AppSidebar");
    const services = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.url === "/settings/services");
    expect(services, "no Services entry in NAV_GROUPS").toBeDefined();
    expect(services!.title).toBe("Services");
    expect(isNavItemVisible(services!, "owner", OWNER_ALL_ON)).toBe(true);
    expect(isNavItemVisible(services!, "office_manager", OWNER_ALL_ON)).toBe(true);
    // Same audience as the page (ROUTE_ROLES): not offered to a tech or a
    // dispatcher, who would be redirected straight back.
    expect(isNavItemVisible(services!, "tech", OWNER_ALL_ON)).toBe(false);
    expect(isNavItemVisible(services!, "dispatcher", OWNER_ALL_ON)).toBe(false);
  });

  it("is in the first-run sidebar too, not only behind 'Show all menus'", async () => {
    const { NAV_GROUPS, firstRunNav } = await import("@/components/AppSidebar");
    const { core } = firstRunNav(NAV_GROUPS, "owner", OWNER_ALL_ON);
    expect(core.map((i) => i.url)).toContain("/settings/services");
  });
});
