import type { BrowserContext, Route } from "@playwright/test";
import { SUPABASE_ORIGIN, sweepUser } from "./session";
import * as fx from "./dataset";
import * as pfx from "./portal-dataset";

/**
 * Everything the signed-in app asks the network for, answered locally.
 *
 * ── THE TWO CHANNELS ──────────────────────────────────────────────────────
 *
 *   1. Supabase, at `https://<ref>.supabase.co`. The browser client is
 *      hard-coded to production in `src/integrations/supabase/client.ts`, so
 *      this interception is not an optimisation — it is the thing that
 *      guarantees a test run cannot touch the live project. Anything not named
 *      below gets an empty result, never a passthrough.
 *
 *   2. TanStack Start server functions, at `/_serverFn/<id>`. `<id>` is
 *      base64url JSON — `{"file":"/src/lib/org.functions.ts?…","export":"getMyOrg_createServerFn_handler"}`
 *      — which is how a stub can be keyed by the function's NAME rather than
 *      by a route or a URL. The reply envelope is `{"result": <value>}`;
 *      returning the bare value yields `undefined` on the client, which is a
 *      confusing way to spend an afternoon.
 *
 * ── ON THE FALLBACK ───────────────────────────────────────────────────────
 *
 * An unlisted server function returns `null` AND is recorded. Silence would be
 * the same mistake the `settle()` guard was written to prevent: a page that
 * renders an empty state everywhere is a page whose layout was never
 * exercised, and it passes every "nothing is wrong" assertion. The spec prints
 * the recorded names for any surface it measured, so adding data to this file
 * is a mechanical follow-up rather than a discovery.
 */

/** Decode a TanStack Start GET payload (seroval cross-JSON) far enough to read
 *  the arguments a stub needs. Objects, arrays and primitives only — no
 *  cycles, no Dates, none of which appear in these argument shapes. */
function decodeSeroval(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const n = node as Record<string, any>;
  if (n.p && Array.isArray(n.p.k) && Array.isArray(n.p.v)) {
    const out: Record<string, unknown> = {};
    n.p.k.forEach((k: string, i: number) => (out[k] = decodeSeroval(n.p.v[i])));
    return out;
  }
  if (Array.isArray(n.a)) return n.a.map(decodeSeroval);
  if ("s" in n) return n.s;
  if ("t" in n && typeof n.t === "object") return decodeSeroval(n.t);
  return undefined;
}

function argsOf(route: Route): Record<string, any> {
  const url = new URL(route.request().url());
  const raw = url.searchParams.get("payload");
  let parsed: any;
  if (raw) {
    try {
      parsed = decodeSeroval(JSON.parse(raw));
    } catch {
      parsed = undefined;
    }
  } else if (route.request().method() === "POST") {
    try {
      parsed = decodeSeroval(JSON.parse(route.request().postData() ?? "{}"));
    } catch {
      parsed = undefined;
    }
  }
  const data = parsed?.data;
  return data && typeof data === "object" ? (data as Record<string, any>) : {};
}

type Stub = unknown | ((args: Record<string, any>) => unknown);

const ok = { ok: true };

/**
 * Name → reply. Named for the export, so one entry serves every route that
 * calls it and a rename in `src/lib` shows up here as an unstubbed call
 * rather than as a wrong-looking page.
 */
