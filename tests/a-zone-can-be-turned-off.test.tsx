// A zone can be turned off without deleting it (#449).
//
// Off keeps the zone's shape, ZIPs and pricing, and skips it for zone
// detection, the signup page, lead quotes and new assignments. Clients
// already in it keep their schedule and price. On restores all of it without
// recreating the zone. Only an owner flips it, and turning off a zone with
// active clients asks first and says how many.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchZone, type ZoneMatchFields } from "@/lib/zone-match";
import { serviceAreaSummary } from "@/lib/booking-page";
import { computeZoneCoverage, describeCoverageProblem } from "@/lib/zone-coverage";
import { leadServiceArea } from "@/lib/lead-service-area";
import { pricingChoices, suggestedServicePrice, type QuotePricingZone } from "@/lib/quote-pricing";
import {
  activeClientsByZone,
  canToggleZone,
  offZoneNotice,
  toggledToast,
  turnOffConfirm,
  zoneStatusLabel,
} from "@/lib/zone-enabled";

const logged: any[] = [];
vi.mock("@/lib/activity.server", () => ({
  logActivity: async (_s: unknown, entry: unknown) => {
    logged.push(entry);
  },
}));

let role: string | null = "owner";
vi.mock("@/hooks/useMyRole", () => ({
  useMyRole: () => ({ role, orgId: "org-1", loading: false, accessTurnedOff: false }),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: any) => f,
  createServerFn: () => {
    const b: any = { middleware: () => b, inputValidator: () => b, handler: () => () => null };
    return b;
  },
}));
vi.mock("@/lib/zones.functions", () => ({ setZoneEnabled: vi.fn() }));

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const ZIP_ZONE = (over: Partial<ZoneMatchFields & { name: string }> = {}) => ({
  id: "z-north",
  name: "North",
  priority: 0,
  account_type: null,
  postal_prefix: null,
  zip_codes: ["48067"],
  geo_match_mode: "zip",
  boundary: null,
  center_latitude: null,
  center_longitude: null,
  radius_meters: null,
  drive_time_minutes: null,
  enabled: true,
  ...over,
});

const RADIUS_ZONE = {
  ...ZIP_ZONE({ id: "z-wide", name: "Wide", zip_codes: [] }),
  geo_match_mode: "radius",
  center_latitude: 42.49,
  center_longitude: -83.14,
  radius_meters: 20000,
};

const POINT = { lat: 42.4895, lng: -83.1446 };

describe("zone detection skips a zone that is off", () => {
  it("matches the zone while it is on", () => {
    expect(matchZone([ZIP_ZONE()], { postalCode: "48067" })?.id).toBe("z-north");
  });

  it("does not match it once it is off, and falls through to the next zone", () => {
    const off = ZIP_ZONE({ enabled: false });
    expect(matchZone([off], { postalCode: "48067", point: POINT })).toBeNull();
    expect(matchZone([off, RADIUS_ZONE], { postalCode: "48067", point: POINT })?.id).toBe("z-wide");
  });

  it("matches it again when it is turned back on, with nothing recreated", () => {
    const zone = ZIP_ZONE({ enabled: false });
    expect(matchZone([zone], { postalCode: "48067" })).toBeNull();
    zone.enabled = true;
    expect(matchZone([zone], { postalCode: "48067" })?.id).toBe("z-north");
  });

  it("treats a row read without the column as on", () => {
    const { enabled: _e, ...legacy } = ZIP_ZONE();
    expect(matchZone([legacy], { postalCode: "48067" })?.id).toBe("z-north");
  });

  it("every server-side zone read that feeds the matcher selects `enabled`", () => {
    for (const f of [
      "src/lib/address.functions.ts",
      "src/lib/properties.functions.ts",
      "src/lib/clients.functions.ts",
      "src/lib/receptionist-booking-store.server.ts",
      "src/lib/leads.functions.ts",
      "src/lib/quote-pricing.functions.ts",
      "src/lib/zones-redetect.server.ts",
      "src/lib/zone-coverage.functions.ts",
      "src/lib/zones.functions.ts",
    ]) {
      const src = read(f);
      // The row reads: they start at the id. updateZone's geometry check
      // re-reads one zone by id and is not a matcher feed.
      const selects = [...src.matchAll(/"(id, [^"\n]*drive_time_minutes[^"\n]*)"/g)].map(
        (m) => m[1],
      );
      expect(selects.length, `${f} reads no zone geometry`).toBeGreaterThan(0);
      for (const s of selects)
        expect(s, `${f} selects zones without enabled`).toMatch(/\benabled\b/);
    }
  });
});

