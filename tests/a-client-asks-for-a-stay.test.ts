import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BOOKABLE_SERVICE_LINES } from "@/lib/service-lines";
import { ServiceLinesChoices } from "@/components/ServiceLinesChoices";
import { stayVisitCount, stayVisitPriceCents } from "@/lib/stays";
import { revenueByService } from "@/lib/revenue-by-service";
import { serviceProblem } from "@/lib/services";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (d: any) => d;
    const b: any = {
      inputValidator: (v: any) => {
        validate = v;
        return b;
      },
      handler: (h: any) => (opts: any) => h({ data: validate(opts.data) }),
    };
    return b;
  },
}));
const state = vi.hoisted(() => ({
  verified: true,
  bookable: true,
  preview: false,
  reads: [] as string[],
  auth: [] as any[],
  rpc: [] as any[],
  tables: {} as Record<string, any[]>,
}));
// Exercise the built request flow after a future approval, and separately
// prove the real endpoint refuses writes while its launch gate is closed.
vi.mock("@/lib/service-lines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service-lines")>()),
  customerCanRequestStay: () => state.bookable,
}));
vi.mock("@/lib/portal-auth.server", () => ({
  requirePortalSession: async (_token: string, opts: any = {}) => {
    state.auth.push(opts);
    if (!state.verified) throw new Error("PORTAL_VERIFICATION_REQUIRED");
    if (state.preview && !opts.readOnly) throw new Error("preview is read-only");
    return { clientId: "client-a", organizationId: "org-a", preview: state.preview };
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      state.reads.push(table);
      const filters: Array<(row: any) => boolean> = [];
      const value = (r: any, col: string) => col.split(".").reduce((v, k) => v?.[k], r);
      let end = Infinity;
      let start = 0;
      const rows = () =>
        (state.tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(start, end);
      const q: any = {
        select: () => q,
        order: () => q,
        eq: (c: string, v: any) => {
          filters.push((r) => value(r, c) === v);
          return q;
        },
        in: (c: string, v: any[]) => {
          filters.push((r) => v.includes(value(r, c)));
          return q;
        },
        is: (c: string, v: any) => {
          filters.push((r) => (value(r, c) ?? null) === v);
          return q;
        },
        or: (filter: string) => {
          filters.push((r) =>
            filter.split(",").some((clause) => {
              const [c, , v] = clause.split(".");
              return r[c] === v;
            }),
          );
          return q;
        },
        limit: (n: number) => {
          end = n;
          return q;
        },
        range: (a: number, b: number) => {
          start = a;
          end = b + 1;
          return q;
        },
        single: async () => ({ data: rows()[0], error: null }),
        then: (res: any) => Promise.resolve({ data: rows(), error: null }).then(res),
      };
      return q;
    },
    rpc: async (name: string, args: any) => {
      state.rpc.push({ name, args });
      return { data: "stay-new", error: null };
    },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((p) => ({ path: p, signedUrl: `https://photos.example/${p}` })),
          error: null,
        }),
      }),
    },
  },
}));
const {
  portalListStays,
  portalRequestStay,
  portalStayVisitOf,
  portalStayRequestSchema,
  portalCareLines,
} = await import("@/lib/portal-stays.functions");
const { stayInvoicePaymentTypes } = await import("@/lib/stay-payment.server");
const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/20261024080300_a-client-asks-for-a-stay.sql");
const TOKEN = "11111111-1111-4111-8111-111111111111";
const SERVICE = "22222222-2222-4222-8222-222222222222";
const PROPERTY = "33333333-3333-4333-8333-333333333333";
const PET = "44444444-4444-4444-8444-444444444444";
const request = () => ({
  token: TOKEN,
  requestKey: TOKEN,
  propertyId: PROPERTY,
  serviceId: SERVICE,
  startsOn: "2030-06-01",
  endsOn: "2030-06-06",
  windows: [],
  petIds: [PET],
  notes: "Bring in the mail",
  care: [
    {
      petId: PET,
      feeding: "Half a cup",
      otherCare: "Litter",
      meds: [{ name: "Pill", dose: "Half", times: ["08:00"], notes: "With food" }],
    },
  ],
});

