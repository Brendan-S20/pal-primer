// The data the App Store sees.
//
// ── WHY THIS IS NOT THE SWEEP FIXTURE ────────────────────────────────────
//
// `dataset.ts` is deliberately awkward, and CLAUDE.md says why: "a fixture
// that is tidier than reality measures nothing". So it ships a 46-character
// client name, a 78-character signup URL, seven technicians, three overdue
// invoices and a complaint about the same corner being missed three weeks
// running. That is exactly right for finding layout faults.
//
// It is exactly wrong for a store listing. The first run of the screenshot
// harness starred Bartholomew Fitzgerald III and Rosalind Featherstonehaugh,
// and opened on three overdue invoices in red.
//
// So this overlays names and numbers, by spreading the real fixture rows
// rather than rewriting them, and every reply is in the shape the SERVER
// FUNCTION returns, not the shape the table stores or a shape that looks
// plausible. That matters more than it sounds. Until 2026-10-08 this file
// answered listInvoices as `{ invoices, total }`; the function returns a bare
// array, the page threw "all is not iterable", and the generator wrote the
// error boundary into 05-getting-paid.png at every size and reported 15
// passed. store-shots.ts now refuses a frame like that; the rule here is the
// one that stops it being written: before overriding a function, read what
// its `.handler` returns.
//
// ── A BUSINESS THAT IS RUNNING ───────────────────────────────────────────
//
// A store frame shows a business at work, not one being set up. So the setup
// checklist is complete and dismissed, every client has texting consent (no
// "coming soon" banner), nobody is overdue, nothing is weather-flagged, every
// stop is plausible (no red "re-optimize" banner), and the owner is not a
// platform admin (no HoundStack staff console in the menu). Each of those is a
// real state a real org reaches; none is a product change.
//
// ── AND IT IS ALL INVENTED ───────────────────────────────────────────────
//
// No real business, no real customer, no real address. The names below are
// made up to look like a real book of work: mostly households, one HOA, one
// kennel. Phone numbers are 555. Emails are left off rather than invented,
// because an invented address at a real domain may be somebody's.
import type { BrowserContext } from "@playwright/test";
import { BASE_STUBS, type SweepRole } from "./stub-backend";
import * as fx from "./dataset";
import { zonedTimeToUtc } from "../../../src/lib/route-window";

const ORG_NAME = "Brightside Pet Waste Removal";
const TZ = fx.ORGANIZATION.timezone;
const CITY = "Ridgefield";
const ZIP = "06877";
const ZONE = "North Ridgefield";

/** Short, ordinary, and varied. Long enough to be real, short enough that a
 *  phone frame does not truncate the one thing a buyer is looking at. */
const TECHS = [
  "Marcus Bell",
  "Dana Ortiz",
  "Sam Ruiz",
  "Priya Nair",
  "Tyler Hoang",
  "Renee Cabrera",
  "Owen Fitzgerald",
  "Leah Mbeki",
];

/** One per stop on the board, so no customer appears in two lanes. */
const CUSTOMERS = [
  "Jennifer Walsh",
  "The Alvarez Family",
  "Maple Ridge HOA",
  "Chris Bennett",
  "Danielle Park",
  "Nathan Cole",
  "Riverside Kennels",
  "Amy Foster",
  "The Nguyen Family",
  "Grant Whitaker",
  "Laura Kim",
  "Ben Okafor",
  "Megan Russo",
  "The Patel Family",
  "Kevin Doyle",
  "Sara Lindqvist",
  "Tom Hargrove",
  "Elena Morales",
  "Jason Reid",
  "Rachel Chu",
  "Mike Donnelly",
  "Hannah Brooks",
  "Luis Ferreira",
  "Olivia Grant",
];

/** Ordinary residential streets, invented. */
const STREETS = [
  "18 Cedar Lane",
  "204 Willow Court",
  "77 Birchwood Drive",
  "31 Ashfield Road",
  "145 Orchard Way",
  "9 Millbrook Lane",
  "52 Highview Terrace",
  "266 Fieldstone Drive",
  "40 Laurel Street",
  "118 Brookside Road",
  "6 Hawthorn Place",
  "93 Silver Hill Road",
  "27 Juniper Way",
  "310 Old Mill Road",
  "15 Ridgeview Court",
  "88 Spruce Street",
  "201 Meadow Lane",
  "64 Linden Avenue",
  "12 Fox Run",
  "57 Stony Brook Road",
  "130 Pine Hollow Drive",
  "3 Quarry Lane",
  "76 Elm Ridge Road",
  "245 Lakeside Drive",
];