describe("the signup page skips a zone that is off", () => {
  it("leaves its ZIPs out of 'Serving ZIP codes'", () => {
    const zones = [
      { zip_codes: ["48067"], postal_prefix: null, enabled: true },
      { zip_codes: ["48073"], postal_prefix: null, enabled: false },
    ];
    expect(serviceAreaSummary(zones)).toContain("48067");
    expect(serviceAreaSummary(zones)).not.toContain("48073");
    expect(serviceAreaSummary([{ ...zones[1], enabled: true }])).toContain("48073");
  });

  it("both signup reads select `enabled`", () => {
    const src = read("src/lib/signup.functions.ts");
    expect(src.match(/\.select\("zip_codes, postal_prefix, enabled"\)/g)?.length).toBe(2);
  });

  it("public_quote, the signup page and lead form price, is spliced to skip it", () => {
    const sql = read("supabase/migrations/20261029180000_a-zone-can-be-turned-off.sql");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true/);
    expect(sql).toMatch(/_from CONSTANT text := 'WHERE z\.organization_id = _org\.id';/);
    expect(sql).toMatch(/AND z\.enabled/);
    // The anchor is in the body the splice reads, exactly once.
    const body = read("supabase/migrations/20261024100900_keep-coming-soon-off-public-booking.sql");
    const fn = body.slice(body.indexOf("FUNCTION public.public_quote("));
    const end = fn.indexOf("$$;");
    expect(fn.slice(0, end).split("WHERE z.organization_id = _org.id").length - 1).toBe(1);
  });

  it("no later migration restates public_quote and drops the filter", () => {
    const files = readdirSync(join(root, "supabase/migrations")).sort();
    const after = files.filter((f) => f > "20261029180000");
    for (const f of after) {
      const sql = read(`supabase/migrations/${f}`);
      if (/CREATE OR REPLACE FUNCTION public\.public_quote\(/.test(sql))
        expect(sql, `${f} restates public_quote`).toMatch(/AND z\.enabled/);
    }
  });
});

describe("lead quotes skip a zone that is off", () => {
  const priced = (over: Partial<QuotePricingZone> = {}): QuotePricingZone =>
    ({ ...ZIP_ZONE(), base_price_cents: 3000, per_dog_addl_cents: 500, ...over }) as any;

  it("a lead in an off zone's ZIP gets the standard price, not the zone's", () => {
    const standard = { basePriceCents: 2500, perDogAddlCents: 0, frequencyMultipliers: {} };
    const on = suggestedServicePrice([priced()], standard, { postalCode: "48067" });
    expect(on?.source).toBe("zone");
    const off = suggestedServicePrice([priced({ enabled: false })], standard, {
      postalCode: "48067",
    });
    expect(off?.source).toBe("standard");
  });

  it("an existing client stored in the off zone keeps its price", () => {
    const r = suggestedServicePrice([priced({ enabled: false })], null, { zoneId: "z-north" });
    expect(r).toMatchObject({ source: "zone", zoneId: "z-north", priceCents: 3000 });
  });

  it("the price picker does not offer an off zone to someone new", () => {
    const zones = [priced({ enabled: false }), priced({ id: "z-south", name: "South" })];
    const ids = pricingChoices(zones, null, { postalCode: "99999" }).map((c) => c.zoneId);
    expect(ids).toEqual(["z-south"]);
  });

  it("the leads list does not call a lead inside an off zone", () => {
    const off = ZIP_ZONE({ enabled: false });
    expect(leadServiceArea("Troy, MI 48067", [ZIP_ZONE()])).toBe("inside");
    const src = read("src/lib/leads.functions.ts");
    expect(src).toMatch(/\.filter\(\s*\(z\) => z\.enabled !== false,?\s*\)/);
    expect(
      leadServiceArea(
        "Troy, MI 48067",
        [off].filter((z) => z.enabled !== false),
      ),
    ).toBe("unknown");
  });
});

