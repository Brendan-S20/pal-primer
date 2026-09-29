/**
 * One tenant, chosen to be awkward.
 *
 * ── WHY THE VALUES LOOK LIKE THIS ─────────────────────────────────────────
 *
 * A fixture is a chance the production database does not give you: the data is
 * picked. `docs/mobile-ux-audit.md` says where this app breaks — long names in
 * flex rows, a `w-80` popover on a 360px phone, a nine-tab strip, a signup URL
 * with nowhere to wrap — so the rows below carry exactly those shapes:
 *
 *   * a 46-character business name and client names with hyphenated surnames,
 *     because "Text truncates instead of widening its row" is only testable
 *     against text that would widen the row;
 *   * a 78-character signup URL and a Stripe id, because CLAUDE.md names "a
 *     value with no space in it — an address, a link, an id" as the fault the
 *     static tests cannot see and a browser can;
 *   * seven techs and thirty-odd visits, because "dense grids reflow, they do
 *     not shrink" is a statement about a grid with something in it;
 *   * an audit trail whose before/after JSON is wide, because the tenant
 *     diff view added today renders it as `<pre>`.
 *
 * None of it is anybody's real data and none of it needs to be: the sweep
 * measures boxes.
 */

import { zonedTimeToUtc } from "../../../src/lib/route-window";

export const ORG_ID = "aaaaaaaa-0000-4000-8000-00000000a001";
export const TENANT_B_ID = "aaaaaaaa-0000-4000-8000-00000000a002";
export const CLIENT_ID = "bbbbbbbb-0000-4000-8000-00000000b001";
export const PROPERTY_ID = "cccccccc-0000-4000-8000-00000000c001";

/** Long on purpose. 46 characters, no obvious break point past "Waste". */
export const ORG_NAME = "Whitfield-Ramirez Yard & Waste Services LLC";

/** The value CLAUDE.md uses as its example of a fault only a browser sees. */
export const SIGNUP_URL =
  "https://app.houndstack.com/signup/whitfield-ramirez-yard-and-waste-services-llc";

const iso = (d: Date) => d.toISOString();
/** A date `offset` days from today, org-local, as YYYY-MM-DD. Exported since
 *  2026-09-14 so a fixture can place a day AFTER today without recomputing the
 *  arithmetic and drifting from TODAY. */
export const day = (offset: number) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

export const TODAY = day(0);

export const VISIT_CHECKLIST = [
  { id: "c7a1e0de-0000-4000-8000-000000000001", label: "All areas walked", required: true },
  {
    id: "c7a1e0de-0000-4000-8000-000000000002",
    // 120 characters: the longest label visit_checklist_is_valid accepts.
    label:
      "Waste bagged, tied off and dropped in the customer's green bin by the garage, never the grey recycling tote on the road.",
    required: true,
  },
  {
    id: "c7a1e0de-0000-4000-8000-000000000003",
    // No space and no hyphen: nothing a browser may break at on its own.
    label: "Gate latched: SIDEGATECARABINERCLIPPEDTHROUGHTHECHAINLINKFENCE",
    required: true,
  },
  { id: "c7a1e0de-0000-4000-8000-000000000004", label: "Water bowl checked", required: false },
];

export const ORGANIZATION = {
  id: ORG_ID,
  name: ORG_NAME,
  portal_slug: "whitfield-ramirez-yard-and-waste-services",
  timezone: "America/Chicago",
  active_client_count: 214,
  billing_tier: "pro",
  plan_status: "active",
  billing_status: "active",
  current_period_end: iso(new Date(Date.now() + 12 * 864e5)),
  stripe_customer_id: "cus_QxT7HkPmZ3vLd8RaFn2Wq0",
  stripe_subscription_id: "sub_1QxT7HkPmZ3vLd8RaFn2Wq0Bs",
  require_completion_photo: true,
  // The visit checklist, in the column's own shape ({id, label, required}),
  // because My Day reads it through parseChecklist and an item of any other
  // shape is dropped: a fixture that got the shape wrong would draw no
  // checklist and the sweep would measure a card without one, green.
  // `tests/a-checklist-the-sweep-can-see.test.ts` runs it through that parser.
  //
  // Awkward on purpose. One label is as long as the database allows a label
  // to be, and one contains a word with no break in it, because at 320px the
  // question is whether the row wraps inside the card or widens the page.
  visit_checklist: VISIT_CHECKLIST,
  role: "owner",
};

export const STAFF = [
  {
    id: "dddddddd-0000-4000-8000-00000000d001",
    display_name: "Alejandro Villanueva-Castro",
    role: "tech",
  },
  { id: "dddddddd-0000-4000-8000-00000000d002", display_name: "Samantha Okonkwo", role: "tech" },
  {
    id: "dddddddd-0000-4000-8000-00000000d003",
    display_name: "Bartholomew Fitzgerald III",
    role: "tech",
  },
  { id: "dddddddd-0000-4000-8000-00000000d004", display_name: "Wen Zhang", role: "tech" },
  {
    id: "dddddddd-0000-4000-8000-00000000d005",
    display_name: "Priyanka Balasubramanian",
    role: "tech",
  },
  { id: "dddddddd-0000-4000-8000-00000000d006", display_name: "Kai Ortiz", role: "dispatcher" },
  {
    id: "dddddddd-0000-4000-8000-00000000d007",
    display_name: "Marguerite Delacroix-Bennett",
    role: "tech",
  },
].map((s, i) => ({
  ...s,
  active: true,
  is_field_tech: s.role === "tech",
  routing_available: true,
  start_latitude: 41.88 + i * 0.01,
  start_longitude: -87.63 - i * 0.01,
  start_address: `${1200 + i * 37} West Fullerton Parkway, Chicago, IL 60614`,
  end_latitude: null,
  end_longitude: null,
  end_address: null,
}));

const CLIENT_NAMES = [
  "Anastasia Vandermolen-Whitaker",
  "Chesterfield Property Management Group",
  "Bo Ng",
  "Rosalind Featherstonehaugh",
  "Northbrook Homeowners Association #4471",
  "Jean-Baptiste Moreau-Lachapelle",
  "Tim Cox",
  "Kimberly-Anne Rutherford-Sinclair",
  "Devonshire Estates Commercial Grounds",
  "Yusuf Abdulrahman-Osei",
  "Meredith Ashworth",
  "Constantine Papadopoulos-Andreou",
];

