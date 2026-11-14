// What onboarding saves, Settings shows (#766, and the Detroit Doo Disposal
// onboarding report of 2026-11-09: "Some things when onboarding didn't save or
// reflect in settings after logged").
//
// Every field Get started and Setup ask for is written through the REAL
// server function the screen calls, into an in-memory database, and then read
// back through the REAL server function the matching Settings screen calls.
// Only the network edges are faked (supabase-js, the auth admin, geocoding).
// A write that lands in a column Settings does not read fails here by name.
//
// The four faults this reproduces, each failing before the fix:
//   1. the signup mobile number reached only auth user_metadata, so Settings'
//      contact phone and (without the texting box) Profile's phone were blank;
//   2. contact_email was never set, so Settings showed it blank (#766);
//   3. setup's price per visit went to the zone only: Standard pricing and the
//      default service stayed blank (#766: zone $25, Standard $30);
//   4. a staff write that matched no row (RLS) returned success, so setup said
//      "You're on the schedule" over a row that never changed.

/* eslint-disable @typescript-eslint/no-explicit-any -- a fake of the supabase-js builder and createServerFn chain */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { directoryLineLabel } from "@/lib/directory";
import { defaultServiceSeedsFor } from "@/lib/services";

type Row = Record<string, any>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  /** Tables whose UPDATEs match nothing, the way an RLS refusal does. */
  deniedUpdates: new Set<string>(),
  /** Tables whose writes error outright. */
  failingWrites: new Map<string, string>(),
  rpcs: [] as Array<{ name: string; args: Row }>,
  seq: 0,
}));

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-0000000000b1";
const STAFF = "00000000-0000-4000-8000-0000000000c1";
const SIGNUP_EMAIL = "Owner@Example-Scoop.com";

function matches(row: Row, filters: Array<(r: Row) => boolean>) {
  return filters.every((f) => f(row));
}

/** As much of supabase-js as the functions under test use, over h.db. */
function fakeClient() {
  const client: any = {
    from(table: string) {
      let op: "select" | "update" | "insert" = "select";
      let payload: Row = {};
      let returning = false;
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (h.db[table] ??= []);
      const run = (): { data: any; error: any } => {
        if (op !== "select" && h.failingWrites.has(table)) {
          return { data: null, error: { message: h.failingWrites.get(table) } };
        }
        if (op === "insert") {
          const row = { id: `${table}-${++h.seq}`, ...payload };
          rows().push(row);
          return { data: returning ? [row] : null, error: null };
        }
        if (op === "update") {
          const hit = h.deniedUpdates.has(table) ? [] : rows().filter((r) => matches(r, filters));
          for (const r of hit) Object.assign(r, payload);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        return {
          data: rows()
            .filter((r) => matches(r, filters))
            .map((r) => ({ ...r })),
          error: null,
        };
      };
      const q: any = {
        select: (_cols?: string) => {
          if (op === "select") return q;
          returning = true;
          return q;
        },
        insert: (p: Row) => ((op = "insert"), (payload = p), q),
        update: (p: Row) => ((op = "update"), (payload = p), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
        ilike: () => q,
        gt: () => q,
        order: () => q,
        limit: () => q,
        range: () => q,
        maybeSingle: async () => {
          const r = run();
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
        },
        single: async () => {
          const r = run();
          const one = Array.isArray(r.data) ? r.data[0] : r.data;
          return one || r.error
            ? { data: one ?? null, error: r.error }
            : { data: null, error: { message: "no row" } };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(res, rej),
      };
      return q;
    },
    async rpc(name: string, args: Row) {
      h.rpcs.push({ name, args });
      const org = () => h.db.organizations.find((o) => o.id === args._org_id);
      switch (name) {
        case "bootstrap_organization": {
          // What the database function does, as far as these screens read it.
          if (!h.db.organizations.some((o) => o.id === ORG)) {
            h.db.organizations.push({
              id: ORG,
              name: args._org_name,
              timezone: args._timezone ?? "America/Chicago",
              contact_phone: null,
              contact_email: null,
              contact_address: null,
              country: null,
              latitude: null,
              longitude: null,
              std_base_price_cents: null,
              std_per_dog_addl_cents: null,
              frequency_multipliers: {},
              service_lines: ["pet_waste"],
              sms_consent_at: null,
              sms_consent_phone: null,
            });
            h.db.user_roles.push({ user_id: OWNER, organization_id: ORG, role: "owner" });
            h.db.staff.push({
              id: STAFF,
              organization_id: ORG,
              user_id: OWNER,
              display_name: args._display_name,
              phone: null,
              role: "owner",
              active: true,
              is_field_tech: false,
              end_latitude: null,
            });
            h.db.services.push({
              id: "svc-pet-waste",
              organization_id: ORG,
              name: "Pet waste removal",
              service_line: "pet_waste",
              price_unit: "visit",
              base_price_cents: null,
              extra_pet_cents: 0,
              active: true,
            });
          }
          return { data: ORG, error: null };
        }
        case "update_org_dispatch_settings":
          if (args._timezone) org()!.timezone = args._timezone;
          return { data: null, error: null };
        case "update_org_standard_pricing":
          org()!.std_base_price_cents = args._std_base_price_cents;
          org()!.std_per_dog_addl_cents = args._std_per_dog_addl_cents;
          return { data: null, error: null };
        case "org_has_commercial_data":
          return { data: false, error: null };
        case "service_line_availability":
          return { data: [], error: null };
        default:
          return { data: null, error: null };
      }
    },
    auth: {
      getUser: async () => ({ data: { user: { id: OWNER, email: SIGNUP_EMAIL.toLowerCase() } } }),
      admin: {
        getUserById: async () => ({ data: { user: { id: OWNER, email: SIGNUP_EMAIL } } }),
      },
    },
  };
  return client;
}

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown; context?: unknown } = {}) =>
          fn({ data: validate(opts.data), context: opts.context ?? {} }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fakeClient();
  },
}));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: ORG, role: "owner" }),
  resolveCaller: async () => ({ orgId: ORG, role: "owner" }),
  accessTurnedOff: () => false,
}));
vi.mock("@/lib/signup-codes.server", () => ({
  lookupSignupCode: async () => ({ kind: "invalid", reason: "no" }),
}));
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddress: async () => ({ latitude: 42.33, longitude: -83.05 }),
}));
vi.mock("@/lib/zones-redetect.server", () => ({ redetectZonesForOrg: async () => 0 }));
vi.mock("@/lib/supabase-paging.server", () => ({ fetchAllPages: async () => [] }));
vi.mock("@/lib/training-package-seed.server", () => ({
  seedTrainingPackage: async () => {},
  seedTrainingSkills: async () => {},
}));

