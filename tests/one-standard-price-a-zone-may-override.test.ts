// #860 and #864, as decided by Brendan on 2026-11-10: "Approve, but this
// should be a setting".
//
//   * Each service has ONE standard price, set in Settings → Services. For
//     pet waste that is services.base_price_cents + extra_pet_cents.
//   * A zone may override it, and the override applies only inside that
//     zone. NULL on the zone is "no override".
//   * Every place that offers a price reads that one setting: the new-client
//     wizard and the dispatcher's set price (internalQuote), the office's
//     one-off (booking-price.server.ts), quotes (quote-pricing.functions.ts),
//     the plan form (getStandardPricing), and the signup (public_quote).
//   * Existing plans keep their saved price.
//   * Zones & pricing opens inside Settings at /settings/zones, and /zones
//     forwards there.
//
// What the tester found (QA, 2026-11-10): $20 saved as Standard pricing under
// Business defaults, then the new-client Plan step said "No zone matches ZIP
// 48933. Set price manually below." and Services said "Plans: no zone price
// yet". The first describe below is that walk-through, against the code that
// prices it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultPetWasteService,
  petWasteVisitRate,
  rateVisitCents,
  zoneOverridesPrice,
} from "@/lib/standard-price";
import { internalQuote } from "@/lib/internal-quote.server";
import { oneOffGridPriceCents } from "@/lib/booking-price.server";
import { canAccess } from "@/hooks/useMyRole";
import { APP_LINK_PATH_PREFIXES } from "@/lib/android-app-links";

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

// ── A tiny in-memory Supabase: enough of the query builder for these readers.
type Row = Record<string, any>;
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const chain: any = {
        select: () => chain,
        order: () => chain,
        not: () => chain,
        eq: (col: string, v: unknown) => {
          filters.push((r) => r[col] === v);
          return chain;
        },
        single: async () => ({ data: rows()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (res: any) => res({ data: rows(), count: rows().length, error: null }),
      };
      return chain;
    },
  };
}

const ORG = "org-1";
const STD_SERVICE = {
  id: "svc-std",
  organization_id: ORG,
  name: "Pet waste removal",
  service_line: "pet_waste",
  active: true,
  price_unit: "visit",
  base_price_cents: 2000,
  extra_pet_cents: 500,
  default_duration_min: null,
};
const org = { id: ORG, currency: "usd", frequency_multipliers: {}, one_off_price_cents: null };
const zone = (over: Row) => ({
  organization_id: ORG,
  priority: 0,
  account_type: null,
  postal_prefix: null,
  geo_match_mode: "zip",
  pricing_mode: "flat",
  enabled: true,
  initial_cleanup_cents: 0,
  per_dog_addl_cents: null,
  base_price_cents: null,
  ...over,
});
// Downtown overrides the standard; Midtown is a zone with no price of its own.
const DOWNTOWN = zone({
  id: "z-down",
  name: "Downtown",
  zip_codes: ["48226"],
  base_price_cents: 3000,
  per_dog_addl_cents: 700,
});
const MIDTOWN = zone({ id: "z-mid", name: "Midtown", zip_codes: ["48201"] });

const db = (over: Partial<Record<string, Row[]>> = {}) =>
  fakeDb({
    organizations: [org],
    services: [STD_SERVICE],
    zones: [DOWNTOWN, MIDTOWN],
    ...over,
  } as Record<string, Row[]>);

const quote = (postalCode: string, dogCount = 1, d = db()) =>
  internalQuote(d, ORG, { postalCode, dogCount, frequency: "weekly" });

describe("the tester's walk-through: $20 saved, then a new client (#860)", () => {
  it("prefills $20 on the Plan step for a ZIP no zone covers", async () => {
    const q = await quote("48933");
    expect(q.available).toBe(true);
    if (!q.available) return;
    expect(q.quote.recurringPriceCents).toBe(2000);
    expect(q.quote.priceSource).toBe("standard");
    expect(q.quote.zoneId).toBeNull();
  });

  it("no longer says 'no zone price yet' on Services once $20 is saved", () => {
    const services = read("src/routes/_authenticated/settings.services.tsx");
    expect(services).not.toMatch(/no zone price yet/);
    expect(read("src/lib/services.ts")).not.toMatch(/no zone price yet/);
  });
});