/** The rest of the book, which the list's totals count and the frame mostly
 *  scrolls past. Four technicians running six stops a day is a book of well
 *  over a hundred; a list that said "24 total" beside that board would be a
 *  business that does not add up. Pairs are spread so no name repeats. */
const FIRST = ["Alex", "Brooke", "Carlos", "Dana", "Emily", "Frank", "Grace", "Henry", "Isabel", "Jack", "Kara", "Liam"];
const LAST = ["Adams", "Baker", "Carter", "Diaz", "Ellis", "Flynn", "Greene", "Hughes", "Irwin", "Jensen", "Keller", "Lopez"];
const MORE_CUSTOMERS = Array.from({ length: 108 }, (_, n) => {
  const f = n % FIRST.length;
  const l = (f + Math.floor(n / FIRST.length) + 1) % LAST.length;
  return `${FIRST[f]} ${LAST[l]}`;
});
const BOOK = [...CUSTOMERS, ...MORE_CUSTOMERS];
if (new Set(BOOK).size !== BOOK.length) throw new Error("marketing fixture: a client name repeats");

/** The visit checklist, in the column's shape ({id, label, required}). The
 *  sweep's has a 120-character label and a word with no break in it, which is
 *  right for a layout test and reads as a bug on an iPad frame. */
const CHECKLIST = [
  { id: "c7a1e0de-0000-4000-8000-0000000000a1", label: "Whole yard walked", required: true },
  { id: "c7a1e0de-0000-4000-8000-0000000000a2", label: "Waste bagged and in the bin", required: true },
  { id: "c7a1e0de-0000-4000-8000-0000000000a3", label: "Gate latched behind me", required: true },
];

const DOGS = ["Biscuit", "Luna", "Cooper", "Daisy", "Max", "Rosie", "Bear", "Penny"];

// One name per person. Cycling a short list over seven staff put "Marcus
// Bell" in the map legend twice, in two different colours, which reads as a
// bug in the product rather than a shortage of names.
const staff = fx.STAFF.map((s, i) => ({ ...s, display_name: TECHS[i % TECHS.length] }));
if (new Set(staff.map((s) => s.display_name)).size !== staff.length) {
  throw new Error(
    `marketing fixture: ${staff.length} staff but only ${TECHS.length} names, so the map legend would repeat one`,
  );
}
const ME = staff[0]; // the technician My Day is shot as, and the owner's own name
const ROUND_TECHS = staff.filter((s) => s.is_field_tech).slice(0, 4);

/** The book: every stop on the board is somebody on the list (CUSTOMERS come
 *  first), and everyone is paid up, as the invoices frame also says. */
const clients = BOOK.map((name, i) => ({
  ...fx.CLIENTS[i % fx.CLIENTS.length],
  id:
    i < fx.CLIENTS.length
      ? fx.CLIENTS[i].id
      : `bbbbbbbb-0000-4000-8000-0000000b${String(i).padStart(4, "0")}`,
  display_name: name,
  account_type: name === "Riverside Kennels" ? "commercial" : "residential",
  primary_email: null,
  // Ridgefield is in 203; the sweep's numbers are Chicago's 312.
  primary_phone: `+1 (203) 555-${String(1040 + i * 3)}`,
  active: true,
  credit_balance_cents: 0,
  churn_score: 0.08,
  comms_paused: false,
  dog_count: (i % 2) + 1,
  active_subscription_count: 1,
  frequencies: [i % 3 === 2 ? "twice_weekly" : "weekly"],
  outstanding_cents: 0,
  tags: i % 3 === 0 ? ["Weekly"] : [],
}));

function at(hhmm: string) {
  return zonedTimeToUtc(fx.TODAY, hhmm, TZ).toISOString();
}
function clock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

