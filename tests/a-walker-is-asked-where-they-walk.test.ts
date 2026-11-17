// #958: setup must collect a service area for walkers, sitters, groomers and
// trainers.
//
// public_quote answers only for a ZIP some zone lists (acceptance 5 keeps
// that check), and setup asked for an area at a pet-waste business only:
// "A trainer's area is still on Zones." So a walker could finish setup, price
// every walk, share the booking link, and be out of area to every client.
//
// Pinned here, without a database:
//   1. a walker-, sitter-, groomer- or trainer-only business has an area part
//      on the price step, first, with no price in it, and the step is not
//      done until a zone exists -- whatever else is priced;
//   2. a mixed business keeps the pet-waste area form, and also needs a zone
//      when it runs one of those lines (a standard price alone no longer
//      finishes it); a pet-waste-only business is unchanged;
//   3. what /setup's area form sends createZone carries no price, and the
//      real createZone lists the ZIP at its middle and not one far away --
//      the list public_quote matches on;
//   4. public_quote still refuses a ZIP no zone lists (the product lock).
//
// The same chain on a real database, quote included:
// tests/integration/a-walker-is-in-area-once-setup-is-done.db.test.ts.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: state.db, userId: "user-1" } }),
    };
    return builder;
  },
  createServerOnlyFn: (fn: unknown) => fn,
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/zones-redetect.server", () => ({ redetectZonesForOrg: async () => 0 }));

const state = vi.hoisted(() => ({ db: null as any }));

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

import { loadOnboardingStatus, type OnboardingStep } from "@/lib/onboarding.functions";
import { setupServiceAreaZone } from "@/lib/setup-service-area";

// ── 1 and 2: the price step, as the server reads it ──────────────────────

type World = {
  zones?: number;
  walkPriceCents?: number;
  staySaved?: boolean;
  groomReviewed?: boolean;
  lessonsPriced?: boolean;
  /** The pet-waste standard price (Settings, Services), in cents. */
  standardCents?: number | null;
};

function statusDb(lines: string[], w: World) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      const eqs: Record<string, unknown> = {};
      for (const m of ["gt", "not", "is", "order", "limit"]) q[m] = () => q;
      q.eq = (k: string, v: unknown) => {
        eqs[k] = v;
        return q;
      };
      q.select = (c: string) => {
        cols = c;
        return q;
      };
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: "org-1" } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: lines } };
          if (cols === "groom_setup_reviewed_at")
            return { data: { groom_setup_reviewed_at: w.groomReviewed ? "2026-11-01" : null } };
          return { data: { contact_address: "12 Fixture Ln, Lansing, MI 48933" } };
        }
        if (table === "services" && eqs.service_line === "dog_walking")
          return {
            data: [30, 60].map((min) => ({
              base_price_cents: w.walkPriceCents ?? null,
              default_duration_min: min,
            })),
          };
        if (table === "services" && eqs.service_line === "pet_sitting")
          // #959: a stay counts as saved when it is priced AND written since
          // it was created.
          return {
            data: [
              { base_price_cents: 2500, created_at: "a", updated_at: w.staySaved ? "b" : "a" },
            ],
          };
        if (table === "services" && eqs.service_line === "pet_waste")
          return {
            data:
              w.standardCents == null
                ? []
                : [
                    {
                      id: "svc-waste",
                      name: "Pet waste removal",
                      service_line: "pet_waste",
                      base_price_cents: w.standardCents,
                      extra_pet_cents: 0,
                      active: true,
                    },
                  ],
          };
        if (table === "zones") return { count: w.zones ?? 0 };
        // #959: grooming is done with the review AND a priced size.
        if (table === "service_size_rules") return { count: w.groomReviewed ? 1 : 0 };
        if (table === "service_packages" || table === "training_skills")
          return { count: w.lessonsPriced ? 1 : 0 };
        return { count: 0, data: [] };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
}

async function priceStep(lines: string[], w: World = {}): Promise<OnboardingStep> {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[] }>;
  const { steps } = await load({ supabase: statusDb(lines, w), userId: "owner" });
  return steps.find((s) => s.id === "zones")!;
}

/** Everything a one-line business prices besides the area, all done. */
const LINE_DONE: Record<string, { part: string; world: World }> = {
  dog_walking: { part: "walks", world: { walkPriceCents: 2500 } },
  pet_sitting: { part: "stays", world: { staySaved: true } },
  mobile_grooming: { part: "grooms", world: { groomReviewed: true } },
  training: { part: "lessons", world: { lessonsPriced: true } },
};