describe("one price source, used everywhere (#860)", () => {
  it("the rule: an override inside its zone, the standard price everywhere else", () => {
    const std = { base_price_cents: 2000, extra_pet_cents: 500 };
    expect(petWasteVisitRate(std, null)).toEqual({
      baseCents: 2000,
      perDogCents: 500,
      source: "standard",
    });
    expect(petWasteVisitRate(std, { base_price_cents: null, per_dog_addl_cents: null })).toEqual({
      baseCents: 2000,
      perDogCents: 500,
      source: "standard",
    });
    expect(petWasteVisitRate(std, { base_price_cents: 3000, per_dog_addl_cents: 700 })).toEqual({
      baseCents: 3000,
      perDogCents: 700,
      source: "zone",
    });
    // A zone override of $0 is a real price, not "no override".
    expect(petWasteVisitRate(std, { base_price_cents: 0, per_dog_addl_cents: 0 })?.baseCents).toBe(
      0,
    );
    // Nothing set: no price, never a number made up here.
    expect(petWasteVisitRate({ base_price_cents: null, extra_pet_cents: 0 }, null)).toBeNull();
    expect(rateVisitCents({ baseCents: 2000, perDogCents: 500 }, 3)).toBe(3000);
  });

  it("the default pet-waste service is the seeded one, then the first by name", () => {
    const s = (id: string, name: string, extra: Row = {}) => ({
      id,
      name,
      service_line: "pet_waste",
      active: true,
      base_price_cents: 1,
      extra_pet_cents: 0,
      ...extra,
    });
    expect(
      defaultPetWasteService([s("a", "Weekly scoop - 1 dog"), s("b", "Pet waste removal")])?.id,
    ).toBe("b");
    expect(
      defaultPetWasteService([
        s("a", "Weekly scoop"),
        s("b", "Biweekly scoop"),
        s("c", "Pet waste removal", { active: false }),
      ])?.id,
    ).toBe("b");
    expect(defaultPetWasteService([s("w", "Walk", { service_line: "dog_walking" })])).toBeNull();
  });

  it("the new-client quote: a zone with no price of its own charges the standard", async () => {
    const q = await quote("48201", 2);
    if (!q.available) throw new Error("expected a quote");
    expect(q.quote.zoneId).toBe("z-mid");
    expect(q.quote.priceSource).toBe("standard");
    expect(q.quote.recurringPriceCents).toBe(2500);
  });

  it("the chosen pet-waste service's own standard price, not the default's", async () => {
    const other = {
      ...STD_SERVICE,
      id: "svc-weekly",
      name: "Weekly scoop",
      base_price_cents: 1800,
    };
    const d = db({ services: [STD_SERVICE, other] });
    const q = await internalQuote(d, ORG, {
      postalCode: "48933",
      dogCount: 1,
      frequency: "weekly",
      serviceId: "svc-weekly",
    });
    if (!q.available) throw new Error("expected a quote");
    expect(q.quote.recurringPriceCents).toBe(1800);
  });

  it("with no standard price and no zone, the Plan step still asks a person", async () => {
    const d = db({ services: [{ ...STD_SERVICE, base_price_cents: null }] });
    expect((await quote("48933", 1, d)).available).toBe(false);
    const inMidtown = await quote("48201", 1, d);
    if (!inMidtown.available) throw new Error("the zone still matches");
    expect(inMidtown.quote.recurringPriceCents).toBeNull();
  });

  it("the office's one-off: no extra-visit price set reads the standard price", async () => {
    const d = db({
      properties: [{ id: "p-1", organization_id: ORG, zone_id: null }],
      dogs: [],
    });
    expect(await oneOffGridPriceCents(d, { orgId: ORG, propertyId: "p-1" })).toEqual({
      cents: 2000,
      reason: null,
    });
    // An extra-visit price the owner set still wins (#641).
    const set = db({
      organizations: [{ ...org, one_off_price_cents: 7500 }],
      properties: [{ id: "p-1", organization_id: ORG, zone_id: null }],
    });
    expect((await oneOffGridPriceCents(set, { orgId: ORG, propertyId: "p-1" })).cents).toBe(7500);
  });

  it("every reader goes through the one rule, and nothing reads the old Business-defaults pair", () => {
    for (const f of [
      "src/lib/internal-quote.server.ts",
      "src/lib/booking-price.server.ts",
      "src/lib/pricing-drift.functions.ts",
    ])
      expect(read(f), f).toMatch(/petWasteVisitRate/);
    for (const f of [
      "src/lib/subscriptions.functions.ts",
      "src/lib/quote-pricing.functions.ts",
      "src/lib/internal-quote.server.ts",
    ])
      expect(read(f), f).toMatch(/loadPetWasteStandard/);
    expect(read("src/components/client-detail/ServicesTab.tsx")).toMatch(
      /zoneOverridesPrice\(pricingZone\)/,
    );
    expect(read("src/components/ZoneDrawer.tsx")).toMatch(/standardPriceLine\(/);

    // organizations.std_base_price_cents is written by the setup step while
    // it is empty, and read for a price by nothing.
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name) && read(rel).includes("std_base_price_cents"))
          readers.push(rel);
      }
    };
    walk("src");
    expect(readers.sort()).toEqual([
      "src/integrations/supabase/types.ts",
      "src/lib/setup-price.functions.ts",
    ]);
    // And the screen that used to edit it says where the price went.
    const business = read("src/routes/_authenticated/settings.business.tsx");
    expect(business).not.toMatch(/StandardPricingCard/);
    expect(business).toMatch(/to="\/settings\/services"/);
  });
});