const { bootstrapOrganization, recordSmsConsent, getOrgBranding, updateOrgBranding } =
  await import("@/lib/org.functions");
const { getDispatchSettings, updateDispatchSettings } = await import("@/lib/visits.functions");
const { setServiceLines, getMyOrgFeatures } = await import("@/lib/org-features.functions");
const { createZone, listZones } = await import("@/lib/zones.functions");
const { adoptSetupAreaPrice } = await import("@/lib/setup-price.functions");
const { getStandardPricing } = await import("@/lib/subscriptions.functions");
const { listServices } = await import("@/lib/services.functions");
const { setStaffRouting, setStaffAddresses, listStaffAddresses, STAFF_WRITE_NOT_SAVED } =
  await import("@/lib/users.functions");
const { upsertFacility, listFacilities } = await import("@/lib/stations.functions");
const { getMyProfile } = await import("@/lib/profile.functions");

const call = (fn: any, data?: Row) =>
  fn({ data, context: { supabase: fakeClient(), userId: OWNER } });

/** Get started, as /get-started's finish() sends it. */
const signUp = (over: Row = {}) =>
  call(bootstrapOrganization, {
    orgName: "Detroit Test Scooping",
    displayName: "Pat Owner",
    timezone: "America/Detroit",
    phone: "313-555-0142",
    ...over,
  });

beforeEach(() => {
  h.db = { organizations: [], user_roles: [], staff: [], services: [], zones: [] };
  h.deniedUpdates.clear();
  h.failingWrites.clear();
  h.rpcs = [];
  h.seq = 0;
});