beforeEach(() => {
  state.bookable = true;
  state.verified = true;
  state.preview = false;
  state.reads = [];
  state.rpc = [];
  state.auth = [];
  state.tables = {
    organizations: [
      { id: "org-a", service_lines: ["pet_sitting"], timezone: "America/Chicago", currency: "usd" },
    ],
    services: [
      {
        id: SERVICE,
        organization_id: "org-a",
        service_line: "pet_sitting",
        active: true,
        name: "Overnight",
        price_unit: "night",
      },
    ],
    properties: [
      {
        id: PROPERTY,
        organization_id: "org-a",
        client_id: "client-a",
        street: "1 Home St",
        archived_at: null,
        gate_code: "SECRET-GATE",
        lock_box_code: "SECRET-BOX",
        dogs: [
          {
            id: PET,
            name: "Miso",
            species: "cat",
            species_note: null,
            active: true,
            notes: "PRIVATE-PET",
          },
        ],
      },
    ],
    pet_care_instructions: [
      {
        organization_id: "org-a",
        pet_id: PET,
        feeding: "Half a cup",
        meds: [],
        other_care: "Litter",
      },
    ],
    stays: [
      {
        id: "stay-a",
        organization_id: "org-a",
        client_id: "client-a",
        starts_on: "2030-06-01",
        ends_on: "2030-06-06",
        kind: "overnight",
        status: "confirmed",
        services: { name: "Overnight" },
        deposit_cents: 10000,
        deposit_invoice_id: "deposit-a",
        invoice_id: "invoice-a",
        notes: "OFFICE-ONLY",
      },
    ],
    visits: [
      {
        id: "visit-a",
        client_id: "client-a",
        organization_id: "org-a",
        status: "completed",
        scheduled_on: "2030-06-01",
        started_at: "2030-06-02T00:00:00Z",
        completed_at: "2030-06-02T00:30:00Z",
        report_note: "Miso ate well",
        tech_note: "PRIVATE-TECH",
        subscriptions: { stay_id: "stay-a", earliest_time: "19:00", latest_time: "21:00" },
      },
      {
        id: "visit-b",
        client_id: "client-b",
        organization_id: "org-a",
        status: "completed",
        scheduled_on: "2030-06-01",
        report_note: "OTHER-CLIENT",
        subscriptions: { stay_id: "stay-a" },
      },
    ],
    care_log: [
      {
        id: "care-a",
        organization_id: "org-a",
        visit_id: "visit-a",
        pet_id: PET,
        kind: "feed",
        med_name: null,
        status: "done",
        missed_reason: null,
        note: "Ate the full cup",
        at: "2030-06-02T00:10:00Z",
      },
      {
        id: "care-b",
        organization_id: "org-a",
        visit_id: "visit-b",
        pet_id: PET,
        kind: "meds",
        med_name: "Pill",
        status: "missed",
        missed_reason: "PRIVATE-CARE",
        note: null,
        at: "2030-06-02T00:12:00Z",
      },
    ],
    visit_photos: [
      { visit_id: "visit-a", storage_path: "a.jpg", kind: "completion" },
      { visit_id: "visit-b", storage_path: "PRIVATE-PHOTO.jpg", kind: "completion" },
    ],
    invoices: [
      { id: "deposit-a", client_id: "client-a", organization_id: "org-a", status: "open" },
    ],
  };
});

describe("the client stay request", () => {
  it("refuses direct requests while Coming soon and preserves existing timelines", async () => {
    state.bookable = false;
    await expect(portalRequestStay({ data: request() })).rejects.toThrow("coming soon");
    expect(state.rpc).toEqual([]);
    expect(state.reads).toEqual([]);
    const result = await portalListStays({ data: { token: TOKEN } });
    expect(result.canRequest).toBe(false);
    expect(result.stays.length).toBeGreaterThan(0);
  });
  it("takes the tenant and client from the verified session and saves edited care", async () => {
    await portalRequestStay({
      data: { ...request(), organizationId: "org-b", clientId: "client-b", depositCents: 1 },
    } as any);
    expect(state.auth).toEqual([{}]);
    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0]).toMatchObject({
      name: "portal_request_stay",
      args: {
        _org_id: "org-a",
        _client_id: "client-a",
        _input: { petIds: [PET], care: [{ petId: PET, feeding: "Half a cup" }] },
      },
    });
    expect(state.rpc[0].args._input).not.toHaveProperty("depositCents");
  });
  it("requires verification and refuses writes from a staff preview", async () => {
    state.verified = false;
    await expect(portalRequestStay({ data: request() })).rejects.toThrow(
      "PORTAL_VERIFICATION_REQUIRED",
    );
    expect(state.reads).toEqual([]);
    state.verified = true;
    state.preview = true;
    await expect(portalRequestStay({ data: request() })).rejects.toThrow("read-only");
    expect(state.rpc).toEqual([]);
  });
  it("checks dates, windows, care ownership and medication times", async () => {
    await expect(
      portalRequestStay({ data: { ...request(), endsOn: "2030-05-31" } }),
    ).rejects.toThrow(/after check-in/);
    await expect(
      portalRequestStay({
        data: { ...request(), care: [{ ...request().care[0], petId: PROPERTY }] },
      }),
    ).rejects.toThrow(/pet on this stay/);
    expect(() =>
      portalStayRequestSchema.parse({
        ...request(),
        care: [
          {
            ...request().care[0],
            meds: [{ name: "Pill", dose: null, times: ["8am"], notes: null }],
          },
        ],
      }),
    ).toThrow();
    state.tables.services[0].price_unit = "visit";
    await expect(portalRequestStay({ data: request() })).rejects.toThrow(/drop-in/);
    expect(state.rpc).toEqual([]);
  });
});