export const CLIENTS = CLIENT_NAMES.map((name, i) => ({
  id: i === 0 ? CLIENT_ID : `bbbbbbbb-0000-4000-8000-00000000b0${String(i + 1).padStart(2, "0")}`,
  display_name: name,
  account_type: i % 4 === 1 ? "commercial" : "residential",
  primary_email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@longishmailprovider.example.com`,
  primary_phone: `+1 (312) 555-${String(1000 + i * 7).slice(0, 4)}`,
  active: i !== 6,
  created_at: iso(new Date(Date.now() - (i + 1) * 9 * 864e5)),
  credit_balance_cents: i % 5 === 0 ? 4250 : 0,
  churn_score: i % 3 === 0 ? 0.72 : 0.11,
  comms_paused: i === 3,
  dog_count: (i % 3) + 1,
  active_subscription_count: i % 4 === 3 ? 0 : 1,
  frequencies: i % 4 === 3 ? [] : [["weekly", "twice_weekly", "bi_weekly", "monthly"][i % 4]],
  outstanding_cents: i % 3 === 0 ? 18_500 + i * 325 : 0,
  // Tags as a Jobber export brings them: a cadence, a day, and one long enough
  // to test the filter's width.
  tags: i % 2 === 0 ? ["Weekly", "Tuesday", "Lakeview Terrace Condominium Association"] : ["VIP"],
}));

export const PROPERTIES = CLIENTS.map((c, i) => ({
  id: i === 0 ? PROPERTY_ID : `cccccccc-0000-4000-8000-00000000c0${String(i + 1).padStart(2, "0")}`,
  client_id: c.id,
  street: `${4400 + i * 13} North Ravenswood Manor Terrace Apartment ${i + 2}B`,
  city: "Chicago",
  region: "IL",
  postal_code: `606${String(10 + i).slice(0, 2)}`,
  latitude: 41.9 + i * 0.006,
  longitude: -87.68 + i * 0.005,
  earliest_service_time: "08:00",
  latest_service_time: "17:00",
  service_duration_min: 15,
  archived_at: null,
}));

const STATUSES = ["scheduled", "completed", "in_progress", "skipped", "scheduled", "completed"];

/** Visits for `from`..`to` inclusive, spread over the techs. */
export function visitsBetween(from: string, to: string) {
  const out: Array<Record<string, unknown>> = [];
  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const on = d.toISOString().slice(0, 10);
    const perDay = 8;
    for (let i = 0; i < perDay; i++, n++) {
      const client = CLIENTS[n % CLIENTS.length];
      const property = PROPERTIES[n % PROPERTIES.length];
      // Every fourth stop is unassigned: the board draws an "Unassigned" lane
      // for those, which is a column that only exists when the data has one.
      const tech = i % 4 === 3 ? null : STAFF[n % 5];
      // ── ONE DELIBERATELY IMPLAUSIBLE STOP PER SHORT-NAMED CLIENT ──────
      //
      // A 45-minute drive that claims to arrive at 07:35 — five minutes after
      // the workday the optimizer starts from. `findRouteWarnings` flags an
      // ETA its own drive figure cannot produce, and the board then draws a
      // banner listing them.
      //
      // Here on purpose, and load-bearing twice over. That banner is the one
      // place `/routes` renders a control that is a whole SENTENCE, and on
      // 2026-09-13 two of those buttons measured 32px tall on a phone.
      //
      // SHORT-named on purpose, and this is the part worth not rediscovering:
      // the control's height is its message wrapped, so "Anastasia
      // Vandermolen-Whitaker: arrival time is earlier than…" runs to three
      // lines at 360px and clears the 44px floor by accident. "Bo Ng: …" runs
      // to two and does not. An earlier draft picked the stop by index, got
      // the long name, and measured nothing.
      //
      // The times are fixed rather than derived from `i`, because the ordinary
      // ETA below climbs with the stop number and a warning that depends on
      // that is a warning that quietly stops happening when the day shifts.
      const implausible = (client.display_name || "").length <= 8;
      const etaFrom = implausible ? "07:35" : `${String(8 + (i % 8)).padStart(2, "0")}:15`;
      const etaTo = implausible ? "08:05" : `${String(8 + (i % 8)).padStart(2, "0")}:45`;
      out.push({
        id: `eeeeeeee-0000-4000-8000-${String(100000000000 + n).slice(0, 12)}`,
        scheduled_on: on,
        status: STATUSES[n % STATUSES.length],
        sequence: i + 1,
        assigned_staff_id: tech?.id ?? null,
        zone_id: null,
        property_id: property.id,
        client_id: client.id,
        subscription_id: `ffffffff-0000-4000-8000-${String(200000000000 + n).slice(0, 12)}`,
        // `visits.eta_start` and `visits.eta_end` are `timestamp with time zone`
        // in the database. This fixture emitted bare clock strings ("08:15:00")
        // until 2026-09-13, and every consumer in `src/` reads them through
        // `new Date(...)` — ScheduleCalendar, MobileDayList, VisitDetailDrawer,
        // the client Visits tab, the customer portal and My Day's own ETA label.
        // `new Date("08:15:00")` is Invalid Date, so each of those rendered its
        // empty branch and the sweep measured, at four widths and twenty
        // surfaces, a label that production always draws and this dataset never
        // did. A fixture that is tidier than reality measures nothing; one that
        // is the WRONG SHAPE measures the fallback.
        // A REAL INSTANT, derived from the fixture org's own timezone — the
        // exact expression the optimizer uses (route-window.ts's
        // zonedTimeToUtc mirrors the SQL `AT TIME ZONE org.timezone`). Until
        // 2026-09-19 these were local-naive strings ("…T08:15:00", no Z),
        // which rendered as the intended wall clock only because the browser
        // zone pinned in playwright.config.ts happens to equal
        // ORGANIZATION.timezone. The renderers now format on the ORG's clock,
        // so a naive string would keep the sweep green by coincidence and let
        // it go silently wrong the day either zone changes. An instant built
        // from the org's zone renders 08:15 whatever the device is set to —
        // which is now also true of production.
        eta_start: zonedTimeToUtc(on, etaFrom, ORGANIZATION.timezone).toISOString(),
        eta_end: zonedTimeToUtc(on, etaTo, ORGANIZATION.timezone).toISOString(),
        travel_km: 3.4 + (n % 7),
        travel_min: implausible ? 45 : 9 + (n % 13),
        window_violated: n % 11 === 0,
        weather_flagged: n % 9 === 0,
        weather_note:
          n % 9 === 0 ? "Thunderstorms forecast between 13:00 and 16:00 — heavy rain" : null,
        clients: { display_name: client.display_name },
        properties: {
          street: property.street,
          city: property.city,
          postal_code: property.postal_code,
          latitude: property.latitude,
          longitude: property.longitude,
          earliest_service_time: property.earliest_service_time,
          latest_service_time: property.latest_service_time,
          service_duration_min: property.service_duration_min,
        },
        zones: { name: "Ravenswood Manor / Lincoln Square North", postal_prefix: "606" },
        staff: tech ? { display_name: tech.display_name } : null,
        subscriptions: {
          price_cents: 2200 + (n % 5) * 150,
          account_type: client.account_type,
          frequency: "weekly",
          preferred_time_of_day: "morning",
          earliest_time: "08:00",
          latest_time: "12:00",
        },
      });
    }
  }
  return out;
}

export const INVOICES = CLIENTS.slice(0, 8).map((c, i) => ({
  id: `99999999-0000-4000-8000-00000000e0${String(i + 1).padStart(2, "0")}`,
  number: 10420 + i,
  status: i % 3 === 0 ? "open" : i % 3 === 1 ? "paid" : "void",
  total_cents: 8_800 + i * 1_275,
  credit_applied_cents: i === 2 ? 2_000 : 0,
  amount_paid_cents: i % 3 === 1 ? 8_800 + i * 1_275 : 0,
  due_on: day(-3 + i),
  issued_at: iso(new Date(Date.now() - (i + 4) * 864e5)),
  client_id: c.id,
  clients: { display_name: c.display_name },
  number: `INV-2026-${String(1041 + i)}`,
}));

/**
 * /invoices/:id, and the Refund dialog on it. Added 2026-09-28 with refunding
 * from the invoice, which is the first control on this page a phone owner has
 * a reason to press in a driveway.
 *
 * Awkward on purpose, three ways: the longest commercial client name, so the
 * confirm step's "Send $X back to <name>?" has to wrap; a SURCHARGED card
 * payment that has been PARTLY refunded, so the row draws the charged total,
 * the service/card-fee split, the refunded line and the Refund button in one
 * cell; and a check with a long reference beside it, which must NOT get a
 * Refund button, so a surface that drew one on every row would show it.
 */
export const REFUND_INVOICE_ID = "99999999-0000-4000-8000-00000000e0a1";
export const REFUND_CLIENT_NAME = "Northbrook Homeowners Association #4471";
export const REFUND_CARD_PAYMENT_ID = "77777777-0000-4000-8000-0000000077a1";
const REFUND_INVOICE_ROW = {
  id: REFUND_INVOICE_ID,
  organization_id: ORG_ID,
  number: 10477,
  client_id: CLIENTS[4].id,
  status: "paid",
  kind: "service",
  currency: "usd",
  subtotal_cents: 24_000,
  total_cents: 24_000,
  credit_applied_cents: 0,
  period_start: day(-30),
  period_end: day(-1),
  issued_at: iso(new Date(Date.now() - 9 * 864e5)),
  paid_at: iso(new Date(Date.now() - 6 * 864e5)),
  due_on: day(5),
  send_after: null,
  sent_at: iso(new Date(Date.now() - 9 * 864e5)),
  public_token: null,
  voided_at: null,
  notes: null,
  checkout_url: null,
  created_at: iso(new Date(Date.now() - 9 * 864e5)),
  accounting_remote_id: null,
  stripe_checkout_session_id: null,
  stripe_payment_intent_id: "pi_3QxT7HkPmZ3vLd8RaFn2Wq0Bs",
};
export const REFUND_INVOICE_PAYMENTS = [
  {
    id: REFUND_CARD_PAYMENT_ID,
    amount_cents: 16_000,
    surcharge_cents: 480,
    // A tip as well as a surcharge, so the amount cell draws its longest
    // breakdown ("service + card fee + tip") AND the "Tip credited to" line
    // under it, with the 46-character name in it. Without a tip neither line
    // exists and the cell measured is the short one.
    tip_cents: 2_400,
    tip_staff_id: "dddddddd-0000-4000-8000-00000000d008",
    tip_staff_name: "Maximilian Alexander Fitzgerald-Worthington II",
    // `refunded` after the first partial: the webhook's own behaviour, and
    // exactly the row the Refund button must still appear on.
    status: "refunded",
    stripe_payment_intent_id: "pi_3QxT7HkPmZ3vLd8RaFn2Wq0Bs",
    paid_at: iso(new Date(Date.now() - 6 * 864e5)),
    created_at: iso(new Date(Date.now() - 6 * 864e5)),
    method: null,
    reference: null,
    refunded_cents: 4_120,
  },
  {
    id: "77777777-0000-4000-8000-0000000077a2",
    amount_cents: 8_000,
    surcharge_cents: 0,
    tip_cents: 0,
    tip_staff_id: null,
    tip_staff_name: null,
    status: "succeeded",
    stripe_payment_intent_id: null,
    paid_at: iso(new Date(Date.now() - 7 * 864e5)),
    created_at: iso(new Date(Date.now() - 7 * 864e5)),
    method: "check",
    reference: "HOA-OPERATING-ACCT-000418822-CHK-10477",
    refunded_cents: 0,
  },
];
export const REFUND_INVOICE = {
  invoice: {
    ...REFUND_INVOICE_ROW,
    clients: {
      display_name: REFUND_CLIENT_NAME,
      primary_email: CLIENTS[4].primary_email,
    },
  },
  items: [
    {
      id: "66666666-0000-4000-8000-0000000066a1",
      description: "Weekly yard service, 4 visits (commons, dog run and both retention ponds)",
      amount_cents: 24_000,
      visit_id: null,
      subscription_id: null,
    },
  ],
  payments: REFUND_INVOICE_PAYMENTS,
};
/** What Stripe would say about the card payment: $188.80 charged ($160
 *  service + $4.80 card fee + $24.00 tip), $41.20 back. The confirm step
 *  therefore draws both the card-fee line and the tip line. */
export const REFUND_QUOTE = {
  paymentId: REFUND_CARD_PAYMENT_ID,
  invoiceId: REFUND_INVOICE_ID,
  currency: "usd",
  chargedCents: 18_880,
  surchargeCents: 480,
  tipCents: 2_400,
  refundedCents: 4_120,
  refundableCents: 14_760,
};

/** /leads, and the new-client wizard started from one of them. One lead in
 *  each conversion state the page draws differently: convertible (Convert to
 *  client), converted and linked (Open client), converted by hand with no
 *  client (a line of text instead of either). The first is the awkward one on
 *  purpose: a 46-character name, an address with no space in it to break at,
 *  and a message long enough to wrap several times at 360px. */
export const LEAD_ID = "12121212-0000-4000-8000-000000001201";
export const LEAD_NAME = "Maximilian Oyelaran-Castellanos de la Fuente";
export const LEADS = [
  {
    id: LEAD_ID,
    organization_id: ORG_ID,
    created_at: iso(new Date(Date.now() - 2 * 3_600_000)),
    updated_at: iso(new Date(Date.now() - 2 * 3_600_000)),
    name: LEAD_NAME,
    email: "maximilian.oyelaran-castellanos.delafuente@longishmailprovider.example.com",
    phone: "+13125550199",
    company: null,
    location: "4417 North Ravenswood Avenue, Chicago, IL 60640",
    dog_count: 3,
    frequency: "weekly",
    message:
      "Three rescue dogs (two shepherd mixes and a very large Great Pyrenees) and a long side yard that runs down to the alley. Gate code is on the side door. Would like Thursdays if possible.",
    source: "website",
    status: "new",
    contacted_at: null,
    converted_at: null,
    converted_client_id: null,
  },
  {
    id: "12121212-0000-4000-8000-000000001202",
    organization_id: ORG_ID,
    created_at: iso(new Date(Date.now() - 6 * 864e5)),
    updated_at: iso(new Date(Date.now() - 3 * 864e5)),
    name: CLIENT_NAMES[0],
    email: CLIENTS[0].primary_email,
    phone: null,
    company: null,
    location: "60614",
    dog_count: 1,
    frequency: "biweekly",
    message: null,
    source: "referral",
    status: "converted",
    contacted_at: iso(new Date(Date.now() - 5 * 864e5)),
    converted_at: iso(new Date(Date.now() - 3 * 864e5)),
    converted_client_id: CLIENT_ID,
  },
  {
    id: "12121212-0000-4000-8000-000000001203",
    organization_id: ORG_ID,
    created_at: iso(new Date(Date.now() - 9 * 864e5)),
    updated_at: iso(new Date(Date.now() - 8 * 864e5)),
    name: "Bo Ng",
    email: "13125550123@sms.lead",
    phone: "+13125550123",
    company: null,
    location: null,
    dog_count: null,
    frequency: null,
    message: "Asked for a callback about a one-time spring cleanup.",
    source: "sms_receptionist",
    status: "converted",
    contacted_at: null,
    converted_at: iso(new Date(Date.now() - 8 * 864e5)),
    converted_client_id: null,
  },
];

/** The platform console's tenant list. Two rows in every lifecycle state the
 *  console draws a badge for, so nothing in that column is untested. */
export const PLATFORM_TENANTS = [
  {
    name: ORG_NAME,
    billing_status: "active",
    suspended_at: null,
    deleted_at: null,
    grace_expires_at: null,
  },
  {
    name: "Pawsitive Scoops of Greater Metropolitan Phoenix",
    billing_status: "past_due",
    suspended_at: null,
    deleted_at: null,
    grace_expires_at: iso(new Date(Date.now() + 3 * 864e5)),
  },
  {
    name: "K9 Kleanup",
    billing_status: "trialing",
    suspended_at: null,
    deleted_at: null,
    grace_expires_at: null,
  },
  {
    name: "Doody Calls Franchising Incorporated (Southeast)",
    billing_status: "canceled",
    suspended_at: iso(new Date(Date.now() - 8 * 864e5)),
    deleted_at: null,
    grace_expires_at: null,
  },
  {
    name: "Turdminator",
    billing_status: "active",
    suspended_at: null,
    deleted_at: null,
    grace_expires_at: null,
  },
  {
    name: "Scoopy Doo Waste Removal & Sanitation Cooperative",
    billing_status: "active",
    suspended_at: null,
    deleted_at: null,
    grace_expires_at: null,
  },
].map((t, i) => ({
  id: i === 0 ? ORG_ID : `aaaaaaaa-0000-4000-8000-00000000a0${String(i + 1).padStart(2, "0")}`,
  name: t.name,
  billing_status: t.billing_status,
  plan_slug: ["pro", "starter", "trial", "pro", "starter", "enterprise"][i],
  plan_name: ["Pro", "Starter", "Trial", "Pro", "Starter", "Enterprise (annual, invoiced)"][i],
  active_client_count: 214 - i * 31,
  users_count: 7 - i,
  last_activity_at: iso(new Date(Date.now() - i * 2 * 864e5)),
  stripe_customer_id: `cus_QxT7HkPmZ3vLd8RaFn2W${i}`,
  stripe_subscription_id: `sub_1QxT7HkPmZ3vLd8RaFn2Wq0B${i}`,
  created_at: iso(new Date(Date.now() - (90 + i * 40) * 864e5)),
  suspended_at: t.suspended_at,
  grace_expires_at: t.grace_expires_at,
  deleted_at: t.deleted_at,
}));

/** 173 accounts. The pager shipped today exists because the directory stopped
 *  at 150 — a page that only ever holds one page cannot show that it was fixed. */
export const PLATFORM_USER_TOTAL = 173;

export function platformUsers(offset: number, limit: number) {
  const rows = [];
  for (let i = offset; i < Math.min(offset + limit, PLATFORM_USER_TOTAL); i++) {
    rows.push({
      user_id: `77777777-0000-4000-8000-${String(300000000000 + i).slice(0, 12)}`,
      email: `dispatcher.${i}.longmailboxname@whitfield-ramirez-yard-services.example.com`,
      last_sign_in_at: iso(new Date(Date.now() - (i % 30) * 864e5)),
      created_at: iso(new Date(Date.now() - (i + 30) * 864e5)),
      organizations: [
        { id: ORG_ID, name: ORG_NAME, role: i % 5 === 0 ? "owner" : "office_manager" },
        ...(i % 7 === 0
          ? [
              {
                id: TENANT_B_ID,
                name: "Pawsitive Scoops of Greater Metropolitan Phoenix",
                role: "tech",
              },
            ]
          : []),
      ],
    });
  }
  return rows;
}

/** The audit trail the tenant diff view added today renders. before/after JSON
 *  is deliberately wide — that view prints it, and a wide `<pre>` is the
 *  classic way a page learns to scroll sideways. */
export const TENANT_AUDIT = [
  {
    action: "billing_status_change",
    before_json: {
      billing_status: "trialing",
      plan_id: "1f0c2f5e-3b7a-4d21-9e88-6c5a4b3d2e10",
      grace_expires_at: null,
    },
    after_json: {
      billing_status: "active",
      plan_id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      grace_expires_at: null,
    },
  },
  {
    action: "plan_change",
    before_json: {
      plan_slug: "starter",
      price_cents: 4900,
      included_seats: 3,
      stripe_price_id: "price_1QxT7HkPmZ3vLd8RaFn2Wq0Bs",
    },
    after_json: {
      plan_slug: "pro",
      price_cents: 14900,
      included_seats: 10,
      stripe_price_id: "price_1QxT7HkPmZ3vLd8RaFn2Wq0Ct",
    },
  },
  {
    action: "grace_granted",
    before_json: { grace_expires_at: null },
    after_json: { grace_expires_at: iso(new Date(Date.now() + 5 * 864e5)) },
  },
  {
    action: "tenant_suspended",
    before_json: { suspended_at: null, suspended_reason: null },
    after_json: {
      suspended_at: iso(new Date(Date.now() - 8 * 864e5)),
      suspended_reason: "Payment failed four consecutive times and the grace period elapsed",
    },
  },
].map((r, i) => ({
  id: `88888888-0000-4000-8000-${String(400000000000 + i).slice(0, 12)}`,
  actor_user_id: "77777777-0000-4000-8000-300000000000",
  actor_email: "platform.operations.oncall@houndstack.example.com",
  action: r.action,
  before_json: r.before_json,
  after_json: r.after_json,
  created_at: iso(new Date(Date.now() - (i + 1) * 3 * 864e5)),
}));

export const PLATFORM_PLANS = [
  {
    slug: "starter",
    name: "Starter",
    price_cents: 4_900,
    annual_price_cents: 49_000,
    included_seats: 3,
    price_per_seat_cents: 900,
    interval: "month",
    is_active: true,
    sort_order: 1,
  },
  {
    slug: "pro",
    name: "Pro",
    price_cents: 14_900,
    annual_price_cents: 149_000,
    included_seats: 10,
    price_per_seat_cents: 700,
    interval: "month",
    is_active: true,
    sort_order: 2,
  },
  {
    slug: "enterprise",
    name: "Enterprise (annual, invoiced)",
    price_cents: 0,
    annual_price_cents: 720_000,
    included_seats: 50,
    price_per_seat_cents: 0,
    interval: "year",
    is_active: false,
    sort_order: 3,
  },
].map((p, i) => ({
  id: `66666666-0000-4000-8000-00000000f0${String(i + 1).padStart(2, "0")}`,
  description:
    "Everything in the tier below, plus route optimisation, the client portal and unlimited SMS reminders.",
  stripe_product_id: `prod_QxT7HkPmZ3vLd8Ra${i}`,
  stripe_price_id: `price_1QxT7HkPmZ3vLd8RaFn2Wq0B${i}`,
  stripe_annual_price_id: `price_1QxT7HkPmZ3vLd8RaFn2Wq0C${i}`,
  entitlements: { routes: true, portal: true, franchise: i === 2 },
  ...p,
}));

/**
 * `/leads`. Until 2026-09-28 `listLeads` and `getLeadFormConfig` had no stub,
 * so both answered `null` and the page drew "No leads yet" with no "Preview
 * form" button, which is the control that made its header wider than a
 * phone. Every org has a lead form once it has a portal slug, so the header
 * this sweep measured was one no real owner ever saw.
 *
 * The rows are awkward where the card is narrow: a hyphenated name beside a
 * status badge and a company, in a row that did not wrap; an email with
 * nowhere to break (the card says it is the only copy of the address in the
 * app, so it cannot be truncated away); and one lead in each working status,
 * so both branches of the action column get drawn.
 */
export const WORKING_LEADS = [
  {
    name: "Genevieve Okonkwo-Castellanos",
    company: "Lakeview Terrace Condominium Association",
    email: "genevieve.okonkwo-castellanos@lakeviewterracecondoassociation.example.com",
    phone: "+13125550188",
    location: "2847 North Lakewood Avenue, Unit 3R, Chicago, IL 60657",
    dog_count: 3,
    message:
      "Three dogs across two yards, and the side gate sticks. Looking for weekly service from the first of next month.",
    status: "new",
    source: "website",
  },
  {
    name: "Theo Bright",
    company: null,
    email: "theo.b@example.com",
    phone: "+13125550102",
    location: "60614",
    dog_count: 1,
    message: "Referred by Anastasia.",
    status: "contacted",
    source: "referral",
  },
  {
    name: "Bartholomew Featherstonehaugh",
    company: "Featherstonehaugh & Sons Property Services",
    email: "b.featherstonehaugh@featherstonehaughandsonspropertyservices.example.com",
    phone: null,
    location: null,
    dog_count: null,
    message: null,
    status: "qualified",
    source: "website",
  },
  {
    name: "Lauren Woods",
    company: null,
    email: "lauren.w@example.com",
    phone: "+13125550177",
    location: "60640",
    dog_count: 2,
    message: "Big backyard.",
    status: "converted",
    source: "website",
  },
].map((l, i) => ({
  id: `44444444-0000-4000-8000-00000000c0${String(i + 1).padStart(2, "0")}`,
  organization_id: ORG_ID,
  frequency: null,
  contacted_at: null,
  converted_at: null,
  converted_client_id: null,
  created_at: iso(new Date(Date.now() - (i + 1) * 5 * 3600e3)),
  updated_at: iso(new Date(Date.now() - (i + 1) * 5 * 3600e3)),
  ...l,
}));

/**
 * `/reports`. Until 2026-09-28 `getReports` had no stub, answered `null`, and
 * the page threw on `data.collectedGrossCents`, so the unlisted-route sweep
 * measured the router's error boundary, which fits on any phone, and called
 * the page green at 360 and 430.
 *
 * Shaped like the seeded org it stands in for, then made awkward: every table
 * has rows (an empty table has no layout), there is a refund in range so the
 * top-clients table grows its two extra columns, and the skip codes, staff and
 * zones are the long ones. A seeded org measured on 2026-09-28 laid this page
 * out at 786px on a 360px phone.
 */
export const REPORTS = {
  range: { from: day(-29), to: TODAY },
  timezone: "America/Chicago",
  collectedGrossCents: 1_874_250,
  collectedNetCents: 1_806_750,
  paymentCount: 142,
  refundsDeductedCents: 67_500,
  refundsRecoveredCents: 0,
  refundsNetCents: 67_500,
  refundsCount: 2,
  billedCents: 2_031_400,
  creditsAppliedCents: 12_500,
  netBilledCents: 2_018_900,
  invoiceCount: 188,
  arAsOf: TODAY,
  outstandingCents: 392_450,
  openInvoiceCount: 31,
  aging: { current: 204_300, d30: 118_650, d60: 52_000, d90: 17_500 },
  visitCounts: { completed: 812, skipped: 37, missed: 4, scheduled: 96, in_progress: 0, cancelled: 3 },
  completionRate: 812 / (812 + 37 + 4),
  perTech: STAFF.filter((s) => s.role === "tech").map((s, i) => ({
    id: s.id,
    name: s.display_name,
    completed: 240 - i * 31,
    skipped: 11 - i * 2,
    total: 254 - i * 33,
  })),
  perZone: [
    { id: "zzzz1111-0000-4000-8000-000000000001", name: "Ravenswood Manor / Lincoln Square North" },
    { id: "zzzz1111-0000-4000-8000-000000000002", name: "Uptown / Edgewater Beach Commercial Grounds" },
    { id: "no_zone", name: "No zone" },
  ].map((z, i) => ({ ...z, completed: 420 - i * 150, skipped: 20 - i * 7, total: 446 - i * 158 })),
  // The longest reason on purpose: it sits in a two-column table in a
  // half-width card.
  churnReasons: [
    { reason: "Dog passed away or rehomed", count: 4 },
    { reason: "Switched to another company", count: 3 },
    { reason: "Moving away", count: 2 },
    { reason: "Price", count: 1 },
  ],
  skipReasons: [
    { code: "access_blocked", count: 14 },
    { code: "client_cancelled_late", count: 11 },
    { code: "unsafe_conditions", count: 7 },
    { code: "weather", count: 5 },
  ],
  topClients: CLIENTS.slice(0, 6).map((c, i) => {
    const refundsCents = i === 1 ? 45_000 : i === 4 ? 22_500 : 0;
    const collectedCents = 184_000 - i * 21_500;
    return {
      id: c.id,
      name: c.display_name,
      collectedCents,
      refundsCents,
      netCollectedCents: collectedCents - refundsCents,
    };
  }),
  newClients: 23,
  activeClients: 214,
};

// ── /timesheets and the My Day time clock ──────────────────────────────────

/** 46 characters, the longest name in the fixture, and on the sheet on
 *  purpose: the grid's first column and the phone card's header both have to
 *  hold it beside a total. */
export const LONG_STAFF_NAME = "Maximilian Alexander Fitzgerald-Worthington II";
const LONG_STAFF_ID = "dddddddd-0000-4000-8000-00000000d008";

/** Monday of the fixture's current week, the same arithmetic as mondayOf. */
const mondayOfToday = (() => {
  const [y, m, d] = TODAY.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day(dow === 0 ? -6 : 1 - dow);
})();
const weekDay = (i: number) => {
  const [y, m, d] = mondayOfToday.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
};
const orgAt = (d: string, hhmm: string) =>
  zonedTimeToUtc(d, hhmm, ORGANIZATION.timezone).toISOString();

/**
 * A week the timesheet has to work to lay out, not a tidy one:
 *
 *  - the 46-character name works five 9h45m days and is in OVERTIME, then
 *    works a Saturday shift that runs past MIDNIGHT into Sunday, so the grid
 *    draws a split day and the total carries its overtime badge;
 *  - one tech is ON THE CLOCK now (an open entry), so the "now" branch draws;
 *  - one tech completed visits and never clocked in, so the "no time" branch
 *    draws;
 *  - the rest have ordinary days, one of them with a lunch break (two shifts).
 */
export const TIMESHEET = (() => {
  const staff = [
    { id: LONG_STAFF_ID, display_name: LONG_STAFF_NAME, active: true },
    ...STAFF.filter((s) => s.role === "tech").map((s) => ({
      id: s.id,
      display_name: s.display_name,
      active: true,
    })),
  ];
  const entries: Array<Record<string, unknown>> = [];
  let n = 0;
  const push = (staffId: string, from: string, to: string | null) => {
    n += 1;
    entries.push({
      id: `77777777-0000-4000-8000-${String(100000000000 + n).slice(0, 12)}`,
      staff_id: staffId,
      clock_in: from,
      clock_out: to,
      clock_in_source: "tech_live",
      clock_out_source: to ? "tech_live" : null,
      note: n % 7 === 0 ? "Forgot to clock out at the dump; corrected from the fuel receipt" : null,
      edited_at: n % 7 === 0 ? orgAt(weekDay(0), "18:00") : null,
    });
  };
  for (let i = 0; i < 5; i++) {
    push(LONG_STAFF_ID, orgAt(weekDay(i), "06:30"), orgAt(weekDay(i), "16:15"));
  }
  push(LONG_STAFF_ID, orgAt(weekDay(5), "21:00"), orgAt(weekDay(6), "01:30"));
  // Alejandro: morning and afternoon, Monday to Thursday.
  for (let i = 0; i < 4; i++) {
    push(STAFF[0].id, orgAt(weekDay(i), "07:05"), orgAt(weekDay(i), "11:50"));
    push(STAFF[0].id, orgAt(weekDay(i), "12:25"), orgAt(weekDay(i), "16:40"));
  }
  // Samantha: on the clock right now.
  push(STAFF[1].id, new Date(Date.now() - 3 * 3600_000 - 12 * 60_000).toISOString(), null);
  // Bartholomew and Priyanka: short days.
  for (let i = 1; i < 4; i++) {
    push(STAFF[2].id, orgAt(weekDay(i), "08:00"), orgAt(weekDay(i), "13:00"));
    push(STAFF[4].id, orgAt(weekDay(i), "09:30"), orgAt(weekDay(i), "15:10"));
  }
  // Wen Zhang (STAFF[3]) clocked nothing, and completed visits anyway.
  const visits = [
    ...Array.from({ length: 6 }, (_, i) => ({
      assigned_staff_id: STAFF[3].id,
      completed_at: orgAt(weekDay(1), `${String(9 + i).padStart(2, "0")}:10`),
    })),
    ...Array.from({ length: 5 }, (_, d) =>
      Array.from({ length: 11 }, (_, i) => ({
        assigned_staff_id: LONG_STAFF_ID,
        completed_at: orgAt(weekDay(d), `${String(7 + (i % 9)).padStart(2, "0")}:${10 + i}`),
      })),
    ).flat(),
    ...Array.from({ length: 4 }, (_, d) => ({
      assigned_staff_id: STAFF[0].id,
      completed_at: orgAt(weekDay(d), "10:20"),
    })),
  ];
  // Tips, in the shape listTimesheet returns (payments.tip_staff_id /
  // tip_cents / paid_at). The long name has two on Monday, so the grid's Tips
  // column and the phone card's header both draw a figure beside the longest
  // name; Wen Zhang, who never clocked in, has one on the day of her visits,
  // so the "no time" day carries a tip too.
  const tips = [
    { tip_staff_id: LONG_STAFF_ID, tip_cents: 1_540, paid_at: orgAt(weekDay(0), "19:42") },
    { tip_staff_id: LONG_STAFF_ID, tip_cents: 2_375, paid_at: orgAt(weekDay(0), "20:05") },
    { tip_staff_id: STAFF[3].id, tip_cents: 1_000, paid_at: orgAt(weekDay(1), "18:30") },
  ];
  return {
    timezone: ORGANIZATION.timezone,
    weekStart: mondayOfToday,
    today: TODAY,
    staff,
    pickable: staff.map((s) => ({ id: s.id, display_name: s.display_name })),
    entries,
    visits,
    tips,
  };
})();

/** My Day's clock: on the clock now, with an earlier shift today, which draws
 *  the longer of the card's two second lines. */
export const MY_CLOCK = {
  staff: { id: STAFF[0].id, display_name: STAFF[0].display_name },
  timezone: ORGANIZATION.timezone,
  today: TODAY,
  entries: [
    {
      id: "77777777-0000-4000-8000-900000000001",
      staff_id: STAFF[0].id,
      clock_in: new Date(Date.now() - 6 * 3600_000).toISOString(),
      clock_out: new Date(Date.now() - 3 * 3600_000).toISOString(),
      clock_in_source: "tech_live",
      clock_out_source: "tech_live",
    },
    {
      id: "77777777-0000-4000-8000-900000000002",
      staff_id: STAFF[0].id,
      clock_in: new Date(Date.now() - 2.5 * 3600_000).toISOString(),
      clock_out: null,
      clock_in_source: "tech_offline_replay",
      clock_out_source: null,
    },
  ],
  visitsCompletedToday: 4,
};

/**
 * /concerns, which had no fixture until 2026-09-28 and so was only ever
 * measured drawing "No concerns, happy yards all around".
 *
 * `listConcerns` returns `{ concerns, counts }` with the status already
 * translated to the inbox's word ("in_progress", not the table's
 * "acknowledged"), and embeds `clients`, `visit` and `reclean_visit` by name.
 * Three rows, each a different layout: a re-clean request with nothing booked
 * (the "Schedule re-clean" button beside a sentence), a re-clean already
 * booked (the sentence alone), and a plain concern with a reply on it. The
 * client names and email addresses are the long ones, because the header row
 * of a card puts a name beside two badges.
 */
export const CONCERNS = {
  concerns: [
    {
      id: "44444444-0000-4000-8000-000000004001",
      category: "reclean_request",
      message:
        "The strip along the back fence behind the raised garden beds looked like it had been skipped entirely this time.",
      status: "open",
      created_at: iso(new Date(Date.now() - 3 * 3600e3)),
      resolved_at: null,
      resolution_note: null,
      last_reply: null,
      last_reply_at: null,
      client_id: CLIENTS[7].id,
      visit_id: "ffffffff-0000-4000-8000-00000000f101",
      reclean_visit_id: null,
      clients: {
        display_name: CLIENTS[7].display_name,
        primary_phone: CLIENTS[7].primary_phone,
        primary_email: CLIENTS[7].primary_email,
      },
      visit: {
        scheduled_on: day(-1),
        property_id: PROPERTIES[7].id,
        assigned_staff_id: STAFF[0].id,
      },
      reclean_visit: null,
    },
    {
      id: "44444444-0000-4000-8000-000000004002",
      category: "reclean_request",
      message: null,
      status: "in_progress",
      created_at: iso(new Date(Date.now() - 20 * 3600e3)),
      resolved_at: null,
      resolution_note: null,
      last_reply: null,
      last_reply_at: null,
      client_id: CLIENTS[5].id,
      visit_id: "ffffffff-0000-4000-8000-00000000f102",
      reclean_visit_id: "ffffffff-0000-4000-8000-00000000f103",
      clients: {
        display_name: CLIENTS[5].display_name,
        primary_phone: CLIENTS[5].primary_phone,
        primary_email: CLIENTS[5].primary_email,
      },
      visit: {
        scheduled_on: day(-2),
        property_id: PROPERTIES[5].id,
        assigned_staff_id: STAFF[2].id,
      },
      reclean_visit: { scheduled_on: day(1), status: "scheduled" },
    },
    {
      id: "44444444-0000-4000-8000-000000004003",
      category: "gate_left_open",
      message:
        "Side gate was unlatched when we got home. Dogs were fine, but please double-check it.",
      status: "open",
      created_at: iso(new Date(Date.now() - 2 * 864e5)),
      resolved_at: null,
      resolution_note: null,
      last_reply: "So sorry about that. We've added a note to the route card for the side gate.",
      last_reply_at: iso(new Date(Date.now() - 864e5)),
      client_id: CLIENTS[4].id,
      visit_id: null,
      reclean_visit_id: null,
      clients: {
        display_name: CLIENTS[4].display_name,
        primary_phone: CLIENTS[4].primary_phone,
        primary_email: CLIENTS[4].primary_email,
      },
      visit: null,
      reclean_visit: null,
    },
    {
      // An extra cleanup asked for from the portal, not yet booked: a
      // sentence with the day and the longest street, beside Decline and
      // Book it, which is the row that has to wrap on a phone.
      id: "44444444-0000-4000-8000-000000004004",
      category: "one_off_request",
      message: "We're hosting the block party this weekend, so the side yard needs to be spotless.",
      status: "open",
      created_at: iso(new Date(Date.now() - 5 * 3600e3)),
      resolved_at: null,
      resolution_note: null,
      last_reply: null,
      last_reply_at: null,
      client_id: CLIENTS[7].id,
      visit_id: null,
      reclean_visit_id: null,
      requested_on: day(3),
      property_id: PROPERTIES[7].id,
      booked_visit_id: null,
      clients: {
        display_name: CLIENTS[7].display_name,
        primary_phone: CLIENTS[7].primary_phone,
        primary_email: CLIENTS[7].primary_email,
      },
      visit: null,
      reclean_visit: null,
      property: { street: PROPERTIES[7].street, city: PROPERTIES[7].city },
      booked_visit: null,
    },
  ],
  counts: { open: 3, in_progress: 1, resolved: 0 },
};

/** Settings -> Client portal, extra cleanups: no price yet, so auto-accept is
 *  off and cannot be turned on, and the card says so. */
export const PORTAL_BOOKING_SETTINGS = {
  autoAccept: false,
  priceCents: null,
  currency: "usd",
  canEdit: true,
};

/**
 * The calendar feed card (Profile, and Settings -> Scheduling), added
 * 2026-09-29 with the feeds.
 *
 * `getMyCalendarFeeds` returns camelCase and both scopes. The owner can have
 * both, so both rows draw: "My visits" with a link already made and read by a
 * calendar (the longest status line the row has), "Every visit" with none yet
 * (the "Create link" button). The URL is the length production makes -- app
 * origin, path, 43 base64url characters, `.ics` -- because the box it is
 * shown in is only tested by a value that long.
 */
export const CALENDAR_FEEDS = {
  mine: {
    createdAt: "2026-08-14T14:22:00.000Z",
    lastFetchedAt: iso(new Date(Date.now() - 2 * 3600e3)),
  },
  org: null,
  canMine: true,
  canOrg: true,
  accessCodesInFeed: false,
  canManageSettings: true,
};
export const CALENDAR_FEED_URL =
  "https://app.houndstack.com/api/public/calendar/q3Vx8KpZ-7mT2wLr9sYc_4NbHd6FjAe1GuQo0IiPlXk.ics";

/**
 * /quotes and /quotes/:id, added 2026-09-28 with the pages.
 *
 * The list is the shapes `listQuotes` returns after its own reshaping
 * (camelCase, totals summed, status already expired-by-date), one of every
 * status, with the long names: a prospect HOA whose name is longer than any
 * client's, and a quote with BOTH totals, because a row that draws one total
 * is narrower than a row that draws two.
 */
export const QUOTE_PROSPECT_NAME = "Lakeview Terrace Condominium Association Board of Managers";
export const QUOTE_ACCEPTED_ID = "55555555-0000-4000-8000-000000005001";
export const QUOTE_DRAFT_ID = "55555555-0000-4000-8000-000000005002";
const quoteRow = (
  n: number,
  status: string,
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: `55555555-0000-4000-8000-00000000500${n}`,
  number: 1040 + n,
  label: `Q-${1040 + n}`,
  status,
  title: null,
  recipientName: CLIENTS[n % CLIENTS.length].display_name,
  isProspect: false,
  validUntil: day(25),
  sentAt: status === "draft" ? null : iso(new Date(Date.now() - 2 * 864e5)),
  acceptedAt: null,
  declinedAt: null,
  convertedAt: null,
  createdAt: iso(new Date(Date.now() - 3 * 864e5)),
  oneTimeCents: 0,
  recurringCents: 2400,
  ...over,
});
export const QUOTES = {
  today: TODAY,
  timezone: "America/Chicago",
  quotes: [
    quoteRow(1, "accepted", {
      recipientName: QUOTE_PROSPECT_NAME,
      isProspect: true,
      title: "Weekly service and common-area stations for the Lakeview Terrace Condominium Association",
      acceptedAt: iso(new Date(Date.now() - 864e5)),
      oneTimeCents: 16500,
      recurringCents: 5100,
    }),
    quoteRow(2, "draft", { recipientName: CLIENTS[1].display_name, title: "Spring cleanup" }),
    quoteRow(3, "sent", { oneTimeCents: 12000 }),
    quoteRow(4, "declined", { declinedAt: iso(new Date(Date.now() - 864e5)) }),
    quoteRow(5, "expired", { validUntil: day(-3) }),
  ],
};

const QUOTE_DETAIL_LINES = [
  {
    id: "66666666-0000-4000-8000-000000006001",
    // Exactly 60 characters, beside a right-aligned amount.
    description: "Common-area waste stations, emptied, relined and disinfected",
    quantity: 6,
    unit_amount_cents: 450,
    amount_cents: 2700,
    recurring: true,
  },
  {
    id: "66666666-0000-4000-8000-000000006002",
    description: "Weekly yard service, two dogs",
    quantity: 1,
    unit_amount_cents: 2400,
    amount_cents: 2400,
    recurring: true,
  },
  {
    id: "66666666-0000-4000-8000-000000006003",
    description: "Initial cleanup of a yard not serviced since the spring thaw",
    quantity: 1,
    unit_amount_cents: 14500,
    amount_cents: 14500,
    recurring: false,
  },
  {
    id: "66666666-0000-4000-8000-000000006004",
    description: "Deodoriser",
    quantity: 1.5,
    unit_amount_cents: 1333,
    amount_cents: 2000,
    recurring: false,
  },
];

/** `getQuote`, keyed by id: an accepted prospect quote (the read-only view
 *  with its timeline and the Convert button) and a draft (the editor). */
export function quoteDetail(id: string) {
  const accepted = id === QUOTE_ACCEPTED_ID;
  return {
    quote: {
      id,
      number: accepted ? 1041 : 1042,
      label: accepted ? "Q-1041" : "Q-1042",
      rawStatus: accepted ? "accepted" : "draft",
      status: accepted ? "accepted" : "draft",
      title: "Weekly service and common-area stations for the Lakeview Terrace Condominium Association",
      message:
        "Thanks for walking the grounds with me on Tuesday. This covers the courtyard, the east greenway and both dog runs.",
      validUntil: day(25),
      sentAt: accepted ? iso(new Date(Date.now() - 2 * 864e5)) : null,
      acceptedAt: accepted ? iso(new Date(Date.now() - 864e5)) : null,
      acceptedName: accepted ? "Genevieve Okonkwo-Castellanos de la Fuente" : null,
      declinedAt: null,
      declineReason: null,
      convertedAt: null,
      convertedClientId: null,
      createdAt: iso(new Date(Date.now() - 3 * 864e5)),
      clientId: null,
      clientName: null,
      clientEmail: null,
      leadId: LEAD_ID,
      leadName: LEAD_NAME,
      prospectName: QUOTE_PROSPECT_NAME,
      prospectEmail: "board.of.managers@lakeviewterracecondominiumassociation.example.com",
      prospectPhone: "+1 (312) 555-0177",
      recipientName: QUOTE_PROSPECT_NAME,
      recipientEmail: "board.of.managers@lakeviewterracecondominiumassociation.example.com",
      publicUrl: accepted ? "https://app.houndstack.com/q/dddddddd-0000-4000-8000-00000000d002" : null,
    },
    lines: QUOTE_DETAIL_LINES,
    totals: { oneTimeCents: 16500, recurringCents: 5100, oneTimeCount: 2, recurringCount: 2 },
    today: TODAY,
    timezone: "America/Chicago",
    orgName: ORG_NAME,
  };
}

// ── /expenses and My Day's "Log an expense" ─────────────────────────────────

/** 72 characters with no helpful break until the end: the vendor a disposal
 *  fee is paid to, as it is printed on the ticket. It sits in the phone card's
 *  title beside the amount, and in a table cell that must truncate. */
export const LONG_VENDOR =
  "Northshore Regional Solid Waste Transfer & Recycling Facility No. 4471-B";

/**
 * A month of expenses that makes the page work: every category, a 7-digit
 * amount (an equipment purchase of $1,234,567.89, absurd for a one-truck
 * business and exactly the width a month's total reaches once it is summed),
 * mileage with its rate, a receipt, a note, an expense that is nobody's, and
 * the 46-character name. `listExpenses` returns the whole ExpenseList shape,
 * so the page draws the office branch with the mileage-rate card.
 */
export const EXPENSE_LIST = (() => {
  const month = TODAY.slice(0, 7);
  const lastDay = Number(TODAY.slice(8, 10));
  const on = (d: number) => `${month}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
  let n = 0;
  const row = (over: Record<string, unknown>) => {
    n += 1;
    return {
      id: `88888888-0000-4000-8000-${String(100000000000 + n).slice(0, 12)}`,
      organization_id: ORG_ID,
      staff_id: STAFF[0].id,
      spent_on: on(n),
      category: "fuel",
      amount_cents: 6843,
      miles: null,
      mileage_rate_cents: null,
      vendor: null,
      note: null,
      receipt_path: null,
      created_by: null,
      created_at: iso(new Date(Date.now() - n * 3600e3)),
      updated_at: iso(new Date(Date.now() - n * 3600e3)),
      ...over,
    };
  };
  const expenses = [
    row({
      category: "disposal",
      amount_cents: 4250,
      vendor: LONG_VENDOR,
      receipt_path: `${ORG_ID}/${STAFF[0].id}/88888888-0000-4000-8000-100000000001.jpg`,
      note: "Two loads; the scale house was closed so the attendant wrote the ticket by hand.",
    }),
    row({
      category: "equipment",
      amount_cents: 123_456_789,
      vendor: "Commercial Turf & Waste Equipment Supply of Greater Chicagoland",
      staff_id: null,
    }),
    row({
      category: "mileage",
      amount_cents: 1697,
      miles: "23.4",
      mileage_rate_cents: "72.50",
      vendor: "Yard to the Ravenswood Manor / Lincoln Square North route and back",
      staff_id: LONG_STAFF_ID,
    }),
    row({ category: "fuel", amount_cents: 8911, vendor: "Shell", staff_id: STAFF[1].id }),
    row({ category: "supplies", amount_cents: 18999, vendor: "Bag supplier (case of 2,000)" }),
    row({ category: "vehicle_maintenance", amount_cents: 64_500, vendor: "Brake pads and rotors" }),
    row({ category: "other", amount_cents: 2500, note: "Parking at the county office" }),
  ];
  return {
    orgId: ORG_ID,
    role: "owner",
    isOffice: true,
    canSetRate: true,
    myStaff: { id: STAFF[0].id, display_name: STAFF[0].display_name },
    timezone: ORGANIZATION.timezone,
    today: TODAY,
    mileageRateCents: 72.5,
    month,
    staff: [
      ...STAFF.map((s) => ({ id: s.id, display_name: s.display_name, active: true })),
      { id: LONG_STAFF_ID, display_name: LONG_STAFF_NAME, active: true },
    ],
    expenses,
  };
})();

/** What the field sheet reads to preview a mileage amount. */
export const EXPENSE_SETTINGS = {
  mileageRateCents: 72.5,
  timezone: ORGANIZATION.timezone,
  today: TODAY,
  myStaffId: STAFF[0].id,

/**
 * /campaigns and /campaigns/:id, added 2026-09-29 with the pages.
 *
 * Awkward on purpose. A subject at the 150-character limit wraps in the list
 * row and in the page heading; a tag at the 40-character limit sits in the
 * audience picker among thirty others; the numbers are in the thousands so
 * the stat tiles carry four digits and a separator. The draft's business has
 * NO postal address, so the warning that blocks Send is on the page being
 * measured, as it is for every owner who has not filled one in yet.
 */
export const CAMPAIGN_SENT_ID = "77777777-0000-4000-8000-000000007001";
export const CAMPAIGN_DRAFT_ID = "77777777-0000-4000-8000-000000007002";
export const CAMPAIGN_SENDING_ID = "77777777-0000-4000-8000-000000007003";
// Exactly 150 characters, the most a subject may have.
export const CAMPAIGN_SENT_SUBJECT =
  "Spring deep clean for every yard on the North Side: twenty dollars off any one-time cleanup booked before the thirtieth of April, two dogs or twelve!!";
export const CAMPAIGN_DRAFT_SUBJECT =
  "Holiday schedule: no visits Thursday the 25th or Friday the 26th, and Wednesday routes run a day early that week";
// Exactly 40 characters, the most a tag may have.
export const CAMPAIGN_LONG_TAG = "Ravenswood-Manor-Lincoln-Square-weekly-x";
const CAMPAIGN_BODY =
  "We're taking two days off for the holiday so our crew can be with their families.\n\nIf your visit falls on Thursday or Friday we'll come Wednesday instead. Nothing to do on your end: your gate code and notes carry over.\n\nThank you for a wonderful year. https://whitfield-ramirez-yard-and-waste-services.example.com/holiday-schedule-2026-and-what-it-means-for-your-route";

const campaignRow = (
  id: string,
  status: "draft" | "sending" | "sent",
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id,
  status,
  subject: CAMPAIGN_DRAFT_SUBJECT,
  heading: "Holiday hours, and a thank-you",
  body: CAMPAIGN_BODY,
  buttonLabel: "See the whole holiday schedule",
  buttonUrl: "https://whitfield-ramirez-yard-and-waste-services.example.com/holiday-schedule-2026",
  audience: { kind: "tagged", tag: CAMPAIGN_LONG_TAG },
  audienceLabel: `Clients tagged "${CAMPAIGN_LONG_TAG}"`,
  recipientCount: null,
  createdAt: iso(new Date(Date.now() - 5 * 864e5)),
  updatedAt: iso(new Date(Date.now() - 864e5)),
  sentAt: null,
  completedAt: null,
  stats: null,
  ...over,
});

const CAMPAIGN_SENT = campaignRow(CAMPAIGN_SENT_ID, "sent", {
  subject: CAMPAIGN_SENT_SUBJECT,
  heading: "Spring is here, and so is everything the snow was hiding",
  audience: { kind: "active" },
  audienceLabel: "All active clients",
  recipientCount: 4213,
  sentAt: iso(new Date(Date.now() - 3 * 864e5)),
  completedAt: iso(new Date(Date.now() - 2.6 * 864e5)),
  stats: { recipients: 4213, waiting: 0, inQueue: 0, skipped: 187, sent: 4011, failed: 15, bounced: 38 },
});

export const CAMPAIGNS = {
  orgName: ORG_NAME,
  timezone: "America/Chicago",
  contactAddress: "4417 N Ravenswood Ave, Suite 2B, Chicago, IL 60640",
  contactEmail: "office@whitfield-ramirez.example.com",
  campaigns: [
    campaignRow(CAMPAIGN_DRAFT_ID, "draft"),
    campaignRow(CAMPAIGN_SENDING_ID, "sending", {
      subject:
        "We now serve Oak Park, Forest Park and River Forest: tell a neighbour and you both get a free visit",
      audience: { kind: "inactive" },
      audienceLabel: "Inactive and former clients",
      recipientCount: 1250,
      sentAt: iso(new Date(Date.now() - 3600e3)),
      stats: { recipients: 1250, waiting: 830, inQueue: 10, skipped: 12, sent: 396, failed: 0, bounced: 2 },
    }),
    CAMPAIGN_SENT,
  ],
};

/** `getCampaign`, keyed by id: the draft opens in the editor, the sent one
 *  is the record with its stats. */
export function campaignDetail(id: string) {
  const sent = id === CAMPAIGN_SENT_ID;
  return {
    campaign: sent ? CAMPAIGN_SENT : campaignRow(CAMPAIGN_DRAFT_ID, "draft"),
    skipReasons: sent ? { client_opted_out: 120, comms_paused: 40, suppressed: 27 } : {},
    orgName: ORG_NAME,
    timezone: "America/Chicago",
    // The draft's business has no address yet, so Send is blocked and says so.
    contactAddress: sent ? CAMPAIGNS.contactAddress : null,
    contactEmail: CAMPAIGNS.contactEmail,
  };
}

export const CAMPAIGN_AUDIENCE = {
  recipients: 4213,
  matched: 4497,
  excluded: { optedOut: 181, commsPaused: 62, noEmail: 38, duplicate: 3 },
  overCap: false,
  activeCount: 4497,
  inactiveCount: 1362,
  tags: [
    { tag: CAMPAIGN_LONG_TAG, count: 1204 },
    { tag: "gate-code-on-file", count: 988 },
    { tag: "vip", count: 412 },
    ...Array.from({ length: 27 }, (_, i) => ({
      tag: `imported-from-jobber-batch-${String(i + 1).padStart(2, "0")}`,
      count: 300 - i * 7,
    })),
  ],
};

export const CAMPAIGN_PREVIEW = {
  subject: CAMPAIGN_DRAFT_SUBJECT,
  html: `<!doctype html><html><body style="font-family:Arial,sans-serif"><div style="max-width:560px;padding:24px 28px"><h1 style="font-size:22px">Holiday hours, and a thank-you</h1><p>We're taking two days off for the holiday so our crew can be with their families.</p><p>https://whitfield-ramirez-yard-and-waste-services.example.com/holiday-schedule-2026-and-what-it-means-for-your-route</p><a href="https://example.com" style="background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">See the whole holiday schedule</a><p style="font-size:12px;color:#64748b">You are getting this because you are a customer of ${ORG_NAME}. <a href="#">Unsubscribe from these emails</a>.</p></div></body></html>`,
};