const BASE_STUBS: Record<string, Stub> = {
  // ── The shell. Every authenticated route waits on these. ────────────────
  getMyOrg: { organization: fx.ORGANIZATION },
  getPlatformContext: { isPlatformAdmin: true },
  getMyProfile: {
    staff: {
      id: fx.STAFF[0].id,
      display_name: "Dana Whitfield-Ramirez",
      role: "owner",
      avatar_path: null,
      phone: "+1 (312) 555-0142",
      language: "en",
    },
    authEmail: "sweep.owner@houndstack-sweep.test",
    emailConfirmed: true,
    pendingEmail: null,
  },
  getMyOrgFeatures: { commercialAccounts: true, hasCommercialData: true },
  // The SOLE-OWNER branch of Delete your account, deliberately. Without this
  // the fence answers {} and the card renders its two-line simple form, so the
  // harder layout -- a transfer picker, a second explanation, and a confirm
  // field -- was never measured at 360px. The names are long on purpose,
  // because a picker of short names proves nothing about a phone.
  listOwnershipTransferCandidates: {
    soleOwner: true,
    candidates: [
      { userId: "dddddddd-0000-4000-8000-00000000d002", name: "Samantha Okonkwo", role: "tech" },
      {
        userId: "dddddddd-0000-4000-8000-00000000d003",
        name: "Bartholomew Fitzgerald III",
        role: "office_manager",
      },
    ],
  },
  getTrialState: {
    phase: "expired",
    daysRemaining: null,
    endsOn: "2026-08-30",
    restricted: true,
    canManageBilling: true,
  },
  getBillingBannerStatus: { planStatus: "active", role: "owner" },
  getBillingStatus: {
    orgId: fx.ORG_ID,
    orgName: fx.ORG_NAME,
    planName: "Growth",
    planSlug: "growth",
    billingStatus: "active",
    isPaidTier: true,
    planStatus: "active",
    currentPeriodEnd: fx.ORGANIZATION.current_period_end,
    stripeCustomerId: fx.ORGANIZATION.stripe_customer_id,
    stripeSubscriptionId: fx.ORGANIZATION.stripe_subscription_id,
  },
  // /settings/billing. The plan cards and the checkout paragraph are where a
  // buyer is told about the metered AI charge, so the fixture carries the real
  // catalog shape — allowance and per-action rate — rather than a tidier one:
  // a sweep that measured cards with no allowance line would be measuring a
  // page the product does not ship. Enterprise keeps nulls on purpose, because
  // "renders nothing rather than null" is the case most likely to regress.
  listPlatformPlans: {
    plans: [
      {
        id: "plan-launch",
        name: "Launch",
        slug: "launch",
        description: "A solo operator or a small crew running one business.",
        price_cents: 7_900,
        annual_price_cents: 79_000,
        currency: "usd",
        interval: "month",
        features: {},
        included_seats: 3,
        price_per_seat_cents: 1_000,
        ai_actions_included: 200,
        ai_overage_cents_per_action: 10,
        is_free: false,
        stripe_price_id: "price_launch",
        stripe_annual_price_id: "price_launch_yr",
        sort_order: 1,
      },
      {
        id: "plan-growth",
        name: "Growth",
        slug: "growth",
        description: 'Past "just me and a couple techs", still one business.',
        price_cents: 19_900,
        annual_price_cents: 199_000,
        currency: "usd",
        interval: "month",
        features: {},
        included_seats: 10,
        price_per_seat_cents: 1_000,
        ai_actions_included: 750,
        ai_overage_cents_per_action: 10,
        is_free: false,
        stripe_price_id: "price_growth",
        stripe_annual_price_id: "price_growth_yr",
        sort_order: 2,
      },
      {
        id: "plan-scale",
        name: "Scale",
        slug: "scale",
        description: "A large operation spread across multiple cities or territories.",
        price_cents: 44_900,
        annual_price_cents: 449_000,
        currency: "usd",
        interval: "month",
        features: {},
        included_seats: 30,
        price_per_seat_cents: 1_000,
        ai_actions_included: 2_500,
        ai_overage_cents_per_action: 10,
        is_free: false,
        stripe_price_id: "price_scale",
        stripe_annual_price_id: "price_scale_yr",
        sort_order: 3,
      },
      {
        id: "plan-ent",
        name: "Enterprise",
        slug: "enterprise",
        description: "A franchise or multi-brand parent overseeing separate child businesses.",
        price_cents: null,
        annual_price_cents: null,
        currency: "usd",
        interval: "month",
        features: {},
        included_seats: null,
        price_per_seat_cents: 1_000,
        ai_actions_included: null,
        ai_overage_cents_per_action: null,
        is_free: false,
        stripe_price_id: null,
        stripe_annual_price_id: null,
        sort_order: 4,
      },
    ],
  },
  listSubscriptionItems: {
    planInterval: "month",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: fx.ORGANIZATION.current_period_end,
    items: [
      { kind: "base", label: "Growth (monthly)", quantity: 1, amountCents: 19_900 },
      { kind: "seat", label: "Additional active employees", quantity: 4, amountCents: 4_000 },
    ],
    nextInvoiceCents: 23_900,
  },
  getReviewQueueCount: { openCount: 4 },
  getOnboardingStatus: { steps: [], completed: 0, total: 0, dismissed: true },
  listActiveAnnouncements: { rows: [] },
  getSuspensionState: null,
  listMyNotifications: {
    notifications: [
      {
        id: "aaaa1111-0000-4000-8000-000000000001",
        kind: "visit_skipped",
        title: "Visit skipped — Northbrook Homeowners Association #4471",
        body: "Alejandro Villanueva-Castro skipped 4413 North Ravenswood Manor Terrace: gate padlocked, no code on file.",
        link: "/routes",
        read_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: "aaaa1111-0000-4000-8000-000000000002",
        kind: "invoice_overdue",
        title: "Invoice INV-2026-1041 is 6 days overdue",
        body: "Anastasia Vandermolen-Whitaker owes $185.00.",
        link: "/invoices",
        read_at: null,
        created_at: new Date(Date.now() - 3 * 3600e3).toISOString(),
      },
    ],
    unread: 2,
  },

  // ── Dashboard ───────────────────────────────────────────────────────────
  getDashboardSummary: () => {
    const visits = fx.visitsBetween(fx.TODAY, fx.TODAY);
    const counts: Record<string, number> = {
      total: visits.length,
      completed: 0,
      skipped: 0,
      in_progress: 0,
      scheduled: 0,
      cancelled: 0,
    };
    for (const v of visits) counts[v.status as string] = (counts[v.status as string] ?? 0) + 1;
    return {
      today: fx.TODAY,
      activeClients: 214,
      mtdRevenueCents: 1_238_400,
      mtdGrossCents: 1_301_900,
      mtdRefundsCents: 63_500,
      arOpenCents: 480_500,
      overdueCount: 3,
      visitCounts: counts,
      unassignedToday: visits.filter((v) => !v.assigned_staff_id).length,
      weatherFlaggedToday: visits.filter((v) => v.weather_flagged).length,
      todayVisits: visits,
      staff: fx.STAFF.filter((s) => s.is_field_tech).map((s) => ({
        id: s.id,
        display_name: s.display_name,
      })),
      // The real server function MAPS these rows before returning them
      // (src/lib/dashboard.functions.ts:116-125) — clientName, totalCents. This
      // handed back the raw snake_case rows, so the dashboard's Overdue
      // invoices card rendered three blank links and "$NaN" three times, at
      // every width, in every run of both authenticated sweeps since
      // 2026-08-19. Every geometry rule passed, because a blank link and a
      // short string are small. A fixture has to match the SHAPE the caller
      // returns, not the shape the table stores.
      overdueInvoices: fx.INVOICES.filter((i) => i.status === "open").map((i) => ({
        id: i.id,
        clientName: i.clients?.display_name ?? "-",
        totalCents: i.total_cents - (i.credit_applied_cents ?? 0),
        dueOn: i.due_on ?? null,
        issuedAt: i.issued_at,
      })),
      openConcerns: [
        {
          id: "cccc1111-0000-4000-8000-000000000001",
          category: "missed_area",
          message:
            "Back corner by the shed was not done — third week running, please pass it on to whoever covers Tuesdays.",
          createdAt: new Date().toISOString(),
          clientName: "Kimberly-Anne Rutherford-Sinclair",
          visitId: null,
        },
      ],
    };
  },

  // ── Schedule / dispatch ─────────────────────────────────────────────────
  listVisitsForDay: (a) => ({
    visits: fx.visitsBetween(a.day ?? fx.TODAY, a.throughDay ?? a.day ?? fx.TODAY),
  }),
  listStaff: { staff: fx.STAFF },
  listTimeOff: { rows: [] },
  getDispatchSettings: {
    settings: {
      workday_start: "07:30",
      workday_end: "17:00",
      avg_speed_kmh: 32,
      traffic_profile: "normal",
      max_drive_minutes: 480,
      timezone: "America/Chicago",
      work_days: [1, 2, 3, 4, 5],
      auto_generate_days_ahead: 21,
      notify_schedule_horizon: true,
    },
  },
  getWeatherForZones: { zones: [], enabled: false },
  listZones: {
    zones: [
      {
        id: "zzzz1111-0000-4000-8000-000000000001",
        name: "Ravenswood Manor / Lincoln Square North",
        postal_prefix: "606",
        color: "#2563eb",
      },
    ],
  },

  // ── Clients ─────────────────────────────────────────────────────────────
  listClients: { clients: fx.CLIENTS },
  getSmsConsentCoverage: { withPhone: 198, consented: 142, optedOut: 11 },
  getClient: {
    client: {
      ...fx.CLIENTS[0],
      first_name: "Anastasia",
      last_name: "Vandermolen-Whitaker",
      company: null,
      tags: ["vip", "gate-code-on-file"],
      notes: "Prefers the side gate. Do not use the front walk — the dog bolts.",
      billing_email: "anastasia.vandermolen.whitaker@longishmailprovider.example.com",
      autopay_enabled: true,
      stripe_customer_id: "cus_QxT7HkPmZ3vLd8RaFn2Wq0",
      organization_id: fx.ORG_ID,
    },
  },
  listPropertiesForClient: { properties: [fx.PROPERTIES[0], fx.PROPERTIES[1]] },
  listSubscriptionsForClient: {
    subscriptions: [
      {
        id: "ffffffff-0000-4000-8000-000000000001",
        client_id: fx.CLIENT_ID,
        property_id: fx.PROPERTY_ID,
        status: "active",
        frequency: "weekly",
        price_cents: 2_400,
        dog_count: 2,
        starts_on: fx.TODAY,
        ends_on: null,
        preferred_time_of_day: "morning",
        account_type: "residential",
      },
    ],
  },
  listClientVisitHistory: { visits: fx.visitsBetween(fx.TODAY, fx.TODAY).slice(0, 6) },
  listDogsForClient: {
    dogs: [
      {
        id: "dddd0001",
        property_id: fx.PROPERTY_ID,
        name: "Bartholomew",
        breed: "Bernese Mountain Dog",
        weight_class: "large",
        temperament: "friendly",
        notes: null,
        active: true,
        unit_id: null,
        dna_status: "enrolled",
        property_street: fx.PROPERTIES[0].street,
      },
      {
        id: "dddd0002",
        property_id: fx.PROPERTY_ID,
        name: "Persephone",
        breed: "Miniature Australian Labradoodle",
        weight_class: "small",
        temperament: "shy",
        notes: null,
        active: true,
        unit_id: null,
        dna_status: "not_enrolled",
        property_street: fx.PROPERTIES[0].street,
      },
    ],
  },
  getClientCredit: { balanceCents: 4_250, ledger: [] },
  getClientBillingSummary: {
    client: {
      autopay_enabled: true,
      default_card_brand: "visa",
      default_card_last4: "4242",
      default_payment_method_id: "pm_1QxT7HkPmZ3vLd8RaFn2Wq0Bs",
      stripe_customer_id: "cus_QxT7HkPmZ3vLd8RaFn2Wq0",
      primary_email: "anastasia.vandermolen.whitaker@longishmailprovider.example.com",
      autopay_paused: false,
      autopay_failure_count: 0,
      autopay_last_error: null,
      autopay_last_attempt_at: null,
    },
    invoices: fx.INVOICES.slice(0, 4),
  },
  listClientNotes: { notes: [], rows: [] },
  listClientHolds: { holds: [], rows: [] },
  listClientMessages: { messages: [], rows: [] },
  listAddonServices: { services: [], addons: [], rows: [] },
  listInvoices: fx.INVOICES,
  getCollectedThisMonth: { grossCents: 1_301_900, refundsCents: 63_500, netCents: 1_238_400 },

  // ── Address autocomplete (seven fields were wired to it today) ──────────
  addressSearchStatus: { enabled: true, provider: "google", configured: true },
  searchAddresses: {
    suggestions: [
      {
        id: "s1",
        description: "4413 North Ravenswood Manor Terrace Apartment 2B, Chicago, IL 60625, USA",
      },
      { id: "s2", description: "4426 North Ravenswood Manor Terrace, Chicago, IL 60625, USA" },
    ],
  },

  // ── Settings ────────────────────────────────────────────────────────────
  getOrgBranding: {
    branding: { logo_path: null, accent_hex: "#2563eb", company_name: fx.ORG_NAME },
  },
  getStandardPricing: { pricing: [] },
  getSignupSettings: {
    orgName: fx.ORG_NAME,
    signupSlug: fx.ORGANIZATION.portal_slug,
    portalSlug: fx.ORGANIZATION.portal_slug,
    effectiveSlug: fx.ORGANIZATION.portal_slug,
    publicSignupEnabled: true,
  },
  listOrgInvites: { invites: [] },
  listStaffAddresses: { staff: fx.STAFF },
  listOrgUsers: {
    users: fx.STAFF.map((s, i) => ({
      user_id: `77777777-0000-4000-8000-${String(500000000000 + i).slice(0, 12)}`,
      staff_id: s.id,
      display_name: s.display_name,
      email: `${s.display_name.toLowerCase().replace(/[^a-z]+/g, ".")}@whitfield-ramirez-yard-services.example.com`,
      role: s.role === "tech" ? "tech" : "dispatcher",
      active: true,
      is_field_tech: s.is_field_tech,
      last_sign_in_at: new Date(Date.now() - i * 864e5).toISOString(),
    })),
    rows: [],
    seats: { used: 7, included: 10 },
  },
  listInvites: { invites: [], rows: [] },

  // ── Platform console ────────────────────────────────────────────────────
  listPlatformTenants: { rows: fx.PLATFORM_TENANTS },
  getPlatformOverview: {
    mrr_cents: 68_400,
    active_tenants: 3,
    free_tenants: 1,
    past_due_tenants: 1,
    grace_tenants: 1,
    suspended_tenants: 1,
    new_signups_week: 2,
    at_threshold: 4,
    converted_this_month: 1,
    at_risk: 2,
  },
  getPlatformStripeConfig: { stripeConfigured: true, mode: "test" },
  getTenantDetail: {
    id: fx.ORG_ID,
    name: fx.ORG_NAME,
    billing_status: "active",
    plan_status: "active",
    plan_id: "66666666-0000-4000-8000-00000000f002",
    plan_name: "Pro",
    plan_slug: "pro",
    active_client_count: 214,
    stripe_customer_id: fx.ORGANIZATION.stripe_customer_id,
    stripe_subscription_id: fx.ORGANIZATION.stripe_subscription_id,
    grace_expires_at: null,
    suspended_at: null,
    suspended_reason: null,
    created_at: fx.PLATFORM_TENANTS[0].created_at,
    deleted_at: null,
    users: fx.STAFF.slice(0, 4).map((s, i) => ({
      user_id: `77777777-0000-4000-8000-${String(600000000000 + i).slice(0, 12)}`,
      email: `${s.display_name.toLowerCase().replace(/[^a-z]+/g, ".")}@whitfield-ramirez-yard-services.example.com`,
      role: i === 0 ? "owner" : "office_manager",
      created_at: new Date(Date.now() - i * 20 * 864e5).toISOString(),
    })),
  },
  listTenantNotes: { rows: [] },
  listTenantFeatureFlags: { rows: [] },
  listTenantInvoices: { rows: [] },
  listTenantAudit: { rows: fx.TENANT_AUDIT },
  listPlatformUsers: (a) => {
    const limit = Number(a.limit ?? 50);
    const offset = Number(a.offset ?? 0);
    return {
      rows: fx.platformUsers(offset, limit),
      total: fx.PLATFORM_USER_TOTAL,
      offset,
      limit,
      // `unattached` is deliberately four digits: the sentence it renders is the
      // longest line on the card, and a fixture that left it null would measure
      // the page without the thing that was just added to it.
      scan: {
        membershipRows: 214,
        membershipsComplete: true,
        accounts: fx.PLATFORM_USER_TOTAL,
        accountsComplete: true,
        unattached: 1284,
      },
    };
  },

  // ── My Day (the field surface `docs/mobile-ux-audit.md` calls the most
  //    mobile-ready screen in the app, which is a claim worth measuring) ────
  listMyDayFieldStaff: {
    staff: fx.STAFF.map((s) => ({ id: s.id, display_name: s.display_name, role: s.role })),
  },
  getMyDay: () => {
    const visits = fx
      .visitsBetween(fx.TODAY, fx.TODAY)
      .filter((v) => v.assigned_staff_id === fx.STAFF[0].id)
      .map((v, i) => ({
        ...v,
        organization_id: fx.ORG_ID,
        started_at: i === 0 ? new Date().toISOString() : null,
        completed_at: null,
        skip_reason: null,
        skip_reason_code: null,
        clients: {
          display_name: (v.clients as any).display_name,
          primary_phone: "+1 (312) 555-0142",
          dna_compliance_enabled: false,
        },
        properties: {
          ...(v.properties as any),
          account_type: "residential",
          has_units: false,
          gate_code: "5521#",
          lock_box_code: null,
          key_location: "Under the planter beside the side gate",
          parking_notes: "Alley access only — do not block the neighbour's pad",
          access_notes: "Latch sticks; lift while pulling",
          yard_size: "medium",
          invisible_fence: false,
          escape_risk: true,
          dog_in_yard_during_service: true,
          aggressive_dog: false,
          bees_wasps: false,
          sharp_objects: false,
          slippery_surfaces: false,
          do_not_enter_if_dog_out: false,
          hazard_notes: "Loose paving slab by the back step",
          dogs: [{ name: "Bartholomew", temperament: "friendly" }],
        },
        zones: { name: "Ravenswood Manor / Lincoln Square North" },
        visit_photos: [],
      }));
    return { staff: { ...fx.STAFF[0], organization_id: fx.ORG_ID }, visits, previewing: false };
  },
  listVisitsAwaitingCloseOut: { visits: [] },

  getPlanCatalogMirror: { rows: [], mismatches: [] },

  // ── Writes. Nothing here writes anywhere; they exist so an accidental
  //    click during an interaction step does not throw a red toast into the
  //    measurement.
  markNotificationRead: ok,
  dismissAnnouncement: ok,
  dismissOnboarding: ok,
};