const STOPS_PER_TECH = 6;

/** Today's round: four technicians, six stops each, every stop owned.
 *
 *  Plausible on purpose. The sweep's dataset carries a 45-minute drive that
 *  claims to arrive at 07:35, so the board draws a red "implausible stops,
 *  re-optimize" banner, which is right for a layout sweep and wrong for the
 *  frame that sells routing. Here each stop is 40 minutes after the last with
 *  a 6-14 minute drive, which the route-warning check accepts.
 *
 *  The first two stops in each lane are done and the third is in progress
 *  (except on My Day's own lane, see below): a day under way, which is what
 *  makes the progress pill say something. */
function round() {
  const template = fx.visitsBetween(fx.TODAY, fx.TODAY);
  return ROUND_TECHS.flatMap((who, t) =>
    Array.from({ length: STOPS_PER_TECH }, (_, k) => {
      const n = t * STOPS_PER_TECH + k;
      const v = template[n % template.length] as Record<string, any>;
      const start = 8 * 60 + k * 40;
      return {
        ...v,
        id: `eeeeeeee-0000-4000-8000-9000000000${String(n).padStart(2, "0")}`,
        client_id: clients[n % clients.length].id,
        sequence: k + 1,
        // The technician My Day is shot as is between stops, so the bar on
        // the tab bar reads NEXT UP; the others are mid-yard.
        status: k < 2 ? "completed" : k === 2 && who !== ME ? "in_progress" : "scheduled",
        assigned_staff_id: who.id,
        staff: { display_name: who.display_name },
        eta_start: at(clock(start)),
        eta_end: at(clock(start + 30)),
        travel_km: 2.1 + ((n * 7) % 9) / 2,
        travel_min: 6 + ((n * 5) % 9),
        window_violated: false,
        weather_flagged: false,
        weather_note: null,
        clients: { display_name: CUSTOMERS[n] },
        properties: {
          ...v.properties,
          street: STREETS[n],
          city: CITY,
          postal_code: ZIP,
        },
        zones: { name: ZONE, postal_prefix: "068" },
      };
    }),
  );
}

/** A good day, not a perfect one. Not in a frame since My Day replaced the
 *  dashboard in slot one, but kept true to the round above so nothing that
 *  reads it disagrees with the board. */
function dashboard() {
  const visits = round();
  const count = (s: string) => visits.filter((v) => v.status === s).length;
  return {
    today: fx.TODAY,
    activeClients: clients.length,
    mtdRevenueCents: 1_248_000,
    mtdGrossCents: 1_248_000,
    mtdRefundsCents: 0,
    arOpenCents: 0,
    overdueCount: 0,
    visitCounts: {
      total: visits.length,
      completed: count("completed"),
      skipped: 0,
      in_progress: count("in_progress"),
      scheduled: count("scheduled"),
      cancelled: 0,
    },
    unassignedToday: 0,
    weatherFlaggedToday: 0,
    todayVisits: visits,
    staff: ROUND_TECHS.map((s) => ({ id: s.id, display_name: s.display_name })),
    overdueInvoices: [],
    openConcerns: [],
  };
}

/** My Day, in getMyDay's shape: the base stub's third stop (a plain
 *  residential yard, no stations, no six named dogs) as the template, given
 *  the technician's own lane from the round above, so My Day and the board
 *  agree about who is where. */