describe("Get started → Settings", () => {
  it("business name → Settings > Business details", async () => {
    await signUp();
    expect((await call(getOrgBranding)).name).toBe("Detroit Test Scooping");
  });

  it("time zone → Settings > Business > Time zone", async () => {
    await signUp();
    expect((await call(getDispatchSettings)).settings.timezone).toBe("America/Detroit");
  });

  it("mobile number → Settings contact phone AND Profile phone, consent box unticked", async () => {
    await signUp();
    expect((await call(getOrgBranding)).contact_phone).toBe("313-555-0142");
    expect((await call(getMyProfile)).staff.phone).toBe("313-555-0142");
  });

  it("sign-up email → Settings contact email (#766)", async () => {
    await signUp();
    expect((await call(getOrgBranding)).contact_email).toBe(SIGNUP_EMAIL.toLowerCase());
  });

  it("a re-run never overwrites a phone or email changed since in Settings", async () => {
    await signUp();
    await call(updateOrgBranding, { contactPhone: "248-555-0000", contactEmail: "office@x.com" });
    await signUp({ phone: "313-555-9999" });
    const b = await call(getOrgBranding);
    expect(b.contact_phone).toBe("248-555-0000");
    expect(b.contact_email).toBe("office@x.com");
  });

  it("a failed phone write is an error, not a silent success", async () => {
    h.failingWrites.set("staff", "permission denied for table staff");
    await expect(signUp()).rejects.toThrow(/phone number was not saved/);
  });

  it("texting consent → organizations.sms_consent_*, and Profile phone", async () => {
    await signUp({ phone: undefined });
    await call(recordSmsConsent, {
      phone: "313-555-0142",
      consentText: "I agree to receive texts about my account.",
    });
    const org = h.db.organizations[0];
    expect(org.sms_consent_phone).toBe("313-555-0142");
    expect(org.sms_consent_at).toBeTruthy();
    expect((await call(getMyProfile)).staff.phone).toBe("313-555-0142");
  });

  it("texting consent: a failed staff write is reported, not dropped", async () => {
    await signUp({ phone: undefined });
    h.failingWrites.set("staff", "staff write refused");
    await expect(
      call(recordSmsConsent, {
        phone: "313-555-0142",
        consentText: "I agree to receive texts about my account.",
      }),
    ).rejects.toThrow("staff write refused");
  });
});

