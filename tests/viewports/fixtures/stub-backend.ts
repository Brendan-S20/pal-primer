import type { BrowserContext, Route } from "@playwright/test";
import { SUPABASE_ORIGIN, sweepUser } from "./session";
import * as fx from "./dataset";
import * as pfx from "./portal-dataset";
import { tippedCharge } from "../../../src/lib/tips";

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

export type Stub = unknown | ((args: Record<string, any>) => unknown);

const ok = { ok: true };

/** The end-of-day step's wording for a business that does not run pet waste
 *  (onboarding.functions.ts asks "Where does your day end?" instead of for a
 *  dump site). Same id, place and gate as the pet-waste step in BASE_STUBS,
 *  as on the server, because /setup walks the ids. Open, so its panel is
 *  drawn and measured. */
const DAY_END_WORDING = {
  label: "Where does your day end?",
  description:
    "Set where each tech finishes the day: home, the shop, wherever the van parks. Routes end there instead of at the last stop, which usually cuts a lot of driving.",
  done: false,
  cta: "Set day's end",
};

/**
 * Name → reply. Named for the export, so one entry serves every route that
 * calls it and a rename in `src/lib` shows up here as an unstubbed call
 * rather than as a wrong-looking page.
 */
export const BASE_STUBS: Record<string, Stub> = {
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
  getMyOrgFeatures: {
    commercialAccounts: true,
    hasCommercialData: true,
    requireCompletionPhoto: true,
    recleanWindowHours: 48,
    // Settings -> Preferences draws the checklist editor from this: one row
    // per item, the 120-character label in a text field, at every width.
    visitChecklist: fx.VISIT_CHECKLIST,
    emailVisitChecklist: false,
    // EXPLICITLY pet waste, not left to the fail-open. useServiceLines reads
    // a missing value as pet waste too, so leaving this out would still draw
    // the waste log -- but by accident, and the day the fallback changed the
    // whole sweep would quietly start measuring the other branch. Spelled out
    // so the waste log, the Yard step, the dump-site step and the first
    // cleanup card stay measured on purpose. The other branch has its own
    // fixture: installStubBackend({ serviceLines: ["dog_walking"] }), measured
    // by a-business-that-does-not-scoop.spec.ts.
    serviceLines: ["pet_waste"],
  },
  // /leads, and /clients/new?fromLead=<id>. The wizard is answered with the
  // first (convertible) lead AND an existing client on the same email, so the
  // "already has this lead's email" panel is measured too: it is the densest
  // thing the wizard draws above its first step.
  listLeads: [...fx.LEADS, ...fx.WORKING_LEADS],
  getLeadFormConfig: {
    orgName: fx.ORG_NAME,
    slug: "whitfield-ramirez-yard-and-waste-services",
    publicSignupEnabled: true,
    submissionsTotal: fx.LEADS.length,
    submissionsLast30: fx.LEADS.length,
    config: null,
  },
  getLeadForConversion: (args: Record<string, any>) => {
    const lead = fx.LEADS.find((l) => l.id === args.id) ?? fx.LEADS[0];
    const { organization_id: _org, created_at: _c, updated_at: _u, contacted_at: _t, converted_at: _v, ...rest } =
      lead;
    return {
      lead: rest,
      existingClient: { id: fx.CLIENT_ID, displayName: fx.CLIENTS[0].display_name },
    };
  },
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
  // ── The setup checklist on /dashboard ───────────────────────────────────
  //
  // Was `{ steps: [], completed: 0, total: 0, dismissed: true }` until
  // 2026-09-14 — an entry that answers the call and renders nothing, because
  // the component returns null on `dismissed` before it draws a row. So the
  // sweep measured /dashboard at four widths with the checklist absent, and
  // was green because nothing was there. A fixture that exists is not a
  // fixture of the right shape; this is the CLAUDE.md lesson in its quieter
  // costume, where the fault is the VALUE rather than the missing key.
  //
  // Deliberately MID-PROGRESS. A finished checklist renders every row with a
  // line-through and NO button at all, so a fixture where everything is done
  // measures the one state that has no controls in it. Three steps are open,
  // and one of them ("clients") is the step that carries two buttons -- which
  // is the widest row this component can produce and the only one that can
  // push a control off a 360px screen.
  getOnboardingStatus: {
    completed: 3,
    total: 6,
    dismissed: false,
    emailVerified: true,
    // The six steps of src/lib/onboarding.functions.ts, which the guided setup
    // at /setup walks too. Mid-progress for the reason above, and the open
    // steps are chosen: "clients" is the row with two buttons, "dump_site"
    // and "payouts" are the steps the guide does in place and links out for.
    steps: [
      {
        id: "business",
        label: "Your business details",
        description:
          "Your business address and time zone. Routes start from the address, and the time zone decides what counts as today.",
        done: true,
        to: "/setup",
        cta: "Add details",
        gate: "/settings/business",
      },
      {
        id: "zones",
        label: "Your service area and price",
        description:
          "Where you work and what you charge per visit. New clients in the area are quoted this price.",
        done: true,
        to: "/setup",
        cta: "Set your price",
        gate: "/zones",
      },
      {
        id: "clients",
        label: "Add or import clients",
        description: "Bring in at least one client (or upload a CSV to seed many at once).",
        done: false,
        to: "/clients/new",
        cta: "Add client",
        gate: "/clients",
        alt: { to: "/imports", cta: "Import CSV", gate: "/imports" },
      },
      {
        id: "staff",
        label: "Who runs the route",
        description:
          "Say if you run the route yourself, or invite a tech. Visits are only handed to people who run routes.",
        done: true,
        to: "/setup",
        cta: "Choose",
        gate: "/settings/users",
      },
      {
        id: "dump_site",
        label: "Where the day ends",
        description:
          "Where the crew unloads at the end of the day. Routes end there, so adding it usually cuts a lot of driving.",
        done: false,
        to: "/setup",
        cta: "Add dump site",
        gate: "/settings/users",
      },
      {
        id: "payouts",
        label: "Get paid",
        description:
          "Connect Stripe so clients can pay by card and the money lands in your bank. Verify your email first. You can do this later.",
        done: false,
        to: "/payments",
        cta: "Set up payouts",
        gate: "/payments",
      },
    ],
  },
  listActiveAnnouncements: { rows: [] },
  getSuspensionState: null,
  // The header's auto-routing indicator asks on every page for an owner,
  // office manager or dispatcher. Nothing running is the everyday answer;
  // auto-routing-runs-in-the-background.spec.ts overrides it with a run.
  listMyRoutingRuns: { runs: [], serverNow: 0 },
  markRoutingRunSeen: ok,
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
        title: "Invoice INV-10420 is 6 days overdue",
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
  // The drift report. Deliberately awkward: the 18x Westside fault that real
  // data actually contains, a customer paying well ABOVE the card so the
  // report is not only a collections tool, a hand-priced row, and an unzoned
  // one -- which is 43% of the real book and the case with no numbers to lay
  // out at all.
  getPricingDrift: {
    currency: "usd",
    summary: {
      total: 4,
      noZone: 1,
      onRate: 0,
      under: 2,
      over: 1,
      underSumCents: 47898,
      overSumCents: -6500,
      handPriced: 1,
    },
    rows: [
      {
        subscriptionId: "ssss1111-0000-4000-8000-000000000001",
        clientId: fx.CLIENT_ID,
        clientName: "Kimberly-Anne Rutherford-Sinclair",
        frequency: "biweekly",
        outcome: "under",
        zoneId: "zzzz1111-0000-4000-8000-000000000001",
        zoneName: "Ravenswood Manor / Lincoln Square North",
        paidCents: 2600,
        todayCents: 48946,
        diffCents: 46346,
        ratio: 18.825,
        areaCapped: false,
        handPriced: false,
        pricedAt: null,
        pricedFromZoneId: null,
        priceOverriddenAt: null,
      },
      {
        subscriptionId: "ssss1111-0000-4000-8000-000000000002",
        clientId: fx.CLIENT_ID,
        clientName: "Devonshire Estates Commercial Grounds",
        frequency: "weekly",
        outcome: "over",
        zoneId: "zzzz1111-0000-4000-8000-000000000001",
        zoneName: "Ravenswood Manor / Lincoln Square North",
        paidCents: 9000,
        todayCents: 2500,
        diffCents: -6500,
        ratio: 0.2777,
        areaCapped: true,
        handPriced: true,
        pricedAt: "2026-03-04T00:00:00Z",
        pricedFromZoneId: "zzzz1111-0000-4000-8000-000000000001",
        priceOverriddenAt: "2026-08-19T00:00:00Z",
      },
      {
        subscriptionId: "ssss1111-0000-4000-8000-000000000003",
        clientId: fx.CLIENT_ID,
        clientName: "Constantine Papadopoulos-Andreou",
        frequency: "twice_weekly",
        outcome: "under",
        zoneId: "zzzz1111-0000-4000-8000-000000000001",
        zoneName: "Ravenswood Manor / Lincoln Square North",
        paidCents: 2948,
        todayCents: 4500,
        diffCents: 1552,
        ratio: 1.5264,
        areaCapped: false,
        handPriced: false,
        pricedAt: "2026-05-21T00:00:00Z",
        pricedFromZoneId: "zzzz1111-0000-4000-8000-000000000001",
        priceOverriddenAt: null,
      },
      {
        subscriptionId: "ssss1111-0000-4000-8000-000000000004",
        clientId: fx.CLIENT_ID,
        clientName: "Jean-Baptiste Moreau-Lachapelle",
        frequency: "monthly",
        outcome: "no_zone",
        zoneId: null,
        zoneName: null,
        paidCents: 7400,
        todayCents: null,
        diffCents: null,
        ratio: null,
        areaCapped: false,
        handPriced: false,
        pricedAt: null,
        pricedFromZoneId: null,
        priceOverriddenAt: null,
      },
    ],
  },
  // The coverage banner. Chosen to be the awkward case rather than the happy
  // one: a long zone name inside a long sentence, which is exactly what
  // overflows a 360px banner.
  getZoneCoverage: {
    summary: {
      total: 110,
      covered: 54,
      uncovered: 56,
      stale: 56,
      orphaned: 54,
      reassigned: 2,
      unassigned: 0,
      perZone: [
        {
          zoneId: "zzzz1111-0000-4000-8000-000000000001",
          zoneName: "Ravenswood Manor / Lincoln Square North",
          wouldMatch: 54,
        },
        {
          zoneId: "zzzz1111-0000-4000-8000-000000000002",
          zoneName: "Uptown / Edgewater Beach Commercial Grounds",
          wouldMatch: 0,
        },
      ],
    },
    problem:
      "56 of 110 properties fall outside every zone, 54 still carry a zone the rules would no longer give them, Uptown / Edgewater Beach Commercial Grounds matches no properties.",
  },
  // First-cleanup pricing: tiered, with the long answer, so the Zones page's
  // summary card, its editor, the quote editor's "Add first cleanup" and the
  // new-client wizard all draw it. Off would draw one sentence and nothing to
  // measure.
  getFirstCleanupPricing: fx.FIRST_CLEANUP_PRICING,
  // Settings asks this only for a business without pet waste, to decide
  // whether "Deep clean" is still worth a tab (it is while it is on). Off
  // here, so the dog-walking fixture measures the rail without it.
  getDeepCleanSettings: { enabled: false, months: [3, 10], chargeCents: 4900 },
  // The quote editor's pricing (2026-10-01, "a quote started from nothing"):
  // a priced zone with the long name, the standard price, and a client with
  // three dogs every two weeks. So /quotes/new from a lead opens with its
  // per-visit line already priced and the "Priced from ..." note under it --
  // the longest thing the line card draws -- and the picker has three rows.
  getQuotePricing: (a: Record<string, any>) => ({
    zones: [
      {
        id: "zzzz1111-0000-4000-8000-000000000001",
        name: "Ravenswood Manor / Lincoln Square North",
        zip_codes: ["60625"],
        geo_match_mode: "zip",
        base_price_cents: 2800,
        per_dog_addl_cents: 600,
        pricing_mode: "flat",
      },
      {
        id: "zzzz1111-0000-4000-8000-000000000002",
        name: "Uptown / Edgewater Beach Commercial Grounds",
        zip_codes: ["60640"],
        geo_match_mode: "zip",
        base_price_cents: 3400,
        per_dog_addl_cents: 500,
        pricing_mode: "flat",
      },
    ],
    standard: {
      basePriceCents: 2500,
      perDogAddlCents: 500,
      frequencyMultipliers: { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 },
    },
    subject:
      a.clientId || a.leadId
        ? {
            zoneId: "zzzz1111-0000-4000-8000-000000000001",
            postalCode: "60625",
            dogCount: 3,
            frequency: "biweekly",
            accountType: "residential",
          }
        : null,
    subjectLabel: null,
  }),
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

  // ── Leads and reports. Both were unstubbed until 2026-09-28, and both
  //    pages were wider than a phone on real data while this sweep called
  //    them green: /leads drew its empty state with no "Preview form" button,
  //    and /reports threw on a null and was measured as an error boundary.
  //    `listLeads` returns the bare rows, not `{ leads }`; the page reads
  //    `data ?? []`. listLeads and getLeadFormConfig are answered above, with
  //    the conversion states and the awkward working leads together.
  getReports: fx.REPORTS,
  // /concerns. Unstubbed until 2026-09-28, when re-clean requests landed there
  // with a booking button; without this it drew only its empty state.
  listConcerns: fx.CONCERNS,
  // /quotes and /quotes/:id. Keyed by id: an accepted prospect quote draws
  // the timeline and Convert; the draft draws the editor.
  listQuotes: fx.QUOTES,
  getQuote: (a) => fx.quoteDetail(String(a.id ?? fx.QUOTE_ACCEPTED_ID)),
  // /settings/webhooks. Awkward on purpose: a Zapier catch URL is ~70
  // characters with no space to break at, a receiver's error body can be a
  // wall of JSON, and a switched-off endpoint carries its reason. Without
  // these the page draws only its empty state and its add button.
  listWebhookEndpoints: [
    {
      id: "0e000000-0000-4000-8000-000000000001",
      url: "https://hooks.zapier.com/hooks/catch/18273645/3kq9zx7/?source=houndstack-production-account-2026",
      description: "Zapier: new clients to Mailchimp, completed visits to the Google review request sheet",
      events: ["client.created", "visit.completed", "visit.skipped", "invoice.paid", "payment.received"],
      enabled: true,
      // The Mailchimp Zap needs the address, so this one sends it.
      include_contact: true,
      secret_last4: "Qz9x",
      consecutive_failures: 2,
      disabled_at: null,
      disabled_reason: null,
      last_success_at: "2026-09-28T14:05:00Z",
      last_failure_at: "2026-09-29T09:12:00Z",
      created_at: "2026-09-01T12:00:00Z",
      updated_at: "2026-09-29T09:12:00Z",
    },
    {
      id: "0e000000-0000-4000-8000-000000000002",
      url: "https://n8n.whitfield-ramirez-pet-waste-services.example.com/webhook/0b4e9f2c-6a1d-4c3e-9b8a-77f1e2d3c4b5",
      description: "",
      events: ["lead.created"],
      enabled: false,
      include_contact: false,
      secret_last4: "a1B2",
      consecutive_failures: 5,
      disabled_at: "2026-09-27T03:00:00Z",
      disabled_reason: "Switched off after 5 deliveries in a row failed",
      last_success_at: null,
      last_failure_at: "2026-09-27T03:00:00Z",
      created_at: "2026-09-10T12:00:00Z",
      updated_at: "2026-09-27T03:00:00Z",
    },
  ],
  listWebhookDeliveries: [
    {
      id: "0d000000-0000-4000-8000-000000000001",
      endpoint_id: "0e000000-0000-4000-8000-000000000001",
      event_type: "payment.received",
      status: "pending",
      attempts: 2,
      last_status_code: 502,
      last_error:
        'HTTP 502: {"status":"error","message":"upstream_timeout","request_id":"req_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c","retry":true}',
      next_attempt_at: "2026-09-29T09:17:00Z",
      last_attempt_at: "2026-09-29T09:12:00Z",
      delivered_at: null,
      created_at: "2026-09-29T09:11:00Z",
    },
    {
      id: "0d000000-0000-4000-8000-000000000002",
      endpoint_id: "0e000000-0000-4000-8000-000000000001",
      event_type: "visit.completed",
      status: "succeeded",
      attempts: 1,
      last_status_code: 200,
      last_error: null,
      next_attempt_at: "2026-09-28T14:05:00Z",
      last_attempt_at: "2026-09-28T14:05:00Z",
      delivered_at: "2026-09-28T14:05:00Z",
      created_at: "2026-09-28T14:05:00Z",
    },
    {
      id: "0d000000-0000-4000-8000-000000000003",
      endpoint_id: "0e000000-0000-4000-8000-000000000002",
      event_type: "lead.created",
      status: "failed",
      attempts: 6,
      last_status_code: 302,
      last_error:
        "Redirected to https://n8n.whitfield-ramirez-pet-waste-services.example.com/signin?next=%2Fwebhook%2F0b4e9f2c. Redirects are not followed; use the final URL.",
      next_attempt_at: "2026-09-27T03:00:00Z",
      last_attempt_at: "2026-09-27T03:00:00Z",
      delivered_at: null,
      created_at: "2026-09-26T14:00:00Z",
    },
  ],
  // /campaigns, /campaigns/new and /campaigns/:id, added 2026-09-29. Keyed by
  // id like quotes: the draft opens the editor, the sent one its record.
  listCampaigns: fx.CAMPAIGNS,
  getCampaign: (a) => fx.campaignDetail(String(a.id ?? fx.CAMPAIGN_DRAFT_ID)),
  getCampaignAudience: fx.CAMPAIGN_AUDIENCE,
  previewCampaignEmail: fx.CAMPAIGN_PREVIEW,

  // Whether the business can text its own clients. False, as it is for every
  // business until per-business numbers clear carrier registration, so the
  // sweep measures the Coming soon state every page actually draws today
  // (Messages, the client page, Settings > Automation).
  getClientTextingAvailability: { available: false },

  // /settings/automation, /settings/invoicing and /settings/emails, which
  // read these and threw on the null the fence answered — so the unlisted
  // sweep measured three error boundaries until it learned to refuse one on
  // 2026-09-28. The columns are the organizations row each function selects.
  getAutomationSettings: {
    auto_generate_visits: true,
    auto_generate_days_ahead: 28,
    auto_invoice_enabled: true,
    invoice_net_days: 14,
    invoice_grace_days: 3,
    overdue_reminders_enabled: true,
    overdue_reminder_days: 7,
    dunning_retry_days: [1, 3, 7],
    dunning_pause_after_failures: 3,
    seasonal_deepclean_enabled: true,
    seasonal_deepclean_months: [4, 10],
    notify_sms_overdue_invoice: true,
    notify_sms_payment_failed: true,
    notify_sms_visit_reminder: true,
    notify_sms_on_my_way: true,
    notify_sms_visit_completed: false,
    // On, so the "On my way" card is measured in its checked state.
    on_my_way_on_navigate: true,
  },
  // The Sales tax card on /settings/invoicing. Set, with a label one character
  // short of the most the settings accept, so the card draws its worked example ("A $100.00 invoice
  // becomes $108.25, with a line for ...") rather than the one-line zero state.
  getSalesTaxSettings: { rateBps: 825, label: "County and Special District Service Tax" },
  getEmailSettings: {
    notify_email_invoice_sent: true,
    notify_email_payment_received: true,
    notify_email_visit_completed: false,
    notify_email_weather_reschedule: true,
    notify_email_welcome: true,
    notify_email_overdue: true,
    notify_email_visit_reminder: true,
    notify_email_on_my_way: true,
    notify_email_quote_sent: true,
    quote_followup_days: 3,
  },
  // The weekly digest card, on /settings/emails since 2026-10-02. A recipient
  // with no space in it and longer than a phone is wide, because an email
  // address is exactly the value CLAUDE.md says a parser cannot see overflow.
  getDigestSettings: {
    enabled: true,
    recipientEmail: "dana.whitfield-ramirez@whitfield-ramirez-yard-and-waste-services.example.com",
    lastSentAt: "2026-09-28T13:00:00.000Z",
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
  // The conversation list, newest message per client. One thread ends on the
  // client's text (inbound), so the Inbox has a reply waiting to show; one
  // ends on ours, so it has one it must NOT show. The inbound body is long
  // and the name is the 46-character one, because a row that truncates is
  // what the inbox draws.
  listMessageThreads: {
    threads: [
      {
        id: "abab0000-0000-4000-8000-00000000ab01",
        client_id: fx.CLIENTS[4].id,
        direction: "inbound",
        body: "Hi, the side gate code changed to 4471# this morning, and the dogs will be out in the back yard until noon, can you come after lunch instead?",
        created_at: new Date(Date.now() - 40 * 60e3).toISOString(),
        status: "received",
        clients: {
          display_name: fx.CLIENTS[4].display_name,
          primary_phone: fx.CLIENTS[4].primary_phone,
          sms_opt_out: false,
        },
      },
      {
        id: "abab0000-0000-4000-8000-00000000ab02",
        client_id: fx.CLIENTS[2].id,
        direction: "outbound",
        body: "On my way, arriving between 10:15 and 10:45.",
        created_at: new Date(Date.now() - 3 * 3600e3).toISOString(),
        status: "delivered",
        clients: {
          display_name: fx.CLIENTS[2].display_name,
          primary_phone: fx.CLIENTS[2].primary_phone,
          sms_opt_out: false,
        },
      },
    ],
  },
  listAddonServices: { services: [], addons: [], rows: [] },
  listInvoices: fx.INVOICES,
  // Cash and checks the techs recorded, waiting on /invoices -- see
  // FIELD_COLLECTIONS for why each is awkward.
  listFieldCollections: fx.FIELD_COLLECTIONS,
  // The full invoice page and its Refund dialog. See REFUND_INVOICE.
  getInvoice: fx.REFUND_INVOICE,
  getPaymentRefundQuote: fx.REFUND_QUOTE,
  // Fees & tips on /payments.
  getTipSettings: { tipsEnabled: true },
  // CollectedSummary's counts too: without paymentCount the Invoices card
  // drew "0 payments received" under $13,019 collected, in every sweep.
  getCollectedThisMonth: {
    grossCents: 1_301_900,
    refundsCents: 63_500,
    netCents: 1_238_400,
    paymentCount: 37,
    reversalCount: 2,
  },

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
  // The shape getOrgBranding actually returns: the organizations row. It was
  // `{ branding: { company_name, ... } }`, a shape nothing reads, so the
  // client-portal branding card and the setup guide's business step were both
  // measured with every field empty -- the narrowest version of a form whose
  // fault would be the 46-character name in it. Found by the guided setup's
  // walk, whose business step drew a blank name for a business that has one.
  getOrgBranding: {
    id: fx.ORG_ID,
    name: fx.ORG_NAME,
    brand_color: "#2563eb",
    logo_url: null,
    contact_phone: "+1 (312) 555-0142",
    contact_email: "office@whitfield-ramirez-yard-and-waste-services.example",
    contact_address: "4413 North Ravenswood Manor Terrace, Chicago, IL 60611",
    latitude: 41.9632,
    longitude: -87.6745,
    portal_reschedule_cutoff_hours: 24,
    portal_allow_self_reschedule: true,
    portal_allow_vacation_hold: true,
    portal_allow_frequency_change: true,
    portal_auto_apply_changes: false,
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
  getRoutingHealth: fx.ROUTING_HEALTH,
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
  // ── THE TECHNICIAN'S OWN FORWARD VIEW ───────────────────────────────────
  //
  // Deliberately NOT a tidy week. The row most likely to break is the one that
  // touches several zones with long names next to a two-digit count, so one day
  // here does exactly that; another is partly worked, so the "N left" branch
  // renders; and the dates are spread rather than consecutive, because "which
  // days they work" is only a real answer if days off are absent rather than
  // shown as zero.
  getMyUpcomingDays: {
    staff: { id: fx.STAFF[0].id, organization_id: fx.ORG_ID, display_name: "Dana Whitfield-Ramirez" },
    days: [
      {
        date: fx.TODAY,
        stops: 12,
        done: 5,
        zones: ["Grosse Pointe Woods & Harper Woods", "Downriver \u2014 Taylor"],
        firstEta: `${fx.TODAY}T13:05:00.000Z`,
        lastEta: `${fx.TODAY}T21:40:00.000Z`,
      },
      {
        date: fx.day(1),
        stops: 8,
        done: 0,
        zones: ["Southgate"],
        firstEta: `${fx.day(1)}T13:15:00.000Z`,
        lastEta: `${fx.day(1)}T19:50:00.000Z`,
      },
      // A gap here on purpose: day(2) is a day off and must simply not appear.
      {
        date: fx.day(3),
        stops: 1,
        done: 0,
        zones: [],
        firstEta: null,
        lastEta: null,
      },
    ],
  },
  // ── THE WASTE LOG, a tab on every tech's bar ─────────────────────────────
  //
  // Until a-tech-who-reads-spanish measured it, nothing answered these and the
  // page drew "No manifests yet." and an empty facility list — the narrowest
  // thing it can draw. So: a facility name and address long enough to wrap
  // beside the Directions link, an inactive one (its badge sits beside the
  // name), a ticket number with no space in it, one manifest with no facility
  // (the fallback label), one with a receipt (the Receipt button), and both
  // sides of the bag plural. Shapes are listManifests' select: the row, plus
  // `waste_disposal_facilities(name)` and `staff(display_name)`.
  listFacilities: {
    facilities: [
      {
        id: "f0f0f0f0-0000-4000-8000-000000000001",
        name: "Northbrook–Glenview Regional Transfer & Recycling Station",
        address: "4413 North Ravenswood Manor Terrace, Building C Scale House, Glenview, IL 60025",
        active: true,
      },
      {
        id: "f0f0f0f0-0000-4000-8000-000000000002",
        name: "Old Harper Woods Municipal Compost Yard",
        address: null,
        active: false,
      },
    ],
  },
  listManifests: {
    manifests: [
      {
        id: "f1f1f1f1-0000-4000-8000-000000000001",
        disposed_on: fx.TODAY,
        weight_lbs: 1284.5,
        bag_count: 46,
        ticket_number: "TKT-2026-0930-0048812-NB-GLENVIEW",
        notes:
          "Scale house closed at 3:30, used the after-hours drop. Attendant asked for the bags to be double-tied from now on.",
        photo_url: `${fx.ORG_ID}/1759252800000.jpg`,
        waste_disposal_facilities: {
          name: "Northbrook–Glenview Regional Transfer & Recycling Station",
        },
        staff: { display_name: "Alejandro Villanueva-Castro" },
      },
      {
        id: "f1f1f1f1-0000-4000-8000-000000000002",
        disposed_on: fx.day(-3),
        weight_lbs: 38,
        bag_count: 1,
        ticket_number: null,
        notes: null,
        photo_url: null,
        waste_disposal_facilities: null,
        staff: { display_name: "Dana Whitfield-Ramirez" },
      },
    ],
  },
  // The notification settings panel on /notifications: every type the server
  // lists (notifications-center.functions.ts NOTIFICATION_TYPES, same words),
  // one of them muted so both switch states are drawn.
  getNotificationPrefs: {
    mutedTypes: ["lead"],
    types: [
      { type: "concern", label: "Client concerns" },
      { type: "payment_failed", label: "Failed client payments" },
      { type: "lead", label: "New website leads" },
      { type: "quote_response", label: "Quotes accepted or declined" },
      { type: "receptionist_escalation", label: "AI receptionist escalations" },
      { type: "inbound_sms", label: "Texts needing a reply" },
      { type: "teammate_joined", label: "Teammate joined" },
      { type: "field_collection", label: "Cash or checks collected in the field" },
    ],
  },
  // Live tracking ON, and the technician's scheduled stop today is the one
  // being shared: so /my-day draws the "Sharing your location with ..." chip,
  // with its Stop button, on a real card at every width. Off would render
  // nothing, and a chip nobody measured is the fault this file exists for.
  // The customer name is the fixture's own, 40-odd characters of it.
  getMyLiveShare: () => {
    const v = fx
      .visitsBetween(fx.TODAY, fx.TODAY)
      .find((x) => x.assigned_staff_id === fx.STAFF[0].id && x.status === "scheduled");
    return v
      ? {
          enabled: true,
          active: {
            visitId: v.id,
            customerName: (v.clients as any).display_name,
            until: new Date(Date.now() + 90 * 60_000).toISOString(),
          },
          nextVisitId: null,
        }
      : { enabled: false };
  },
  getMyDay: () => {
    // ── ONE STOP IN EACH STATE, ON PURPOSE ──────────────────────────────
    //
    // The shared dataset gives this technician two visits today and, by where
    // their indices fall in STATUSES, both are terminal or not-yet-started:
    // one `scheduled` and one `completed`. So the card state that changed most
    // on 2026-09-13 — a visit IN PROGRESS, where the photo control and
    // Complete become the primary actions instead of Start — was rendered by
    // nothing the sweep measures. "Which controls show is the visit's own
    // state" was a claim with one of its three states unexercised.
    //
    // So a third stop is borrowed from another technician's day and handed to
    // this one, in progress. `started_at` moves with it rather than being
    // pinned to the first card: a scheduled visit carrying a start time is a
    // shape the database cannot produce, and a fixture that produces it
    // measures something that does not exist.
    const mine = fx
      .visitsBetween(fx.TODAY, fx.TODAY)
      .filter((v) => v.assigned_staff_id === fx.STAFF[0].id);
    const borrowed = fx
      .visitsBetween(fx.TODAY, fx.TODAY)
      .find((v) => v.assigned_staff_id && v.assigned_staff_id !== fx.STAFF[0].id);
    const startedAt = new Date(Date.now() - 22 * 60_000).toISOString();
    const visits = [
      ...mine,
      ...(borrowed
        ? [
            {
              ...borrowed,
              assigned_staff_id: fx.STAFF[0].id,
              status: "in_progress",
              sequence: (mine.length ?? 0) + 1,
            },
          ]
        : []),
    ]
      .map((v, i) => ({
        ...v,
        organization_id: fx.ORG_ID,
        // How this customer pays and what they owe, as my_day_stop_facts
        // would answer -- one stop per shape, see MY_DAY_STOP_EXTRAS.
        stop_facts: fx.MY_DAY_STOP_EXTRAS[i % fx.MY_DAY_STOP_EXTRAS.length].stop_facts,
        started_at: v.status === "in_progress" ? startedAt : null,
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
          // Six named dogs and an outline, nine stations, or nothing on file.
          ...fx.MY_DAY_STOP_EXTRAS[i % fx.MY_DAY_STOP_EXTRAS.length].property,
        },
        zones: { name: "Ravenswood Manor / Lincoln Square North" },
        visit_photos: [],
      }));
    return { staff: { ...fx.STAFF[0], organization_id: fx.ORG_ID }, visits, previewing: false };
  },
  listVisitsAwaitingCloseOut: { visits: [] },
  // The commercial stop's Stations panel, prefetched by My Day: the same
  // nine stations its card lists, none logged on this visit yet.
  getVisitStations: fx.VISIT_STATIONS,
  // The time clock card at the top of My Day, drawn ON the clock with an
  // earlier shift today, which is the longer of its two second lines.
  getMyClock: fx.MY_CLOCK,
  // /timesheets. The dataset's week is the awkward one described there:
  // overtime, a shift across midnight, somebody on the clock now, and a tech
  // with visits and no hours.
  listTimesheet: fx.TIMESHEET,
  // /expenses: a month with every category, a 72-character vendor and a
  // seven-figure amount. And the field sheet's rate, for its mileage preview.
  listExpenses: fx.EXPENSE_LIST,
  getExpenseSettings: fx.EXPENSE_SETTINGS,

  getPlanCatalogMirror: { rows: [], mismatches: [] },

  // The calendar feed card, on /profile and /settings/scheduling. The owner
  // has BOTH rows (a staff record and view_client_directory), the own link
  // already made and read, the all-visits link not yet made -- so both
  // states draw, and the longer of the two status lines is the real one.
  getMyCalendarFeeds: fx.CALENDAR_FEEDS,
  // Settings -> Client portal's extra-cleanup card, and the /concerns "Book
  // it" dialog, which starts its price from here. No price set: the longer
  // of the card's two states ("Needs a price first") and the dialog's note
  // that this one is the office's to price.
  getPortalBookingSettings: fx.PORTAL_BOOKING_SETTINGS,
  // "Create link" answers with a URL the length production makes: the app
  // origin, the path, 43 base64url characters and `.ics`. A short fixture URL
  // would never test the box it is shown in.
  createCalendarFeedLink: { url: fx.CALENDAR_FEED_URL, createdAt: "2026-08-28T15:00:00.000Z" },

  // ── Writes. Nothing here writes anywhere; they exist so an accidental
  //    click during an interaction step does not throw a red toast into the
  //    measurement.
  markNotificationRead: ok,
  dismissAnnouncement: ok,
  dismissOnboarding: ok,

  // No Google key: every map draws with the Leaflet fallback, the only
  // basemap that can render behind the fence. a-map-is-paid-for-once.spec.ts
  // overrides this to drive the Google path against a fake.
  getMapsBrowserKey: { key: null },
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
  /** Bodies POSTed to /api/public/leads, the quote request's endpoint. It is
   *  a server ROUTE on the dev server, not a server function, so the fence
   *  would pass it through to a handler that writes to whichever database
   *  the dev server points at. Answered here instead, and kept. */
  leadPosts: unknown[];
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
/** A pay-screen intent re-priced for the tip choice it was sent, with the
 *  server's own function, so a sweep that taps 15% measures the total the
 *  product would draw rather than a number the fixture made up. */
function tippedIntent<T extends { dueCents: number }>(base: T, args: Record<string, any>) {
  const charge = tippedCharge({ dueCents: base.dueCents, choice: args?.tip, tipsEnabled: true });
  return { ...base, amountCents: charge.amountCents, tipCents: charge.tipCents };
}

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
  // The extra-cleanup card on Requests. Without this the card draws nothing
  // at all (it waits for its options), and the page measured is the page
  // without the one control this was added for.
  portalOneOffBookingOptions: pfx.PORTAL_ONE_OFF_OPTIONS,
  portalRequestOneOff: { ticketId: "22222222-0000-4000-8000-000000002005", alreadyAsked: false, bookedOn: null },
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
  // /pay/i/:token, which is not a portal page but arrives the same way -- in a
  // text -- and has no session either.
  getPublicInvoice: pfx.PUBLIC_INVOICE,
  // The pay link's intent, with tipping on, so the tip choices draw. Answers
  // a tip choice with the server's own arithmetic, so tapping 15% in a sweep
  // shows the same total production would.
  createPublicInvoicePaymentIntent: (a) => tippedIntent(pfx.PUBLIC_INVOICE_INTENT, a),
  portalCreateInvoicePaymentIntent: (a) => tippedIntent(pfx.PORTAL_INVOICE_INTENT, a),
  // /q/:token, the quote link. One fixture per state, keyed by the token in
  // the URL, because each state draws a different panel under the document.
  getPublicQuote: (a) => pfx.PUBLIC_QUOTES[a.token as string] ?? { found: false },
  // /track/:token, the live map. Keyed by token like the quote link: each
  // state draws a different page.
  getPublicTracking: (a) => pfx.PUBLIC_TRACKING[a.token as string] ?? { found: false },
  // /signup/:slug with first-cleanup tiers: the question in the service card,
  // and the quote priced for whichever answer the sweep picked.
  // Keyed by slug since the lead form and the signup became one page: the
  // same form for a business that sells online and one that only takes
  // quote requests. A ZIP outside every zone answers the way public_quote
  // does, with no row.
  getPublicSignupForm: (a) =>
    a.slug === pfx.QUOTE_ONLY_SLUG ? pfx.SIGNUP_FORM_QUOTE_ONLY : pfx.SIGNUP_FORM,
  getSignupQuote: (a) =>
    a.postal_code === pfx.NO_ZONE_ZIP
      ? { available: false }
      : pfx.signupQuote(a.last_cleaned as string | undefined),
  portalSelfServeOptions: {
    allow_self_reschedule: true,
    allow_vacation_hold: true,
    allow_frequency_change: true,
    reschedule_cutoff_hours: 24,
  },
};

export async function installStubBackend(
  context: BrowserContext,
  options: {
    role?: SweepRole;
    portal?: boolean;
    /** organizations.service_lines for this run. Omitted, the org is the
     *  pet-waste business BASE_STUBS describes. */
    serviceLines?: string[];
  } = {},
): Promise<StubReport> {
  const report: StubReport = { unstubbed: [], blockedHosts: [], leadPosts: [] };
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

  // A business that does not run pet waste: the same org, told so. The
  // features answer carries the lines, and the setup checklist asks the
  // end-of-day question instead of the dump site, as the server does.
  if (options.serviceLines && !options.portal) {
    const lines = options.serviceLines;
    STUBS.getMyOrgFeatures = {
      ...(BASE_STUBS.getMyOrgFeatures as Record<string, any>),
      serviceLines: lines,
    };
    const onboarding = BASE_STUBS.getOnboardingStatus as { steps: Array<{ id: string }> };
    STUBS.getOnboardingStatus = {
      ...onboarding,
      steps: onboarding.steps.map((st) =>
        st.id === "dump_site" && !lines.includes("pet_waste") ? { ...st, ...DAY_END_WORDING } : st,
      ),
    };
  }

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

  // The quote request. See `leadPosts` above.
  await context.route("**/api/public/leads", async (route) => {
    try {
      report.leadPosts.push(route.request().postDataJSON());
    } catch {
      report.leadPosts.push(route.request().postData());
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
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