/** 1x1 transparent PNG. Stands in for map tiles and any other remote image, so
 *  the boxes stay exactly where the layout puts them and the sweep does not
 *  depend on OpenStreetMap being up. */
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Rows for the few tables the browser still reads over PostgREST directly. */
const TABLES: Record<string, unknown> = {
  platform_plans: fx.PLATFORM_PLANS.map((p) => ({
    ...p,
    is_enterprise: p.slug === "enterprise",
    currency: "usd",
    stripe_seat_price_id: null,
    stripe_annual_seat_price_id: null,
  })),
};

export type StubReport = {
  /** Server functions the app called that this file has no entry for. */
  unstubbed: string[];
  /** Hosts the page tried to reach that the fence turned back. */
  blockedHosts: string[];
};

/**
 * Install both interceptors. Returns a live report of what went unanswered,
 * read by the spec after each surface is measured.
 */
/**
 * The role every sweep before 2026-08-28 ran as, and the only one.
 *
 * `useMyRole` reads `getMyOrg().organization.role` — not the profile, which is
 * a different field on a different call and was the first place I looked. Four
 * stubs have to agree or the app renders a nav for one role and a page for
 * another, which measures nothing about either.
 */
export type SweepRole = "owner" | "office_manager" | "dispatcher" | "tech";