describe("the portal timeline", () => {
  it("names the pet and keeps a sitter's note on the care line", () => {
    const lines = portalCareLines(
      [
        {
          id: "b",
          pet_id: null,
          kind: "water",
          med_name: null,
          status: "done",
          missed_reason: null,
          note: null,
          at: "2030-06-02T01:00:00Z",
        },
        {
          id: "a",
          pet_id: PET,
          kind: "meds",
          med_name: "Apoquel",
          status: "missed",
          missed_reason: "She hid under the bed",
          note: null,
          at: "2030-06-02T00:10:00Z",
        },
      ],
      [{ id: PET, name: "Miso" }],
      "UTC",
    );
    expect(lines.map((l) => l.pet)).toEqual(["Miso", "All pets"]);
    expect(lines[0].line).toContain("Apoquel missed");
    expect(lines[0].line).toContain("She hid under the bed");
  });
  it("returns only this client's reports and signed photos, with species and saved care", async () => {
    state.preview = true;
    const result = await portalListStays({ data: { token: TOKEN } });
    expect(state.auth).toEqual([{ readOnly: true }]);
    expect(result.pets[0]).toMatchObject({
      name: "Miso",
      species: "cat",
      care: { feeding: "Half a cup" },
    });
    expect(result.stays[0]).toMatchObject({
      depositDue: true,
      visits: [
        {
          reportNote: "Miso ate well",
          durationMin: 30,
          photos: [{ url: "https://photos.example/a.jpg" }],
          care: [{ id: "care-a", pet: "Miso", line: expect.stringContaining("Ate the full cup") }],
        },
      ],
    });
    const wire = JSON.stringify(result);
    for (const secret of [
      "PRIVATE-TECH",
      "PRIVATE-PET",
      "OFFICE-ONLY",
      "SECRET-GATE",
      "SECRET-BOX",
      "OTHER-CLIENT",
      "PRIVATE-PHOTO",
      "PRIVATE-CARE",
    ])
      expect(wire).not.toContain(secret);
  });
  it("hides reports and photos before completion and stops offering a paid deposit", async () => {
    state.tables.visits[0].status = "in_progress";
    state.tables.invoices[0].status = "paid";
    const result = await portalListStays({ data: { token: TOKEN } });
    expect(result.stays[0].depositDue).toBe(false);
    expect(result.stays[0].visits[0].reportNote).toBeUndefined();
    expect(result.stays[0].visits[0].photos).toEqual([]);
    expect(result.stays[0].visits[0].care).toEqual([]);
    expect(
      portalStayVisitOf({ ...state.tables.visits[0], status: "canceled" }, "UTC", [
        { url: "secret", kind: "completion" },
      ]).photos,
    ).toEqual([]);
  });
  it("pet-waste businesses get no sitting data or further queries", async () => {
    state.tables.organizations[0].service_lines = ["pet_waste"];
    expect(await portalListStays({ data: { token: TOKEN } })).toMatchObject({
      offered: false,
      stays: [],
      pets: [],
      services: [],
    });
    expect(state.reads).toEqual(["organizations"]);
  });
  it("does not select private notes or access codes", () => {
    const selects = [
      ...read("src/lib/portal-stays.functions.ts").matchAll(/\.select\(\s*"([^"]+)"/g),
    ]
      .map((m) => m[1])
      .join(" ");
    for (const col of ["tech_note", "gate_code", "lock_box_code", "key_tag", "access_notes"])
      expect(selects).not.toContain(col);
  });
});