describe("the zone override applies only inside its zone (#860)", () => {
  it("inside Downtown, Downtown's price", async () => {
    const q = await quote("48226", 2);
    if (!q.available) throw new Error("expected a quote");
    expect(q.quote.zoneId).toBe("z-down");
    expect(q.quote.priceSource).toBe("zone");
    expect(q.quote.recurringPriceCents).toBe(3700);
  });

  it("outside it, the standard price, whatever Downtown charges", async () => {
    for (const zip of ["48201", "48933"]) {
      const q = await quote(zip, 2);
      if (!q.available) throw new Error("expected a quote");
      expect(q.quote.priceSource, zip).toBe("standard");
      expect(q.quote.recurringPriceCents, zip).toBe(2500);
    }
  });

  it("the office's one-off follows the property's zone the same way", async () => {
    const d = db({
      properties: [
        { id: "p-down", organization_id: ORG, zone_id: "z-down" },
        { id: "p-mid", organization_id: ORG, zone_id: "z-mid" },
      ],
    });
    expect((await oneOffGridPriceCents(d, { orgId: ORG, propertyId: "p-down" })).cents).toBe(3000);
    expect((await oneOffGridPriceCents(d, { orgId: ORG, propertyId: "p-mid" })).cents).toBe(2000);
  });

  it("an override is a set base price; NULL is the standard", () => {
    expect(zoneOverridesPrice({ base_price_cents: null, per_dog_addl_cents: 500 })).toBe(false);
    expect(zoneOverridesPrice({ base_price_cents: 2500, per_dog_addl_cents: null })).toBe(true);
    // The drawer sends a blank box as null, and a new zone starts blank.
    const drawer = read("src/components/ZoneDrawer.tsx");
    expect(drawer).toMatch(/basePriceCents: basePrice\.trim\(\) \? .* : null/);
    expect(read("src/lib/zones.functions.ts")).toMatch(
      /base_price_cents: data\.basePriceCents \?\? null/,
    );
  });
});