// A supabase stand-in for redetectZonesForOrg: zones and properties in, the
// updates it writes out.
function fakeSupabase(zones: any[], properties: any[]) {
  const updates: Array<{ id: string; patch: any }> = [];
  const result = (data: any) => {
    const p: any = Promise.resolve({ data, error: null });
    p.eq = () => p;
    p.is = () => p;
    return p;
  };
  return {
    updates,
    from(table: string) {
      return {
        select: () => result(table === "zones" ? zones : properties),
        update: (patch: any) => ({
          eq: (_c: string, id: string) => {
            updates.push({ id, patch });
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}

const prop = (over: any = {}) => ({
  id: "p1",
  client_id: "c1",
  postal_code: "48067",
  latitude: null,
  longitude: null,
  account_type: null,
  auto_zone_id: null,
  zone_id: null,
  zone_override_reason: null,
  clients: null,
  ...over,
});

describe("auto-assignment (redetect) and routing", () => {
  beforeEach(() => {
    logged.length = 0;
  });

  it("leaves a property already in an off zone where it is", async () => {
    const { redetectZonesForOrg } = await import("@/lib/zones-redetect.server");
    const sb = fakeSupabase(
      [ZIP_ZONE({ enabled: false })],
      [prop({ zone_id: "z-north", auto_zone_id: "z-north" })],
    );
    expect(await redetectZonesForOrg(sb, "org-1", "u1")).toBe(0);
    expect(sb.updates).toEqual([]);
  });

  it("does not put a new property into an off zone", async () => {
    const { redetectZonesForOrg } = await import("@/lib/zones-redetect.server");
    const sb = fakeSupabase([ZIP_ZONE({ enabled: false })], [prop()]);
    expect(await redetectZonesForOrg(sb, "org-1", "u1")).toBe(0);
  });

  it("turning it back on pulls that property in", async () => {
    const { redetectZonesForOrg } = await import("@/lib/zones-redetect.server");
    const sb = fakeSupabase([ZIP_ZONE({ enabled: true })], [prop()]);
    expect(await redetectZonesForOrg(sb, "org-1", "u1")).toBe(1);
    expect(sb.updates[0].patch).toEqual({ auto_zone_id: "z-north", zone_id: "z-north" });
  });

  it("the coverage banner does not call a kept property an orphan", () => {
    const zones = [ZIP_ZONE({ enabled: false })] as any;
    const c = computeZoneCoverage(zones, [
      { id: "p1", postalCode: "48067", point: null, accountType: null, storedZoneId: "z-north" },
    ]);
    expect(c.orphaned).toBe(0);
    expect(c.perZone).toEqual([]);
    expect(describeCoverageProblem(c)).toBeNull();
  });

  it("routing never reads zones, so an off zone gains nothing to route", () => {
    for (const f of [
      "src/lib/auto-routing.server.ts",
      "src/lib/route-plan.server.ts",
      "src/lib/route-inputs.ts",
      "src/lib/routing-runs.functions.ts",
    ]) {
      expect(read(f), f).not.toMatch(/from\(["']zones["']\)/);
    }
  });
});

describe("owner only", () => {
  it("only an owner can toggle", () => {
    expect(canToggleZone("owner")).toBe(true);
    for (const r of ["office_manager", "dispatcher", "tech", null] as const)
      expect(canToggleZone(r as any), String(r)).toBe(false);
  });

  it("the server function checks the role before it writes", () => {
    const src = read("src/lib/zones.functions.ts");
    const fn = src.slice(src.indexOf("export const setZoneEnabled"));
    expect(fn.indexOf("canToggleZone(role)")).toBeGreaterThan(0);
    expect(fn.indexOf("canToggleZone(role)")).toBeLessThan(fn.indexOf(".update({ enabled"));
    expect(fn).toMatch(/logActivity/);
  });

  it("the database refuses anyone else through a trigger", () => {
    const sql = read("supabase/migrations/20261029180000_a-zone-can-be-turned-off.sql");
    expect(sql).toMatch(/BEFORE UPDATE OF enabled ON public\.zones/);
    expect(sql).toMatch(/ur\.role = 'owner'/);
  });

  const render = async (zone: any) => {
    const { ZoneEnabledSwitch } = await import("@/components/ZoneEnabledSwitch");
    const qc = new QueryClient();
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(ZoneEnabledSwitch, { zone }),
      ),
    );
  };

  it("an owner gets a working switch with a clear On / Off label", async () => {
    role = "owner";
    const html = await render({ id: "z1", name: "North", enabled: true });
    expect(html).toMatch(/role="switch"/);
    expect(html).not.toMatch(/disabled=""/);
    expect(html).toMatch(/>On</);
    const off = await render({ id: "z1", name: "North", enabled: false });
    expect(off).toMatch(/>Off</);
    expect(off).toMatch(/aria-checked="false"/);
  });

  it("a dispatcher sees the status but the switch is disabled", async () => {
    role = "dispatcher";
    const html = await render({ id: "z1", name: "North", enabled: false });
    expect(html).toMatch(/>Off</);
    expect(html).toMatch(/disabled=""/);
    expect(html).toMatch(/Only an owner can turn a zone on or off\./);
    role = "owner";
  });
});

describe("confirmation and copy", () => {
  it("counts distinct clients with an active service in each zone", () => {
    const counts = activeClientsByZone(
      [
        { id: "p1", client_id: "c1", zone_id: "z1" },
        { id: "p2", client_id: "c1", zone_id: "z1" },
        { id: "p3", client_id: "c2", zone_id: "z1" },
        { id: "p4", client_id: "c3", zone_id: "z2" },
        { id: "p5", client_id: "c4", zone_id: null },
      ],
      [
        { client_id: "c1", property_id: "p1" },
        { client_id: "c1", property_id: "p2" },
        { client_id: "c2", property_id: "p3" },
        { client_id: "c4", property_id: "p5" },
      ],
    );
    expect(counts).toEqual({ z1: 2 });
  });

  it("asks before turning off a zone with active clients, and shows the count", () => {
    expect(turnOffConfirm("North", 0)).toBeNull();
    const c = turnOffConfirm("North", 3)!;
    expect(c.title).toBe("Turn off North?");
    expect(c.description).toContain("3 active clients");
    expect(c.description).toContain("keep their schedule and price");
    expect(turnOffConfirm("North", 1)!.description).toContain("1 active client.");
  });

  it("says plainly that existing clients keep their schedule and pricing", () => {
    expect(offZoneNotice(2)).toContain("2 active clients in it keep their schedule and price.");
    expect(offZoneNotice(0)).toContain("Its shape, ZIPs and pricing are kept.");
    expect(zoneStatusLabel(true)).toBe("On");
    expect(zoneStatusLabel(false)).toBe("Off");
    expect(toggledToast("North", false)).toBe("North is off.");
    expect(toggledToast("North", true, 2)).toBe("North is on. 2 properties joined it.");
  });

  it("no em dashes in the new copy", () => {
    for (const f of [
      "src/lib/zone-enabled.ts",
      "src/components/ZoneEnabledSwitch.tsx",
      "supabase/migrations/20261029180000_a-zone-can-be-turned-off.sql",
    ])
      expect(read(f), f).not.toContain("—");
  });
});
