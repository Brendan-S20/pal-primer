// #769, the walker-only path: what the server says about a business whose
// only line is dog walking, from signup to a finished price step, with
// nothing written from Settings.
//
// Product's live check of 2026-11-11 passed a business that scoops AND walks;
// no walker-only business exists in production. Main already asks a walker
// the walk prices on /setup (#797, with the area part from #958) and the
// workday on step 1 (#797). This pins that, for ["dog_walking"] alone:
//
//   * the price step is "Price your walks", on /setup, with an area part and
//     a walks part, and it is done only when a zone exists AND the 30- and
//     60-minute walks are priced; the drop-in may stay blank (acceptance 1,
//     4), read by the REAL loadOnboardingStatus;
//   * step 1 writes the hours the owner saw, 08:00-17:00 included, so the
//     column default is never left silent (acceptance 2);
//   * what /setup writes is what Settings reads: services.base_price_cents
//     (Settings, Services) and organizations.workday_start/end (Settings,
//     Scheduling) (acceptance 3).
//
// tests/viewports/a-walker-only-business-finishes-setup-without-settings.spec.ts
// drives the same path in a browser at 390 and 1440 on the fixture backend;
// tests/integration/a-walking-signup-prices-its-walks-on-setup.db.test.ts
// runs the walk half on a real database.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => builder, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { loadOnboardingStatus, type OnboardingStep } from "@/lib/onboarding.functions";
import {
  SETUP_WORKDAY_DEFAULTS,
  workdayField,
  workdayWriteFor,
  workdayWriteProblem,
} from "@/lib/setup-workday";
import { DEFAULT_WORKDAY_END, DEFAULT_WORKDAY_START } from "@/lib/route-window";
import { servicePriceLabel } from "@/lib/services";

const root = join(import.meta.dirname, "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

const ORG = "org-walker-only";
type Walk = { id: string; default_duration_min: number; base_price_cents: number | null };

/** A walker-only business as the server would read it. */
function walker({
  address = null as string | null,
  zones = 0,
  prices = {} as Partial<Record<30 | 60 | 20, number | null>>,
} = {}) {
  const walks: Walk[] = ([30, 60, 20] as const).map((min) => ({
    id: `walk-${min}`,
    default_duration_min: min,
    base_price_cents: prices[min] ?? null,
  }));
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      const eqs: Record<string, unknown> = {};
      for (const m of ["gt", "not", "in", "is", "order", "limit"]) q[m] = () => q;
      q.eq = (k: string, v: unknown) => {
        eqs[k] = v;
        return q;
      };
      q.select = (c: string) => {
        cols = c;
        return q;
      };
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: ORG } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: ["dog_walking"] } };
          return { data: { contact_address: address } };
        }
        if (table === "services" && eqs.service_line === "dog_walking") return { data: walks };
        if (table === "services") return { data: [] };
        if (table === "zones") return { count: zones };
        return { count: 0, data: null };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
  return { supabase, userId: "owner" } as never;
}

async function steps(ctx: never): Promise<OnboardingStep[]> {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[] }>;
  return (await load(ctx)).steps;
}
const step = async (ctx: never, id: string) => (await steps(ctx)).find((s) => s.id === id)!;