function myDay() {
  const base = (BASE_STUBS.getMyDay as () => any)();
  const template = base.visits[base.visits.length - 1] ?? base.visits[0];
  const mine = round().filter((v) => v.assigned_staff_id === ME.id);
  const startedAt = new Date(Date.now() - 9 * 60_000).toISOString();
  const visits = mine.map((v, i) => ({
    ...template,
    ...v,
    organization_id: fx.ORG_ID,
    started_at: v.status === "in_progress" ? startedAt : null,
    completed_at: v.status === "completed" ? v.eta_end : null,
    skip_reason: null,
    skip_reason_code: null,
    stop_facts: {
      dogCount: (i % 2) + 1,
      autopay: true,
      cardOnFile: true,
      paysCashCheck: false,
      openBalanceCents: 0,
      awaitingCents: 0,
    },
    clients: {
      display_name: v.clients.display_name,
      primary_phone: `+1 (203) 555-01${String(20 + i)}`,
      dna_compliance_enabled: false,
    },
    properties: {
      ...template.properties,
      ...v.properties,
      account_type: "residential",
      has_units: false,
      gate_code: i % 2 === 0 ? "1428" : null,
      lock_box_code: null,
      key_location: null,
      parking_notes: null,
      access_notes: i % 2 === 0 ? "Side gate on the left" : null,
      escape_risk: false,
      dog_in_yard_during_service: false,
      aggressive_dog: false,
      hazard_notes: null,
      dogs: DOGS.slice(i % DOGS.length, (i % DOGS.length) + (i % 2) + 1).map((name) => ({
        name,
        temperament: "friendly",
      })),
      boundary: null,
      boundary_area_sqm: null,
      waste_stations: [],
    },
    zones: { name: ZONE },
    visit_photos: [],
  }));
  return { staff: { ...base.staff, display_name: ME.display_name }, visits, previewing: false };
}

/** A week of weekly service, or of twice-weekly for every third client. */
const PRICE = (i: number) => (i % 3 === 2 ? 3_000 : 1_800);

/** Every invoice paid. An open balance draws the Outstanding card in red
 *  (correctly: it is money not yet in), and a listing that leads the money
 *  frame with a red number is selling a collections problem. */
const invoices = () =>
  clients.map((c, i) => {
    // Spread over the last three weeks, newest first, each billing the week
    // before it was issued.
    const issued = new Date(Date.now() - (1 + Math.floor(i / 6)) * 864e5);
    const periodEnd = new Date(issued.getTime() - 864e5);
    const periodStart = new Date(periodEnd.getTime() - 6 * 864e5);
    return {
      ...(fx.INVOICES[i % fx.INVOICES.length] as Record<string, any>),
      id: `99999999-0000-4000-8000-0000000f${String(i + 1).padStart(4, "0")}`,
      number: 2160 - i,
      client_id: c.id,
      status: "paid",
      kind: "service",
      subtotal_cents: PRICE(i),
      total_cents: PRICE(i),
      credit_applied_cents: 0,
      amount_paid_cents: PRICE(i),
      currency: "usd",
      period_start: periodStart.toISOString().slice(0, 10),
      period_end: periodEnd.toISOString().slice(0, 10),
      issued_at: issued.toISOString(),
      due_on: new Date(issued.getTime() + 14 * 864e5).toISOString().slice(0, 10),
      paid_at: new Date(issued.getTime() + 864e5).toISOString(),
      sent_at: issued.toISOString(),
      clients: { display_name: c.display_name },
    };
  });