describe("the signup's public_quote applies the same rule (migration 20261110150000)", () => {
  const MIG =
    "supabase/migrations/20261110150000_a-service-has-one-standard-price-and-a-zone-may-override-it.sql";
  const sql = read(MIG);
  const unquote = (s: string) => s.replace(/''/g, "'");

  /** The body as the database holds it before this file: 20261024100900's
   *  definition with every later splice applied, as each one applies it. */
  function bodyBefore(): string {
    const src = read("supabase/migrations/20261024100900_keep-coming-soon-off-public-booking.sql");
    let body = src.slice(
      src.indexOf("CREATE OR REPLACE FUNCTION public.public_quote("),
      src.indexOf("COMMENT ON FUNCTION public.public_quote("),
    );
    const later = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f > "20261024100900" && f < "20261110150000")
      .filter((f) =>
        read(`supabase/migrations/${f}`).includes(
          "'public.public_quote(text, text, integer, text, text, uuid)'::regprocedure",
        ),
      );
    expect(later.length).toBeGreaterThanOrEqual(4);
    for (const f of later) {
      const s = read(`supabase/migrations/${f}`);
      for (const m of s.matchAll(
        /_from\s+CONSTANT text := '((?:[^']|'')*)';\s*_to\s+CONSTANT text := '((?:[^']|'')*)';/g,
      )) {
        const [from, to] = [unquote(m[1]), unquote(m[2])];
        if (body.split(from).length === 2) body = body.replace(from, to);
      }
    }
    return body;
  }

  function spliced(): string {
    let body = bodyBefore();
    const pairs = [
      ...sql.matchAll(
        /_(\w+)_from CONSTANT text := '((?:[^']|'')*)';\s*_\1_to\s+CONSTANT text := '((?:[^']|'')*)';/g,
      ),
    ];
    expect(pairs.map((p) => p[1])).toEqual(["decl", "base", "dog"]);
    for (const [, , from, to] of pairs) {
      const f = unquote(from);
      expect(body.split(f).length - 1, `anchor ${f.slice(0, 40)}`).toBe(1);
      body = body.replace(f, unquote(to));
    }
    return body;
  }

  it("each anchor is in today's body exactly once, so the splice applies", () => {
    expect(spliced()).toContain("_rate_base");
  });

  it("charges the zone's override, else the service's standard price", () => {
    const body = spliced();
    expect(body).toMatch(
      /IF _zone\.base_price_cents IS NOT NULL THEN\s*_rate_base := _zone\.base_price_cents;/,
    );
    expect(body).toMatch(
      /ELSIF _svc\.base_price_cents IS NOT NULL THEN\s*_rate_base := _svc\.base_price_cents;/,
    );
    expect(body).toContain(
      "_base_visit_cents := _rate_base + GREATEST(_dog_count - 1, 0) * _rate_dog;",
    );
    expect(body).toContain("per_dog_addl_cents := _rate_dog;");
    expect(body).not.toContain("_zone.base_price_cents + GREATEST");
    // Every earlier splice survives, because the body is never retyped.
    expect(body).toMatch(/AND z\.enabled/);
    expect(body).toMatch(/_mult := _mult \/ 2/);
  });

  it("picks the default pet-waste service the way defaultPetWasteService does", () => {
    expect(spliced()).toContain(
      "ORDER BY (s.name = 'Pet waste removal') DESC, lower(s.name), s.id",
    );
    expect(read("src/lib/standard-price.ts")).toMatch(
      /Number\(b\.name === PET_WASTE_SERVICE_NAME\)/,
    );
  });

  it("makes the zone columns nullable, copies a saved Business-defaults price onto unpriced services, and is checked", () => {
    expect(sql).toMatch(/ALTER COLUMN base_price_cents DROP NOT NULL/);
    expect(sql).toMatch(/ALTER COLUMN base_price_cents DROP DEFAULT/);
    expect(sql).toMatch(/ALTER COLUMN per_dog_addl_cents DROP NOT NULL/);
    expect(sql).toMatch(
      /AND s\.base_price_cents IS NULL\s*AND o\.std_base_price_cents IS NOT NULL/,
    );
    expect(sql).toMatch(/RAISE EXCEPTION 'public_quote does not read the standard price/);
  });
});