describe("Setup → Settings", () => {
  beforeEach(async () => {
    await signUp({ phone: undefined });
  });

  it("step 1: name, phone, address → Settings > Business details", async () => {
    await call(updateOrgBranding, {
      name: "Detroit Test Scooping LLC",
      contactPhone: "313-555-0100",
      contactAddress: "1 Woodward Ave, Detroit, MI 48226",
      country: "US",
    });
    const b = await call(getOrgBranding);
    expect(b.name).toBe("Detroit Test Scooping LLC");
    expect(b.contact_phone).toBe("313-555-0100");
    expect(b.contact_address).toBe("1 Woodward Ave, Detroit, MI 48226");
    expect(b.country).toBe("US");
    expect([b.latitude, b.longitude]).toEqual([42.33, -83.05]);
  });

  it("step 1: time zone → Settings > Business > Time zone", async () => {
    await call(updateDispatchSettings, { timezone: "America/New_York" });
    expect((await call(getDispatchSettings)).settings.timezone).toBe("America/New_York");
  });

  it("step 1: services offered → Settings > Business > Services you offer", async () => {
    await call(setServiceLines, { lines: ["pet_waste"] });
    expect((await call(getMyOrgFeatures)).serviceLines).toEqual(["pet_waste"]);
  });

  it("keeps one default service after repeated setup saves (#883)", async () => {
    await call(setServiceLines, { lines: ["pet_waste"] });
    await call(setServiceLines, { lines: ["pet_waste"] });
    const services = (await call(listServices, {})).services;
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("Pet waste removal");
    expect(directoryLineLabel("pet_waste")).toBe("Poop scooping");
    expect(defaultServiceSeedsFor(["pet_waste"]).map((s) => s.name)).toEqual([services[0].name]);
  });

  it.each([true, false])(
    "preserves a saved Weekly scoop, active=%s, without adding a default (#883)",
    async (active) => {
      Object.assign(h.db.services[0], {
        name: "Weekly scoop",
        base_price_cents: 3500,
        extra_pet_cents: 750,
        active,
      });
      const saved = structuredClone(h.db.services);
      await call(setServiceLines, { lines: ["pet_waste"] });
      await call(setServiceLines, { lines: ["pet_waste"] });
      expect(h.db.services).toEqual(saved);
    },
  );

  it("seeds one consistently named service when none exists (#883)", async () => {
    h.db.services = [];
    await call(setServiceLines, { lines: ["pet_waste"] });
    await call(setServiceLines, { lines: ["pet_waste"] });
    expect(h.db.services).toHaveLength(1);
    expect(h.db.services[0]).toMatchObject({
      name: "Pet waste removal",
      service_line: "pet_waste",
      active: true,
    });
  });

  it("price step: price per visit → Zones, Standard pricing AND the default service (#766)", async () => {
    await call(createZone, {
      name: "Main service area",
      geoMatchMode: "radius",
      centerLatitude: 42.33,
      centerLongitude: -83.05,
      radiusMeters: 24140,
      basePriceCents: 2500,
      perDogAddlCents: 500,
    });
    await call(adoptSetupAreaPrice, { basePriceCents: 2500, perDogAddlCents: 500 });

    const zone = (await call(listZones)).zones[0];
    expect([zone.base_price_cents, zone.per_dog_addl_cents]).toEqual([2500, 500]);
    const std = await call(getStandardPricing);
    expect([std.basePriceCents, std.perDogAddlCents]).toEqual([2500, 500]);
    const svc = (await call(listServices, {})).services.find(
      (s: Row) => s.name === "Pet waste removal",
    );
    expect([svc.base_price_cents, svc.extra_pet_cents]).toEqual([2500, 500]);
  });

  it("price step never overwrites a Standard price or service price already chosen", async () => {
    h.db.organizations[0].std_base_price_cents = 3000;
    h.db.services[0].base_price_cents = 3500;
    await call(adoptSetupAreaPrice, { basePriceCents: 2500, perDogAddlCents: 500 });
    const std = await call(getStandardPricing);
    // The one blank is filled; the one chosen is kept.
    expect([std.basePriceCents, std.perDogAddlCents]).toEqual([3000, 500]);
    expect(h.db.services[0].base_price_cents).toBe(3500);
  });

  it("team step: I run the route → Settings > Users (staff.is_field_tech)", async () => {
    await call(setStaffRouting, { staffId: STAFF, isFieldTech: true });
    const me = (await call(listStaffAddresses)).staff.find((s: Row) => s.id === STAFF);
    expect(me.is_field_tech).toBe(true);
  });

  it("team step: a write RLS refused is an error, not 'You're on the schedule'", async () => {
    h.deniedUpdates.add("staff");
    await expect(call(setStaffRouting, { staffId: STAFF, isFieldTech: true })).rejects.toThrow(
      STAFF_WRITE_NOT_SAVED,
    );
  });

  it("day-end step: end point → Settings > Users (staff.end_*)", async () => {
    await call(setStaffAddresses, {
      staffId: STAFF,
      endAddress: "Home, Detroit",
      endLatitude: 42.3,
      endLongitude: -83.1,
    });
    const me = (await call(listStaffAddresses)).staff.find((s: Row) => s.id === STAFF);
    expect([me.end_address, me.end_latitude]).toEqual(["Home, Detroit", 42.3]);
  });

  it("day-end step: a write RLS refused is an error", async () => {
    h.deniedUpdates.add("staff");
    await expect(
      call(setStaffAddresses, { staffId: STAFF, endAddress: "x", endLatitude: 1, endLongitude: 1 }),
    ).rejects.toThrow(STAFF_WRITE_NOT_SAVED);
  });

  it("dump site step → Settings > Business > Dump sites (listFacilities)", async () => {
    await call(upsertFacility, { name: "County transfer station", address: "100 Dump Rd" });
    const sites = (await call(listFacilities)).facilities;
    expect(sites.map((f: Row) => [f.name, f.address, f.latitude])).toEqual([
      ["County transfer station", "100 Dump Rd", 42.33],
    ]);
  });
});

