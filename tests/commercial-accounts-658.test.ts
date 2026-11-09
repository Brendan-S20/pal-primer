// #658: commercial accounts. A commercial plan is quoted and keeps its zone,
// "Use <zone>" does not trip subscriptions_account_shape_chk, a station log
// is written only by somebody servicing the station, and the office's
// Complete asks what the tech's does.
//
// The handlers run against a stub client. Nothing reaches a real Supabase.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeCommercialZonePrice, zoneHasCommercialPricing } from "@/lib/pricing";
import { OFFICE_COMPLETE_ASKS_WHY, officeCompleteOverrideAsk } from "@/lib/visit-lifecycle";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const migrationFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** The body of the last CREATE of `fn` across the migrations, in order. */
function latestDefinitionOf(fn: string): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  const head = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`);
  for (const f of migrationFiles) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const m = head.exec(sql);
    if (!m) continue;
    let at = m.index;
    let next: RegExpExecArray | null;
    const all = new RegExp(head.source, "g");
    while ((next = all.exec(sql))) at = next.index;
    const end = sql.indexOf("$function$;", at);
    found = { file: f, body: sql.slice(at, end === -1 ? undefined : end) };
  }
  if (!found) throw new Error(`${fn} is never defined`);
  return found;
}

const VISIT = "11111111-1111-4111-8111-111111111111";
const ASK = `This visit has no completion photo. ${OFFICE_COMPLETE_ASKS_WHY}`;

const state = vi.hoisted(() => ({
  rpc: vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({
    data: null,
    error: null as null | { message: string },
  })),
  activity: vi.fn(async (_db: unknown, _entry: Record<string, unknown>) => {}),
}));

function stubClient() {
  const rowFor = (table: string) =>
    table === "organizations"
      ? { timezone: "America/Detroit" }
      : table === "visits"
        ? {
            id: VISIT,
            organization_id: "org-1",
            client_id: "client-1",
            property_id: "prop-1",
            scheduled_on: "2000-01-01",
            status: "scheduled",
          }
        : null;
  return {
    from() {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "order", "limit"]) q[m] = () => q;
      q.single = async () => ({ data: rowFor("visits"), error: null });
      q.maybeSingle = async () => ({ data: rowFor("organizations"), error: null });
      return q;
    },
    rpc: state.rpc,
  };
}

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
          fn({ data: validate(args?.data), context: { supabase: stubClient(), userId: "user-1" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: state.activity }));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));

const { completeVisitFromOffice } = await import("@/lib/visits.functions");
const { countsFor } = await import("@/lib/subscriptions.functions");
const { completeFromOffice } = await import("@/components/OfficeCompleteOverride");
const call = (data: unknown) =>
  (completeVisitFromOffice as unknown as (a: { data: unknown }) => Promise<unknown>)({ data });

beforeEach(() => {
  state.rpc.mockReset();
  state.rpc.mockImplementation(async () => ({ data: null, error: null }));
  state.activity.mockClear();
});

describe("R2-21: a commercial account is quoted and keeps its zone", () => {
  it("prices $40 + $6 × 8 stations at $88", () => {
    const zone = {
      commercial_base_cents: 4000,
      commercial_per_unit_cents: 0,
      commercial_per_acre_cents: 0,
      commercial_per_station_cents: 600,
    };
    expect(zoneHasCommercialPricing(zone)).toBe(true);
    const p = computeCommercialZonePrice(zone, { unitCount: 1, stationCount: 8, multiplier: 1 });
    expect(p.recurringCents).toBe(8800);
  });

  it("the quote reads the zone's commercial rates and units and stations", () => {
    // The quote itself moved to internal-quote.server.ts (#728), so the plan a
    // dispatcher books is priced by the same code the wizard showed.
    const src = read("src/lib/clients.functions.ts");
    const fn = src.slice(
      src.indexOf("const internalQuoteSchema"),
      src.indexOf("const onboardSchema"),
    );
    expect(fn).toMatch(/internalQuote\(supabase, orgId, data\)/);
    const quote = read("src/lib/internal-quote.server.ts");
    expect(quote).toMatch(/commercial_per_station_cents/);
    expect(quote).toMatch(/computeCommercialZonePrice/);
    expect(quote).toMatch(/stationCount: data\.stationCount/);
  });

  it("the wizard asks for a quote whatever the account type", () => {
    const src = read("src/routes/_authenticated/clients.new.tsx");
    const q = src.slice(
      src.indexOf("const quoteQ = useQuery"),
      src.indexOf('queryKey: ["internal-quote"'),
    );
    expect(q).not.toMatch(/accountType === "residential"/);
    expect(src).toMatch(/stationCount: accountType === "commercial"/);
  });

  it("the plan is saved with the zone, and the property with its account type", () => {
    const src = read("src/lib/clients.functions.ts");
    expect(src).toMatch(/zone_id: s\.zoneId \?\? \(!isRes \? autoZoneId : null\)/);
    const insert = src.slice(
      src.indexOf('.from("properties")\n      .insert({\n        client_id: clientId'),
    );
    expect(insert.slice(0, 3000)).toMatch(/account_type: data\.accountType/);
  });
});

describe("R2-20: Use <zone> on a commercial plan", () => {
  it("keeps the unit count the plan's shape needs", () => {
    expect(countsFor({ account_type: "commercial", dog_count: null, unit_count: 8 }, {})).toEqual({
      dog_count: null,
      unit_count: 8,
    });
    expect(
      countsFor({ account_type: "residential", dog_count: 2, unit_count: null }, { dogCount: 3 }),
    ).toEqual({ dog_count: 3, unit_count: null });
  });

  it("sends the unit count, and its click does not open the drawer", () => {
    const src = read("src/components/client-detail/ServicesTab.tsx");
    const sync = src.slice(src.indexOf("const syncZoneMut"), src.indexOf("const prepayMut"));
    expect(sync).toMatch(/unitCount: v\.sub\.unit_count/);
    expect(src).toMatch(/if \(insideAControl\(e\.target, e\.currentTarget\)\) return;/);
  });
});

describe("F-14: a station log is somebody's word", () => {
  it("completing a visit writes no station logs", () => {
    const { body } = latestDefinitionOf("finalize_visit_completion");
    expect(body).not.toMatch(/record_visit_station_service|station_service_logs/);
  });

  it("the function that wrote them is gone", () => {
    const last = migrationFiles.filter((f) =>
      /record_visit_station_service/.test(readFileSync(join(MIGRATIONS, f), "utf8")),
    );
    const final = readFileSync(join(MIGRATIONS, last[last.length - 1]), "utf8");
    expect(final).toMatch(/DROP FUNCTION IF EXISTS public\.record_visit_station_service\(uuid\)/);
  });
});

describe("F-15: the office's Complete asks what the tech's does", () => {
  it("the RPC refuses a missing photo or checklist without a reason", () => {
    const { body } = latestDefinitionOf("office_complete_visit");
    expect(body).toMatch(/_override_reason text DEFAULT NULL/);
    expect(body).toMatch(/visit_photos/);
    expect(body).toMatch(/visit_checklist/);
    expect(body).toContain(OFFICE_COMPLETE_ASKS_WHY);
    expect(body).toMatch(/completion_photo_waived_reason/);
  });

  it("turns the refusal into a question rather than an error", async () => {
    state.rpc.mockImplementation(async () => ({ data: null, error: { message: ASK } }));
    await expect(call({ visitId: VISIT })).resolves.toEqual({
      ok: false,
      needsOverride: "This visit has no completion photo.",
    });
    expect(state.activity).not.toHaveBeenCalled();
  });

  it("passes a reason through and records it on the timeline", async () => {
    await expect(call({ visitId: VISIT, overrideReason: "Client confirmed" })).resolves.toEqual({
      ok: true,
    });
    expect(state.rpc).toHaveBeenCalledWith("office_complete_visit", {
      _visit_id: VISIT,
      _override_reason: "Client confirmed",
    });
    expect(state.activity.mock.calls[0][1].summary).toMatch(/Client confirmed/);
  });

  it("without anything missing, asks nothing", async () => {
    await expect(call({ visitId: VISIT })).resolves.toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("office_complete_visit", { _visit_id: VISIT });
  });

  it("the UI asks, then retries with the answer, or leaves the visit open", async () => {
    const results = [{ ok: false as const, needsOverride: "no photo" }, { ok: true as const }];
    const calls: (string | undefined)[] = [];
    const run = async (why?: string) => {
      calls.push(why);
      return results[calls.length - 1];
    };
    await expect(completeFromOffice(run, async () => "Done by phone")).resolves.toBe(true);
    expect(calls).toEqual([undefined, "Done by phone"]);

    const once = async () => ({ ok: false as const, needsOverride: "no photo" });
    await expect(completeFromOffice(once, async () => null)).resolves.toBe(false);
  });

  it("reads only its own refusal as a question", () => {
    expect(officeCompleteOverrideAsk("Not authorized")).toBeNull();
    expect(officeCompleteOverrideAsk(ASK)).toBe("This visit has no completion photo.");
  });
});

describe("R2-21, at the handler: getInternalQuote for a commercial account", () => {
  const zones = [
    {
      id: "zone-res",
      name: "Residential 48",
      account_type: "residential",
      postal_prefix: "48",
      zip_codes: null,
      priority: 0,
      enabled: true,
      geo_match_mode: "zip",
      base_price_cents: 2500,
      per_dog_addl_cents: 500,
      initial_cleanup_cents: 0,
      pricing_mode: "flat",
      commercial_base_cents: null,
      commercial_per_unit_cents: null,
      commercial_per_acre_cents: null,
      commercial_per_station_cents: null,
    },
    {
      id: "zone-hoa",
      name: "HOA 48",
      account_type: "commercial",
      postal_prefix: "48",
      zip_codes: null,
      priority: 0,
      enabled: true,
      geo_match_mode: "zip",
      base_price_cents: 0,
      per_dog_addl_cents: 0,
      initial_cleanup_cents: 0,
      pricing_mode: "flat",
      commercial_base_cents: 4000,
      commercial_per_unit_cents: 0,
      commercial_per_acre_cents: 0,
      commercial_per_station_cents: 600,
    },
  ];

  it("quotes $88 for 8 stations from the commercial zone, and names the zone", async () => {
    vi.resetModules();
    vi.doMock("@tanstack/react-start", () => ({
      createServerFn: () => {
        let validate: (d: unknown) => unknown = (d) => d;
        const b = {
          middleware: () => b,
          inputValidator: (fn: typeof validate) => ((validate = fn), b),
          handler:
            (fn: (a: { data: unknown; context: unknown }) => unknown) =>
            async (args?: { data: unknown }) =>
              fn({
                data: validate(args?.data),
                context: {
                  userId: "user-1",
                  supabase: {
                    from(table: string) {
                      const q: Record<string, unknown> = {};
                      q.select = () => q;
                      q.eq = () =>
                        table === "zones" ? Promise.resolve({ data: zones, error: null }) : q;
                      q.single = async () => ({
                        data: { currency: "USD", frequency_multipliers: {} },
                        error: null,
                      });
                      return q;
                    },
                  },
                },
              }),
        };
        return b;
      },
    }));
    const { getInternalQuote } = await import("@/lib/clients.functions");
    const r = (await (getInternalQuote as unknown as (a: { data: unknown }) => Promise<any>)({
      data: {
        postalCode: "48201",
        accountType: "commercial",
        dogCount: 1,
        frequency: "weekly",
        unitCount: 1,
        stationCount: 8,
      },
    })) as any;
    expect(r.available).toBe(true);
    expect(r.quote.zoneId).toBe("zone-hoa");
    expect(r.quote.recurringPriceCents).toBe(8800);
    expect(r.quote.commercial).toEqual({
      baseCents: 4000,
      unitCents: 0,
      acreageCents: 0,
      stationCents: 4800,
    });
  });
});