describe("stay billing", () => {
  it("five $60 nights with a $15 extra pet cost $375", () => {
    const price = stayVisitPriceCents(
      {
        price_unit: "night",
        base_price_cents: 6000,
        extra_pet_cents: 1500,
        default_duration_min: null,
      },
      2,
    );
    expect(price! * stayVisitCount("overnight", "2030-06-01", "2030-06-06", 0)).toBe(37500);
  });
  it("keeps the sitting service on revenue by service", () => {
    expect(
      revenueByService({
        from: "2030-06-01",
        to: "2030-06-30",
        timezone: "UTC",
        invoices: [{ id: "invoice-a", status: "open", issued_at: "2030-06-01T12:00:00Z" }],
        lines: [
          {
            invoice_id: "invoice-a",
            visit_id: "visit-a",
            subscription_id: "plan-a",
            amount_cents: 37500,
          },
        ],
        visitService: new Map([["visit-a", SERVICE]]),
        subscriptionService: new Map(),
        serviceName: new Map([[SERVICE, "Overnight"]]),
      }),
    ).toEqual([{ serviceId: SERVICE, name: "Overnight", cents: 37500, lines: 1 }]);
  });
  it("uses cards for stays and deposits while other invoices keep their payment methods", async () => {
    const usual = ["card", "us_bank_account"];
    expect(await stayInvoicePaymentTypes("invoice-a", "org-a", usual)).toEqual(["card"]);
    expect(await stayInvoicePaymentTypes("deposit-a", "org-a", usual)).toEqual(["card"]);
    expect(await stayInvoicePaymentTypes("unrelated", "org-a", usual)).toEqual(usual);
    expect(await stayInvoicePaymentTypes("invoice-a", "org-b", usual)).toEqual(usual);
  });
  it("locks confirmation, reuses the generator, links every billed visit and uses the existing void path", () => {
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain(
      "public.has_permission(auth.uid(), _st.organization_id, 'manage_pricing')",
    );
    expect(sql).toContain("public.generate_visits_core(_st.organization_id, _last, _sub)");
    expect(sql).toContain(
      "invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)",
    );
    expect(sql).toContain("public.set_invoice_totals(_inv, _total)");
    expect(sql).toContain("'prepaid_topup'");
    expect(sql).toContain("public.void_invoice(_inv)");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.portal_request_stay(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated",
    );
    expect(sql).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.(run_billing_cycles|admin_generate_invoice_for_client|generate_visits_core)\b/,
    );
    expect(sql.slice(sql.lastIndexOf("DO $check$"))).toContain("RAISE EXCEPTION");
  });
  it("allows holiday percentages only on sitting services", () => {
    const draft = {
      name: "Overnight",
      service_line: "pet_sitting" as const,
      price_unit: "night" as const,
      base_price_cents: 6000,
      extra_pet_cents: 1500,
      default_duration_min: 60,
    };
    expect(serviceProblem({ ...draft, holiday_surcharge_pct: 20 })).toBeNull();
    for (const pct of [-1, 501, 1.5])
      expect(serviceProblem({ ...draft, holiday_surcharge_pct: pct })).toMatch(/whole percentage/);
    expect(
      serviceProblem({
        ...draft,
        service_line: "dog_walking",
        price_unit: "visit",
        holiday_surcharge_pct: 20,
      }),
    ).toMatch(/sitting holiday/);
  });
});

describe("sitting is not bookable yet", () => {
  it("the picker shows sitting as Coming soon and it cannot be ticked", () => {
    expect(BOOKABLE_SERVICE_LINES).not.toContain("pet_sitting");
    const html = renderToStaticMarkup(
      createElement(ServiceLinesChoices, { lines: ["pet_waste"], onChange: () => {} }),
    );
    const row = html.split("<li").find((r) => r.includes(">Pet sitting</span>"));
    expect(row).toBeDefined();
    expect(row).toContain("Coming soon");
    expect(row).toContain('disabled=""');
  });
  it("mounts requests, timelines and office confirmation with a slot for S2's care log", () => {
    expect(read("src/routes/portal.$slug.$token.requests.tsx")).toContain("<PortalStayRequest />");
    expect(read("src/routes/portal.$slug.$token.visits.tsx")).toContain("<PortalStayTimeline />");
    expect(read("src/components/portal/Stays.tsx")).toContain("data-stay-care-log");
    expect(read("src/components/portal/Stays.tsx")).toContain("PortalVisitReport");
    expect(read("src/routes/_authenticated/concerns.tsx")).toContain("<RequestedStays />");
    expect(read("src/components/client-detail/StaysSection.tsx")).toContain("<ConfirmStayButton");
    expect(read("src/routes/_authenticated/settings.services.tsx")).toContain(
      "other service lines are Coming soon",
    );
  });
});