describe("acceptance 1: a walker, sitter, groomer or trainer cannot finish the step without an area", () => {
  for (const [line, { part, world }] of Object.entries(LINE_DONE)) {
    describe(line, () => {
      it("asks for the service area first, on /setup, beside its own price", async () => {
        const step = await priceStep([line]);
        expect(step.to).toBe("/setup");
        expect(step.parts?.map((p) => p.id)).toEqual(["area", part]);
        const area = step.parts![0];
        expect(area).toMatchObject({ label: "Your service area", done: false, to: "/zones" });
        // No first cleanup, no per-visit waste price.
        expect(area.description).not.toMatch(/price|per visit|cleanup|pet waste/i);
        // The area is asked here now, not deferred to a page nobody had to open.
        expect(step.description).not.toMatch(/service area is on Zones/);
      });

      it("is not done with its price saved and no zone", async () => {
        const step = await priceStep([line], world);
        expect(step.parts!.find((p) => p.id === part)!.done).toBe(true);
        expect(step.parts!.find((p) => p.id === "area")!.done).toBe(false);
        expect(step.done).toBe(false);
      });

      it("is done once a zone exists and the price is saved", async () => {
        const step = await priceStep([line], { ...world, zones: 1 });
        expect(step.parts!.every((p) => p.done)).toBe(true);
        expect(step.done).toBe(true);
      });

      it("a zone alone does not finish it either", async () => {
        expect((await priceStep([line], { zones: 1 })).done).toBe(false);
      });
    });
  }

  it("two such lines get one area, then each line's price", async () => {
    const step = await priceStep(["dog_walking", "training"]);
    expect(step.parts?.map((p) => p.id)).toEqual(["area", "walks", "lessons"]);
    expect(step.parts!.filter((p) => p.id === "area")).toHaveLength(1);
    expect(step.description).toMatch(
      /Set your service area, and a price for each: walks and lessons/,
    );
  });
});

describe("acceptance 3: a mixed business keeps the waste area form, and needs a zone", () => {
  it("keeps the pet-waste area part, which also says the other services share it", async () => {
    const step = await priceStep(["pet_waste", "dog_walking"]);
    const area = step.parts!.find((p) => p.id === "area")!;
    expect(area.label).toBe("Pet waste service area");
    expect(area.description).toMatch(/what you charge per visit/);
    expect(area.description).toMatch(/other services are booked in the same area/);
  });

  it("a standard price alone does not finish its area; a zone does", async () => {
    // The same price that finishes a pet-waste-only business (below), so this
    // is the walking line's doing and not a price that was never read.
    const priceOnly = await priceStep(["pet_waste", "dog_walking"], { standardCents: 2000 });
    expect(priceOnly.parts!.find((p) => p.id === "area")!.done).toBe(false);
    const zoned = await priceStep(["pet_waste", "dog_walking"], { zones: 1 });
    expect(zoned.parts!.find((p) => p.id === "area")!.done).toBe(true);
  });

  it("a pet-waste-only business is unchanged: a standard price still finishes it", async () => {
    const step = await priceStep(["pet_waste"], { standardCents: 2000 });
    expect(step.parts).toBeUndefined();
    expect(step.label).toBe("Your service area and price");
    expect(step.done).toBe(true);
  });
});

// ── 3: what the form sends, through the real createZone ──────────────────

type Centroid = { zip: string; lat: number; lng: number; radiusM: number };
const CENSUS: Centroid[] = (() => {
  const sql = read("supabase/migrations/20261001120100_the-zip-centers-a-zone-is-filled-from.sql");
  const body = sql.slice(sql.indexOf("$zcta$") + 6, sql.lastIndexOf("$zcta$"));
  return body
    .trim()
    .split("\n")
    .map((l) => {
      const [zip, lat, lng, r] = l.split(",");
      return { zip, lat: Number(lat), lng: Number(lng), radiusM: Number(r) };
    });
})();
const centerOf = (zip: string) => {
  const c = CENSUS.find((x) => x.zip === zip)!;
  return { lat: c.lat, lng: c.lng };
};