describe("existing plans keep their saved price (#860)", () => {
  it("the migration does not touch a plan, and neither does anything that sets the standard", () => {
    const code = read(
      "supabase/migrations/20261110150000_a-service-has-one-standard-price-and-a-zone-may-override-it.sql",
    )
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/subscriptions/);
    expect(read("src/lib/standard-price.ts")).not.toMatch(/from\("subscriptions"\)/);
    // Settings → Services saves the service row and nothing else.
    const services = read("src/lib/services.functions.ts");
    expect(services).not.toMatch(/from\("subscriptions"\)\s*\.update/);
  });

  it("the plan form offers the price to a NEW plan only, into an empty box", () => {
    const tab = read("src/components/client-detail/ServicesTab.tsx");
    expect(tab).toMatch(
      /if \(subscription \|\| prefilledPrice\.current \|\| !petWastePlan \|\| offeredCents == null\) return;/,
    );
    expect(tab).toMatch(/f\.priceDollars\.trim\(\) === "" \? \{ \.\.\.f, priceDollars:/);
  });

  it("drift measures a plan in a zone with no price of its own against the standard", () => {
    const drift = read("src/lib/pricing-drift.functions.ts");
    expect(drift).toMatch(/base_price_cents: rate \? rate\.baseCents : z\.base_price_cents/);
    expect(drift).not.toMatch(/\.update\(/);
  });
});

describe("Zones & pricing opens inside Settings (#864)", () => {
  it("/zones forwards to /settings/zones, keeping the search, with no Back trap", () => {
    const alias = read("src/routes/_authenticated/zones.tsx");
    expect(alias).toMatch(/createFileRoute\("\/_authenticated\/zones"\)/);
    expect(alias).toMatch(/<RedirectFallback to="\/settings\/zones"/);
    expect(alias).toMatch(/clientRedirect: true/);
    const fallback = read("src/components/RedirectFallback.tsx");
    expect(fallback).toMatch(/replace: true, search: \(s: Record<string, unknown>\) => s/);
  });

  it("the page is a child of the Settings layout, so the Settings menu stays", () => {
    const page = read("src/routes/_authenticated/settings.zones.tsx");
    expect(page).toMatch(/createFileRoute\("\/_authenticated\/settings\/zones"\)/);
    const tree = read("src/routeTree.gen.ts");
    expect(tree).toMatch(
      /AuthenticatedSettingsZonesRouteImport\.update\(\{\s*id: '\/zones',\s*path: '\/zones',\s*getParentRoute: \(\) => AuthenticatedSettingsRoute,/,
    );
    expect(tree).toMatch(/AuthenticatedSettingsZonesRoute: AuthenticatedSettingsZonesRoute,/);
  });

  it("the Settings menu item, and the links inside Settings, go to /settings/zones", () => {
    expect(read("src/routes/_authenticated/settings.tsx")).toContain(
      '{ label: "Zones & pricing", to: "/settings/zones" }',
    );
    expect(read("src/components/settings/PetWastePriceFields.tsx")).toContain(
      'to="/settings/zones"',
    );
    expect(read("src/routes/_authenticated/settings.online-signup.tsx")).toContain(
      'to="/settings/zones"',
    );
    expect(read("src/routes/_authenticated/settings.tsx")).not.toContain('to: "/zones"');
  });

  it("the same roles open it as opened /zones", () => {
    for (const role of ["owner", "office_manager", "dispatcher", "tech"] as const)
      expect(canAccess(role, "/settings/zones"), role).toBe(canAccess(role, "/zones"));
    expect(canAccess("dispatcher", "/settings/zones")).toBe(true);
    expect(canAccess("tech", "/settings/zones")).toBe(false);
  });

  it("opens in the Android app at both addresses", () => {
    expect(APP_LINK_PATH_PREFIXES).toContain("/settings/zones");
    expect(APP_LINK_PATH_PREFIXES).toContain("/zones");
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain(
      'android:pathPrefix="/settings/zones"',
    );
  });
});