function overrides(role: SweepRole): Record<string, unknown | (() => unknown)> {
  return {
    getMyOrg: {
      organization: { ...fx.ORGANIZATION, name: ORG_NAME, role, visit_checklist: CHECKLIST },
    },
    getMyOrgFeatures: {
      ...(BASE_STUBS.getMyOrgFeatures as Record<string, any>),
      visitChecklist: CHECKLIST,
    },
    getPlatformContext: { isPlatformAdmin: false },
    getMyProfile: {
      ...(BASE_STUBS.getMyProfile as Record<string, any>),
      staff: {
        ...(BASE_STUBS.getMyProfile as any).staff,
        id: ME.id,
        display_name: ME.display_name,
        role,
        phone: "+1 (203) 555-0100",
      },
      authEmail: "marcus@brightsidepets.example",
    },
    getTrialState: {
      // The sweep pins this to "expired" on purpose, to measure the banner. A
      // paywall notice is not the opening image of a store listing.
      phase: "paid",
      daysRemaining: null,
      endsOn: null,
      restricted: false,
      canManageBilling: true,
    },
    getBillingBannerStatus: { planStatus: "active", role },
    // Set up, and the card put away: every step done AND dismissed, which is
    // the state a running org is in. The component returns null for it.
    getOnboardingStatus: {
      ...(BASE_STUBS.getOnboardingStatus as Record<string, any>),
      steps: (BASE_STUBS.getOnboardingStatus as any).steps.map((s: object) => ({ ...s, done: true })),
      completed: (BASE_STUBS.getOnboardingStatus as any).total,
      dismissed: true,
    },
    // Everyone with a phone has said yes to texts, so the consent-gap banner
    // (which mentions a feature that is still coming) has nothing to say.
    getSmsConsentCoverage: { withPhone: 172, consented: 172, optedOut: 0 },
    getDashboardSummary: dashboard,
    // The four on today's round and the office. The sweep's seventh person
    // has no stops, and on the board an idle technician is an empty lane.
    listStaff: { staff: staff.filter((s) => ROUND_TECHS.includes(s) || !s.is_field_tech) },
    listMyDayFieldStaff: {
      staff: staff.map((s) => ({ id: s.id, display_name: s.display_name, role: s.role })),
    },
    listClients: { clients },
    // CollectedSummary (src/lib/revenue.server.ts), counts included: without
    // paymentCount the card reads "$12,480.00 / 0 payments received".
    getCollectedThisMonth: {
      grossCents: 1_248_000,
      refundsCents: 0,
      netCents: 1_248_000,
      paymentCount: 548,
      reversalCount: 0,
    },
    // A bare ARRAY, because that is what listInvoices' handler returns
    // (src/lib/invoices.functions.ts). See the top of this file.
    listInvoices: invoices,
    listMyNotifications: { notifications: [], unread: 0 },
    // The sidebar's red dot on Review. Nothing waiting, in a frame.
    getReviewQueueCount: { openCount: 0 },
    // Nothing waiting at the door: the sweep's one check, from the sweep's
    // business, would otherwise fill the whole money frame above the list.
    listFieldCollections: { collections: [] },
    // Every visit belongs to somebody. The dashboard said "0 unassigned" while
    // the board still drew an Unassigned lane, because they read from
    // different functions -- the sort of disagreement a buyer notices and a
    // layout sweep never would.
    listVisitsForDay: () => ({ visits: round() }),
    getMyDay: myDay,
    // On the clock since a little before the first stop, one shift, no
    // offline replay: a normal morning, with nothing to prompt about.
    getMyClock: {
      ...fx.MY_CLOCK,
      staff: { id: ME.id, display_name: ME.display_name },
      entries: [
        {
          ...fx.MY_CLOCK.entries[1],
          clock_in: new Date(Date.now() - 2.5 * 3600_000).toISOString(),
          clock_out: null,
          clock_in_source: "tech_live",
        },
      ],
    },
    getMyUpcomingDays: {
      staff: { id: ME.id, organization_id: fx.ORG_ID, display_name: ME.display_name },
      days: [1, 2, 3, 4].map((d) => ({
        date: fx.day(d),
        stops: 6,
        done: 0,
        zones: [ZONE],
        firstEta: zonedTimeToUtc(fx.day(d), "08:00", TZ).toISOString(),
        lastEta: zonedTimeToUtc(fx.day(d), "11:20", TZ).toISOString(),
      })),
    },
  };
}

/**
 * Overlay the marketing data.
 *
 * MUST be installed AFTER installStubBackend: Playwright matches handlers in
 * reverse order of registration, so the last one registered wins. Anything not
 * named here falls through to the sweep fixture, which is the point -- this
 * file only has to cover what a camera can see. store-shots.ts fails a frame
 * whose page still carries a name from the sweep's dataset, which is how a
 * function that needs adding here announces itself.
 */
export async function installMarketingData(
  context: BrowserContext,
  options: { role?: SweepRole } = {},
): Promise<void> {
  const OVERRIDES = overrides(options.role ?? "owner");
  await context.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = String(
        JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
      ).replace(/_createServerFn_handler$/, "");
    } catch {
      /* unreadable id: let the fixture answer */
    }
    if (!(name in OVERRIDES)) return route.fallback();
    const reply = OVERRIDES[name];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      // { result: ... } is the envelope a server function replies in. The bare
      // object gives the client undefined, React Query logs it and carries on,
      // and the page still renders -- so the screenshot still looks plausible.
      body: JSON.stringify({
        result: typeof reply === "function" ? (reply as () => unknown)() : reply,
      }),
    });
  });
}