function zoneDb() {
  const inserted: Record<string, any>[] = [];
  const ok = (data: unknown) => ({ data, error: null });
  return {
    inserted,
    rpc: async (name: string, a: any) => {
      if (name !== "zip_centroids_in_box") throw new Error(`unexpected rpc ${name}`);
      return ok(
        CENSUS.filter(
          (c) => c.lat >= a._south && c.lat <= a._north && c.lng >= a._west && c.lng <= a._east,
        )
          .slice(0, a._limit)
          .map((c) => ({ zip: c.zip, lat: c.lat, lng: c.lng, radius_m: c.radiusM })),
      );
    },
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        insert: (row: Record<string, any>) => {
          inserted.push(row);
          return chain;
        },
        single: async () => ok({ id: "zone-new" }),
        then: (resolve: (v: unknown) => unknown) => resolve(ok(table === "zones" ? [] : [])),
      };
      return chain;
    },
  };
}

describe("the area /setup saves for a walker", () => {
  beforeEach(() => {
    state.db = zoneDb();
  });

  it("carries no price: a walk is priced by the walk", () => {
    const sent = setupServiceAreaZone({
      name: "  ",
      center: centerOf("48933"),
      miles: 10,
    });
    expect(sent).toEqual({
      name: "Main service area",
      geoMatchMode: "radius",
      fillZipsFromShape: true,
      centerLatitude: centerOf("48933").lat,
      centerLongitude: centerOf("48933").lng,
      radiusMeters: Math.round(10 * 1609.344),
    });
    expect(Object.keys(sent).join(" ")).not.toMatch(/Price|Cents|Cleanup/);
  });

  it("is written by the real createZone listing the ZIP at its middle, not one far away", async () => {
    const { createZone } = await import("@/lib/zones.functions");
    await (createZone as unknown as (o: unknown) => Promise<unknown>)({
      data: setupServiceAreaZone({
        name: "Main service area",
        center: centerOf("48933"),
        miles: 10,
      }),
    });
    const row = state.db.inserted[0];
    expect(row.geo_match_mode).toBe("radius");
    expect(row.zip_codes).toContain("48933");
    expect(row.zip_codes).not.toContain("90210");
    expect(row.zip_fill_pending_since).toBeNull();
    // No override: the zone charges the standard price, if ever there is one.
    expect(row.base_price_cents).toBeNull();
    expect(row.per_dog_addl_cents).toBeNull();
    expect(row.initial_cleanup_cents).toBe(0);
  });
});

// ── 4 and the wiring ─────────────────────────────────────────────────────

describe("acceptance 5: public_quote keeps its zone check", () => {
  // The body public_quote was last restated in; later files splice it, and
  // none of them may drop the refusal.
  const body = read("supabase/migrations/20261024100900_keep-coming-soon-off-public-booking.sql");
  const fn = body.slice(
    body.indexOf("CREATE OR REPLACE FUNCTION public.public_quote("),
    body.indexOf("COMMENT ON FUNCTION public.public_quote"),
  );

  it("returns nothing for a ZIP no zone lists, before it prices any service", () => {
    const zoneSelect = fn.indexOf("SELECT z.* INTO _zone FROM public.zones z");
    expect(zoneSelect).toBeGreaterThan(-1);
    const refusal = fn.indexOf("IF NOT FOUND THEN RETURN; END IF;", zoneSelect);
    expect(refusal).toBeGreaterThan(zoneSelect);
    expect(refusal).toBeLessThan(fn.indexOf("public.service_price_cents("));
  });

  it("no migration after it restates public_quote without the zone check", () => {
    const later = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f > "20261024100900")
      .map((f) => read(`supabase/migrations/${f}`))
      .filter((s) => /CREATE OR REPLACE FUNCTION public\.public_quote\(/.test(s));
    for (const s of later) expect(s).toMatch(/SELECT z\.\* INTO _zone FROM public\.zones z/);
  });
});

describe("/setup draws the area-only form for a business that does not scoop", () => {
  const src = read("src/routes/_authenticated/setup.tsx");
  const panel = src.slice(
    src.indexOf("function PricesPanel("),
    src.indexOf("function ServiceAreaPanel("),
  );

  it("picks the form by whether the business scoops, and finishes only its part", () => {
    expect(panel).toMatch(/petWaste \? \(\s*<ServiceAreaPanel/);
    expect(panel).toMatch(/<ServiceAreaOnlyForm[\s\S]*?onSaved=\{partSaved\}/);
  });

  it("and the form sends what setupServiceAreaZone builds, with nothing priced", () => {
    const form = read("src/components/SetupServiceArea.tsx");
    expect(form).toMatch(/createFn\(\{ data: setupServiceAreaZone\(/);
    expect(form).not.toMatch(/adoptSetupAreaPrice|basePriceCents|initialCleanupCents/);
  });
});