/**
 * The customer's half of the product.
 *
 * Kept separate from BASE_STUBS and opted into, because a portal page and a
 * staff page never coexist: the portal has no Supabase session at all -- it
 * authenticates on a token in the URL -- so installing both would only make
 * the unstubbed report harder to read.
 *
 * `verified: true` is the whole point. Every one of the eleven data queries in
 * portal-ui.tsx is `enabled: verified`, so a fixture that stops at the OTP gate
 * measures the OTP gate eleven times.
 */
const PORTAL_STUBS: Record<string, Stub> = {
  portalOrgBySlug: { found: true, branding: pfx.PORTAL_BRANDING },
  portalContext: {
    verified: true,
    valid: true,
    client: pfx.PORTAL_CLIENT,
    branding: pfx.PORTAL_BRANDING,
  },
  portalGetClient: pfx.PORTAL_CLIENT,
  portalListUpcomingVisits: pfx.PORTAL_UPCOMING_VISITS,
  portalListRecentVisits: pfx.PORTAL_RECENT_VISITS,
  portalListInvoices: pfx.PORTAL_INVOICES,
  portalListPrepaidSubs: pfx.PORTAL_SUBS,
  portalListAddonCatalog: pfx.PORTAL_ADDON_CATALOG,
  portalListClientAddons: pfx.PORTAL_CLIENT_ADDONS,
  portalListDogs: pfx.PORTAL_DOGS,
  portalListStations: pfx.PORTAL_STATIONS,
  portalListMyRequests: pfx.PORTAL_REQUESTS,
  portalGetReferral: pfx.PORTAL_REFERRAL,
  portalListProperties: pfx.PORTAL_PROPERTIES,
  // `{ urls: Record<path, url> }`, not a list. A list crashed the Visits page
  // outright -- "Cannot read properties of undefined" on the first path -- and
  // the sweep would have measured the error boundary. The fence answers images
  // with a transparent PNG, so what is being measured is the grid, not the
  // picture.
  portalSignPhotoUrls: {
    urls: Object.fromEntries(
      pfx.PORTAL_RECENT_VISITS.flatMap((v) =>
        v.photo_paths.map((path) => [path, `/portal-photo/${encodeURIComponent(path)}`]),
      ),
    ),
  },
  portalSelfServeOptions: {
    allow_self_reschedule: true,
    allow_vacation_hold: true,
    allow_frequency_change: true,
    reschedule_cutoff_hours: 24,
  },
};

