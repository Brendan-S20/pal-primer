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
// So this overlays names and numbers ONLY, by spreading the real fixture rows
// rather than rewriting them. Shapes stay identical, which matters more than
// it sounds: the dashboard fixture carries a comment about a day when
// overdueInvoices was handed back in the table's shape instead of the server
// function's, and every geometry rule passed over three blank links and
// "$NaN" for weeks.
//
// ── AND IT IS ALL INVENTED ───────────────────────────────────────────────
//
// No real business, no real customer, no real address. The names below are
// made up to look like a real book of work: a mix of households, one HOA, one
// commercial account.
import type { Page } from "@playwright/test";
import * as fx from "./dataset";

const ORG_NAME = "Brightside Pet Waste Removal";

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

/** Ordinary residential streets. Invented, and deliberately short: the point
 *  of the card is the customer and the time, not a line of truncated address. */
const STREETS = [
  "18 Cedar Lane",
  "204 Willow Court",
  "77 Birchwood Drive",
  "31 Ashfield Road",
  "145 Orchard Way",
  "9 Millbrook Lane",
  "52 Highview Terrace",
  "266 Fieldstone Drive",
];

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
];

// One name per person. Cycling a short list over seven staff put "Marcus
// Bell" in the map legend twice, in two different colours, which reads as a
// bug in the product rather than a shortage of names.
const staff = fx.STAFF.map((s, i) => ({ ...s, display_name: TECHS[i % TECHS.length] }));
if (new Set(staff.map((s) => s.display_name)).size !== staff.length) {
  throw new Error(
    `marketing fixture: ${staff.length} staff but only ${TECHS.length} names, so the map legend would repeat one`,
  );
}
const clients = fx.CLIENTS.map((c, i) => ({ ...c, display_name: CUSTOMERS[i % CUSTOMERS.length] }));

/** A good day, not a perfect one.
 *
 *  Zero of everything would be a screenshot of an empty product. One
 *  weather-flagged visit shows a feature working and reads as competence; three
 *  overdue invoices and a complaint read as a business in trouble. So: nothing
 *  unassigned, nothing overdue, one weather flag. */
function dashboard() {
  const visits = fx.visitsBetween(fx.TODAY, fx.TODAY);
  const counts: Record<string, number> = {
    total: visits.length,
    completed: Math.max(1, Math.floor(visits.length * 0.4)),
    skipped: 0,
    in_progress: 1,
    scheduled: Math.max(0, visits.length - Math.floor(visits.length * 0.4) - 1),
    cancelled: 0,
  };
  return {
    today: fx.TODAY,
    activeClients: 186,
    mtdRevenueCents: 2_144_000,
    mtdGrossCents: 2_144_000,
    mtdRefundsCents: 0,
    arOpenCents: 0,
    overdueCount: 0,
    visitCounts: counts,
    unassignedToday: 0,
    weatherFlaggedToday: 1,
    todayVisits: visits.map((v, i) => ({
      ...v,
      assigned_staff_id: v.assigned_staff_id ?? staff[i % staff.length].id,
    })),
    staff: staff
      .filter((s) => (s as any).is_field_tech !== false)
      .slice(0, 4)
      .map((s) => ({ id: s.id, display_name: s.display_name })),
    overdueInvoices: [],
    openConcerns: [],
  };
}

const OVERRIDES: Record<string, unknown | (() => unknown)> = {
  getMyOrg: { organization: { ...fx.ORGANIZATION, name: ORG_NAME } },
  getTrialState: {
    // The sweep pins this to "expired" on purpose, to measure the banner. A
    // paywall notice is not the opening image of a store listing.
    phase: "paid",
    daysRemaining: null,
    endsOn: null,
    restricted: false,
    canManageBilling: true,
  },
  getBillingBannerStatus: { planStatus: "active", role: "owner" },
  getDashboardSummary: dashboard(),
  listStaff: { staff },
  listMyDayFieldStaff: { staff },
  listClients: { clients, total: clients.length },
  getCollectedThisMonth: { grossCents: 2_144_000, refundsCents: 0, netCents: 2_144_000 },
  listInvoices: {
    invoices: fx.INVOICES.map((inv, i) => ({
      ...inv,
      status: "paid",
      clients: { ...(inv as any).clients, display_name: CUSTOMERS[i % CUSTOMERS.length] },
    })),
    total: fx.INVOICES.length,
  },
  listMyNotifications: { notifications: [], unread: 0 },
  // Every visit belongs to somebody. The dashboard said "0 unassigned" while
  // the map legend still showed an Unassigned lane, because they read from
  // different functions -- the sort of disagreement a buyer notices and a
  // layout sweep never would.
  listVisitsForDay: () => {
    const visits = fx.visitsBetween(fx.TODAY, fx.TODAY);
    return {
      visits: visits.map((v, i) => {
        const who = staff[i % 4];
        return {
          ...v,
          // Everybody has a name a person could have, and everybody has a
          // technician. The dashboard already said "0 unassigned" while the
          // board still drew an Unassigned lane, because the two read from
          // different functions.
          assigned_staff_id: who.id,
          staff: { display_name: who.display_name },
          clients: { display_name: CUSTOMERS[i % CUSTOMERS.length] },
          // Short, plausible, invented. The sweep's 4413 North Ravenswood
          // Manor Terrace Apartment 3B exists to be truncated; here it just
          // gets truncated, which looks like the product cannot show an
          // address.
          properties: {
            ...(v as any).properties,
            street: STREETS[i % STREETS.length],
            city: "Ridgefield",
            postal_code: "06877",
          },
          zones: { name: "North Ridgefield", postal_prefix: "068" },
          // No red. `window_violated` draws a "Late" chip and weather_flagged
          // draws a thunderstorm warning across the card, and a store listing
          // that leads with two alarms is selling anxiety.
          window_violated: false,
          weather_flagged: false,
          weather_note: null,
          status: i % 3 === 0 ? "completed" : "scheduled",
        };
      }),
    };
  },
};

/**
 * Overlay the marketing data.
 *
 * MUST be installed AFTER installStubBackend: Playwright matches handlers in
 * reverse order of registration, so the last one registered wins. Anything not
 * named here falls through to the sweep fixture, which is the point -- this
 * file only has to cover what a camera can see.
 */
export async function installMarketingData(page: Page): Promise<void> {
  await page.route("**/_serverFn/**", async (route) => {
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
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      // { result: ... } is the envelope a server function replies in. The bare
      // object gives the client undefined, React Query logs it and carries on,
      // and the page still renders -- so the screenshot still looks plausible.
      body: JSON.stringify({
        result: typeof OVERRIDES[name] === "function" ? (OVERRIDES[name] as () => unknown)() : OVERRIDES[name],
      }),
    });
  });
}