describe("#769 a walker-only business: the price step is asked on /setup", () => {
  it("a new signup's price step is the walks, on /setup, with an area part and a walks part, open", async () => {
    const s = await step(walker(), "zones");
    expect(s.label).toBe("Price your walks");
    expect(s.to).toBe("/setup");
    expect(s.done).toBe(false);
    expect(s.parts?.map((p) => [p.id, p.done])).toEqual([
      ["area", false],
      ["walks", false],
    ]);
    // Nothing on the step says the area is elsewhere: it is asked here.
    expect(s.description).not.toMatch(/on Zones/);
    expect(s.description).toMatch(/30-minute walk and a 60-minute walk/);
  });

  it("/setup draws the walks part as a form, not a link (INLINE_PARTS)", () => {
    const setup = src("src/routes/_authenticated/setup.tsx");
    const inline = setup.match(/const INLINE_PARTS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "";
    expect(inline).toMatch(/"walks"/);
    expect(inline).toMatch(/"area"/);
  });

  for (const [what, prices] of [
    ["the 30-minute walk alone", { 30: 2500 }],
    ["the 60-minute walk alone", { 60: 4000 }],
    ["the drop-in alone", { 20: 1800 }],
  ] as const) {
    it(`is not done with ${what} priced, even with the area saved`, async () => {
      const s = await step(walker({ zones: 1, prices }), "zones");
      expect(s.done).toBe(false);
      expect(s.parts?.find((p) => p.id === "walks")?.done).toBe(false);
    });
  }

  it("is not done with both walks priced and no area", async () => {
    const s = await step(walker({ prices: { 30: 2500, 60: 4000 } }), "zones");
    expect(s.parts?.find((p) => p.id === "walks")?.done).toBe(true);
    expect(s.done).toBe(false);
  });

  it("is done with the area and the 30 and 60 priced, the drop-in left blank, still on /setup", async () => {
    const s = await step(walker({ zones: 1, prices: { 30: 2500, 60: 4000 } }), "zones");
    expect(s.done).toBe(true);
    expect(s.to).toBe("/setup");
    expect(s.parts?.every((p) => p.done)).toBe(true);
  });
});

describe("#769 a walker-only business: the workday is asked on step 1", () => {
  it("step 1 is done once its Save writes the address, which is the Save that writes the hours", async () => {
    expect((await step(walker(), "business")).done).toBe(false);
    expect((await step(walker({ address: "1 Main St" }), "business")).done).toBe(true);
    // The address and the hours are one Save on /setup: the dispatch write
    // carries workdayWrite, after the branding write that sets the address.
    const setup = src("src/routes/_authenticated/setup.tsx");
    expect(setup).toMatch(
      /const dispatchWrite = \{ \.\.\.\(writeTz \? \{ timezone: tzVal \} : \{\}\), \.\.\.workdayWrite \};/,
    );
    // Not gated on a line: the fieldset is drawn for every business.
    const before = setup.slice(0, setup.indexOf("data-setup-workday>"));
    const opener = before.slice(before.lastIndexOf("\n", before.lastIndexOf("<fieldset")));
    expect(opener.trim().startsWith("<fieldset")).toBe(true);
  });

  it("shows the stored hours, the column's 08:00-17:00 for a new business", () => {
    expect(SETUP_WORKDAY_DEFAULTS).toEqual({
      start: DEFAULT_WORKDAY_START,
      end: DEFAULT_WORKDAY_END,
    });
    expect(workdayField("08:00:00", "x")).toBe("08:00");
    expect(workdayField("17:00:00", "x")).toBe("17:00");
  });

  it("saved untouched, it still WRITES 08:00-17:00: confirmed, not left silent", () => {
    expect(
      workdayWriteFor({
        typedStart: null,
        typedEnd: null,
        loaded: true,
        start: workdayField("08:00:00", SETUP_WORKDAY_DEFAULTS.start),
        end: workdayField("17:00:00", SETUP_WORKDAY_DEFAULTS.end),
      }),
    ).toEqual({ workday_start: "08:00", workday_end: "17:00" });
  });

  it("writes what the owner typed, and refuses a day that ends before it starts", () => {
    const typed = workdayWriteFor({
      typedStart: "07:00",
      typedEnd: "15:30",
      loaded: true,
      start: "07:00",
      end: "15:30",
    });
    expect(typed).toEqual({ workday_start: "07:00", workday_end: "15:30" });
    expect(workdayWriteProblem(typed)).toBeNull();
    expect(workdayWriteProblem({ workday_start: "15:00", workday_end: "09:00" })).toBe(
      "Your workday has to end after it starts.",
    );
  });
});

describe("#769 what /setup writes is where Settings reads it", () => {
  it("walk prices: setSetupWalkPrices writes services.base_price_cents, which Settings, Services lists", () => {
    const fn = src("src/lib/setup-walk-prices.functions.ts");
    expect(fn).toMatch(/\.from\("services"\)\s*\.update\(\{ base_price_cents: p\.cents \}\)/);
    const services = src("src/lib/services.functions.ts");
    expect(services).toMatch(/\.from\("services"\)\s*\.select\(SERVICE_COLUMNS\)/);
    const columns =
      services.match(/SERVICE_COLUMNS\s*=\s*([^;]+);/)?.[1] ?? src("src/lib/services.ts");
    expect(columns).toMatch(/base_price_cents/);
    // And the label a walk priced on /setup gets there.
    const walk = { service_line: "dog_walking", price_unit: "visit", extra_pet_cents: 0 } as const;
    expect(servicePriceLabel({ ...walk, base_price_cents: 2500 })).toBe("$25.00 per visit");
    expect(servicePriceLabel({ ...walk, base_price_cents: null })).toBe("No price yet");
  });

  it("the workday: step 1 and Settings, Scheduling save and read through the same pair", () => {
    const setup = src("src/routes/_authenticated/setup.tsx");
    expect(setup).toMatch(/const saveDispatchFn = useServerFn\(updateDispatchSettings\)/);
    expect(setup).toMatch(/const dispatchFn = useServerFn\(getDispatchSettings\)/);
    const scheduling = src("src/routes/_authenticated/settings.scheduling.tsx");
    expect(scheduling).toMatch(/useServerFn\(getDispatchSettings\)/);
    expect(scheduling).toMatch(/useServerFn\(updateDispatchSettings\)/);
    const visits = src("src/lib/visits.functions.ts");
    expect(visits).toMatch(/_workday_start: rest\.workday_start/);
    expect(visits).toMatch(/_workday_end: rest\.workday_end/);
    expect(visits).toMatch(/"workday_start, workday_end, /);
  });
});