export async function installStubBackend(
  context: BrowserContext,
  options: { role?: SweepRole; portal?: boolean } = {},
): Promise<StubReport> {
  const report: StubReport = { unstubbed: [], blockedHosts: [] };
  const user = sweepUser();
  const role: SweepRole = options.role ?? "owner";

  // Everything the shell asks about who this is, kept consistent. The platform
  // console is an Anthropic-side surface and nobody below owner has it — a
  // dispatcher who is also a platform admin is not a scenario the app ships.
  const STUBS: Record<string, Stub> = {
    ...(options.portal ? PORTAL_STUBS : BASE_STUBS),
    getMyOrg: { organization: { ...fx.ORGANIZATION, role } },
    getPlatformContext: { isPlatformAdmin: role === "owner" },
    getMyProfile: {
      ...(BASE_STUBS.getMyProfile as Record<string, any>),
      staff: { ...(BASE_STUBS.getMyProfile as any).staff, role },
    },
    getBillingBannerStatus: { planStatus: "active", role },
  };

  // ── THE FENCE ─────────────────────────────────────────────────────────
  //
  // Registered FIRST, which in Playwright means matched LAST: handlers run in
  // reverse order of registration, so everything specific below overrides it.
  //
  // Its job is the guarantee. The browser client in this repo is hard-coded to
  // the production project, the app has map tiles and payment scripts, and a
  // sweep is not a thing anyone should have to audit line by line before
  // running. So: nothing leaves for a host that is not the dev server, full
  // stop, and what tried is written down rather than silently dropped.
  //
  // Fulfilled empty rather than aborted. An aborted script tag can throw
  // inside the app and land the page on its error boundary, which the guard
  // would then correctly refuse to measure — a fence that breaks the test is
  // a fence people remove.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
    if (!report.blockedHosts.includes(url.hostname)) report.blockedHosts.push(url.hostname);
    const type = route.request().resourceType();
    if (type === "image" || type === "font" || type === "media") {
      return route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG });
    }
    if (type === "script")
      return route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
    if (type === "stylesheet")
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await context.route(`${SUPABASE_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/user") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(user),
      });
    }
    if (url.pathname.startsWith("/auth/v1/token")) {
      // A refresh must not look like a revoked session, or the shell signs out
      // mid-measurement and the guard reports a login screen.
      const { sweepSession } = await import("./session");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(sweepSession()),
      });
    }
    if (url.pathname.startsWith("/storage/")) {
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
    // A handful of surfaces still read PostgREST straight from the browser
    // rather than through a server function — the platform Plans page is the
    // one that matters, and a plans table that answers `[]` renders "No plans
    // yet", which is a page with no catalog in it and nothing to measure.
    const table = url.pathname.startsWith("/rest/v1/")
      ? url.pathname.slice("/rest/v1/".length)
      : "";
    if (table in TABLES) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TABLES[table]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await context.route("**/_serverFn/**", async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    let file = "";
    try {
      const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
      name = String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
      file = String(meta.file ?? "").replace("?tss-serverfn-split", "");
    } catch {
      /* an id we cannot read is reported as such below */
    }

    let value: unknown = null;
    if (name in STUBS) {
      const stub = STUBS[name];
      value =
        typeof stub === "function"
          ? (stub as (a: Record<string, any>) => unknown)(argsOf(route))
          : stub;
    } else {
      const label = `${name || id.slice(0, 24)}  (${file})`;
      if (!report.unstubbed.includes(label)) report.unstubbed.push(label);
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: value }),
    });
  });

  return report;
}