// #787: the phone typed at sign-up, in setup, and on Profile is one number.
// Reproduced from the 2026-11-09 QA run: mobile `555-010-0199` at sign-up,
// setup step 1's Business phone empty (later `555-`), Profile blank, client
// portal Office phone `555-010-0199`. Setup step 1 and the portal card both
// read organizations.contact_phone through getOrgBranding; Profile reads
// staff.phone through getMyProfile.
describe("One phone from sign-up to setup, Profile and the portal (#787)", () => {
  const QA_PHONE = "555-010-0199";
  const OFFICE_MANAGER = "00000000-0000-4000-8000-0000000000b2";

  it("the sign-up mobile is what setup's Business phone starts with", async () => {
    const { setupBusinessPhonePrefill } = await import("@/lib/phone-handoff");
    await signUp({ phone: QA_PHONE });
    const branding = await call(getOrgBranding);
    // setup.tsx: `phone ?? b?.contact_phone` with nothing typed yet.
    expect(branding.contact_phone).toBe(QA_PHONE);
    expect(setupBusinessPhonePrefill(null, branding.contact_phone)).toBe(QA_PHONE);
    // A fragment kept on the device does not cover the whole number.
    expect(setupBusinessPhonePrefill("555-", branding.contact_phone)).toBe(QA_PHONE);
  });

  it("after sign-up, Profile phone and portal Office phone agree", async () => {
    await signUp({ phone: QA_PHONE });
    const portal = (await call(getOrgBranding)).contact_phone;
    const profile = (await call(getMyProfile)).staff.phone;
    expect(profile).toBe(QA_PHONE);
    expect(portal).toBe(profile);
  });

  it("a Business phone entered in setup also fills a blank Profile phone", async () => {
    // The QA run: the phone never reached Profile, then was re-typed in setup.
    await signUp({ phone: undefined });
    await call(updateOrgBranding, { name: "QA Test Scooping", contactPhone: QA_PHONE });
    expect((await call(getOrgBranding)).contact_phone).toBe(QA_PHONE);
    expect((await call(getMyProfile)).staff.phone).toBe(QA_PHONE);
  });

  it("a Profile phone that is an empty string counts as blank", async () => {
    await signUp({ phone: undefined });
    h.db.staff[0].phone = "";
    h.db.organizations[0].contact_phone = "";
    await signUp({ phone: QA_PHONE });
    expect((await call(getOrgBranding)).contact_phone).toBe(QA_PHONE);
    expect((await call(getMyProfile)).staff.phone).toBe(QA_PHONE);
  });

  it("a fragment such as `555-` is never stored as the phone", async () => {
    await signUp({ phone: "555-" });
    expect((await call(getOrgBranding)).contact_phone).toBeNull();
    expect((await call(getMyProfile)).staff.phone).toBeNull();
  });

  it("an owner's own Profile phone is never overwritten by the office phone", async () => {
    await signUp({ phone: "313-555-0142" });
    await call(updateOrgBranding, { contactPhone: QA_PHONE });
    expect((await call(getOrgBranding)).contact_phone).toBe(QA_PHONE);
    expect((await call(getMyProfile)).staff.phone).toBe("313-555-0142");
  });

  it("an office manager saving the office phone does not get it as their own", async () => {
    await signUp({ phone: undefined });
    h.db.staff.push({
      id: "staff-om",
      organization_id: ORG,
      user_id: OFFICE_MANAGER,
      display_name: "Office Manager",
      phone: null,
      role: "office_manager",
      active: true,
    });
    await updateOrgBranding({
      data: { contactPhone: QA_PHONE },
      context: { supabase: fakeClient(), userId: OFFICE_MANAGER },
    } as any);
    expect(h.db.staff.find((s) => s.user_id === OFFICE_MANAGER)!.phone).toBeNull();
  });

  it("a failed Profile copy is a warning; the office phone still saved", async () => {
    await signUp({ phone: undefined });
    h.failingWrites.set("staff", "permission denied for table staff");
    const res = await call(updateOrgBranding, { contactPhone: QA_PHONE });
    expect(res.ok).toBe(true);
    expect(res.profilePhoneWarning).toMatch(/office phone was saved.*Profile/i);
    expect((await call(getOrgBranding)).contact_phone).toBe(QA_PHONE);
  });

  it("a Profile phone the owner cleared is not refilled by a later office phone change", async () => {
    await signUp({ phone: QA_PHONE });
    h.db.staff[0].phone = null; // cleared on Profile, on purpose
    const res = await call(updateOrgBranding, { contactPhone: "313-555-0142" });
    expect(res.profilePhoneWarning).toBeNull();
    expect((await call(getOrgBranding)).contact_phone).toBe("313-555-0142");
    expect((await call(getMyProfile)).staff.phone).toBeNull();
  });

  it("a fragment such as `555-` is refused by the office phone save, not stored over the number", async () => {
    await signUp({ phone: QA_PHONE });
    await expect(call(updateOrgBranding, { contactPhone: "555-" })).rejects.toThrow(
      /whole phone number/,
    );
    expect((await call(getOrgBranding)).contact_phone).toBe(QA_PHONE);
  });

  it("an emptied office phone clears it and touches nothing else", async () => {
    await signUp({ phone: QA_PHONE });
    await call(updateOrgBranding, { contactPhone: "" });
    expect((await call(getOrgBranding)).contact_phone).toBeNull();
    expect((await call(getMyProfile)).staff.phone).toBe(QA_PHONE);
  });
});
