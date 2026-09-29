/**
 * The customer's half of the product, which had never been measured.
 *
 * The staff app has a fixture (`dataset.ts`) chosen to be awkward on purpose —
 * a 46-character client name, a 78-character signup URL — because a fixture
 * tidier than reality measures nothing. The eight portal routes had no fixture
 * at all, so every one of them rendered a dead end and a sweep of them would
 * have measured the "this link has expired" card eight times.
 *
 * Same discipline here, and the same rule the owner set for demo data:
 * invented business, invented people, invented streets. Nothing in this file
 * is a real address, a real gate code, or anyone's billing detail.
 *
 * Shapes come from the migrations, not from guesswork — `portal_get_client`
 * alone returns 33 columns and three of them were appended after the fact.
 */

export const PORTAL_SLUG = "whitfield-ramirez-yard-and-waste-services";
export const PORTAL_TOKEN = "cccccccc-0000-4000-8000-00000000c001";
export const PORTAL_ORG_ID = "aaaaaaaa-0000-4000-8000-00000000a001";
export const PORTAL_CLIENT_ID = "bbbbbbbb-0000-4000-8000-00000000b001";

/** Long on purpose. A portal header that fits "Bo Chen" proves nothing. */
export const PORTAL_CLIENT_NAME = "Anastasia Vandermolen-Whitaker";
export const PORTAL_ORG_NAME = "Whitfield & Ramirez Yard and Waste Services";

const day = (offset: number) => {
  const d = new Date("2026-08-28T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const stamp = (offset: number) => `${day(offset)}T14:30:00.000Z`;

/**
 * camelCase, and not because of a house style.
 *
 * `orgBrandingBySlug` maps the snake_case columns to `orgName` / `orgSlug` /
 * `logoUrl` / `brandColor` before returning them, and the shell reads that
 * shape. Written in snake_case the first time, which made every portal page
 * fall back to a generic "Client portal" heading and a grey letter avatar --
 * still a page, still passing every layout rule, and branded like nobody's
 * business in particular.
 */
export const PORTAL_BRANDING = {
  organizationId: PORTAL_ORG_ID,
  orgName: PORTAL_ORG_NAME,
  orgSlug: PORTAL_SLUG,
  logoUrl: null,
  brandColor: "#1f7a4d",
};

/** All 33 columns of `portal_get_client`, in the order the migrations left
 *  them — including the three appended at the end in August. */
export const PORTAL_CLIENT = {
  client_id: PORTAL_CLIENT_ID,
  organization_id: PORTAL_ORG_ID,
  display_name: PORTAL_CLIENT_NAME,
  account_type: "residential",
  credit_balance_cents: 2500,
  org_name: PORTAL_ORG_NAME,
  brand_color: "#1f7a4d",
  logo_url: null,
  contact_phone: "(312) 555-0142",
  contact_email: "hello@whitfield-ramirez.example.com",
  autopay_enabled: true,
  has_saved_card: true,
  card_brand: "visa",
  card_last4: "4242",
  reschedule_cutoff_hours: 24,
  allow_self_reschedule: true,
  allow_vacation_hold: true,
  allow_frequency_change: true,
  auto_apply_changes: false,
  primary_frequency: "weekly",
  primary_price_cents: 2400,
  primary_dog_count: 2,
  primary_unit_count: 1,
  primary_billing_cadence: "monthly",
  station_count: 2,
  next_visit_id: "eeeeeeee-0000-4000-8000-00000000e001",
  next_visit_on: day(2),
  next_visit_eta_start: `${day(2)}T13:00:00.000Z`,
  next_visit_eta_end: `${day(2)}T15:00:00.000Z`,
  // A long one, because the ETA row puts the name beside a time range and a
  // short name never pushes it anywhere.
  next_visit_tech_name: "Alejandro Villanueva-Castro",
  sms_consent_at: "2026-03-04T18:12:00.000Z",
  sms_opt_out: false,
  primary_phone: "(312) 555-1000",
  // Added by the handler, not the RPC — see portalGetClient.
  skip_billable_pct: 50,
  // Same: read from organizations by the handler. 48 is the column default.
  reclean_window_hours: 48,
};

/** A street long enough to wrap on a 360px phone, and a unit number, which is
 *  the pair that overflows an address row. Invented. */
const STREET = "18847 Northwood Meadowbrook Terrace Extension, Unit 12B";

export const PORTAL_UPCOMING_VISITS = [0, 2, 9, 16].map((offset, i) => ({
  visit_id: `eeeeeeee-0000-4000-8000-00000000e0${String(i + 1).padStart(2, "0")}`,
  scheduled_on: day(offset),
  status: i === 0 ? "in_progress" : "scheduled",
  street: STREET,
  city: "Ridgefield Heights",
  postal_code: "60614",
}));

export const PORTAL_RECENT_VISITS = [-3, -10, -17, -24].map((offset, i) => ({
  visit_id: `ffffffff-0000-4000-8000-00000000f0${String(i + 1).padStart(2, "0")}`,
  scheduled_on: day(offset),
  status: i === 2 ? "skipped" : "completed",
  // Two with photos, two without: the grid and the empty case both get drawn.
  photo_paths: i < 2 ? [`visit-photos/${i}-a.jpg`, `visit-photos/${i}-b.jpg`] : [],
  tech_name: i === 2 ? null : "Alejandro",
  // The RPC has always returned this and the fixture never did, so "Completed
  // at 9:30 AM" was never drawn. The FIRST visit's is relative to the real
  // clock rather than to the frozen day above, because the re-clean window is
  // measured against the browser's now: six hours ago is inside a 48-hour
  // guarantee, so the "Request a re-clean" row is on the page being measured.
  // The rest are weeks old and outside it, which is the other layout.
  completed_at:
    i === 2 ? null : i === 0 ? new Date(Date.now() - 6 * 3600e3).toISOString() : stamp(offset),
}));

/** The RPC's rows are only half of what the handler returns: it merges
 *  `due_on` and applied credit from the invoices table, computes what is still
 *  owed, and wraps the list in a summary. A bare array renders "No invoices
 *  yet" -- the shape the page reads is `{ invoices, openCount, ... }`. */
const INVOICE_ROWS = [
  {
    invoice_id: "99999999-0000-4000-8000-000000009001",
    status: "open",
    kind: "recurring",
    total_cents: 10400,
    issued_at: stamp(-4),
    period_start: day(-34),
    period_end: day(-4),
    due_on: day(-2),
    credit_applied_cents: 0,
    amount_due_cents: 10400,
    overdue: true,
  },
  {
    invoice_id: "99999999-0000-4000-8000-000000009002",
    status: "paid",
    kind: "recurring",
    total_cents: 9600,
    issued_at: stamp(-34),
    period_start: day(-64),
    period_end: day(-34),
    due_on: day(-32),
    credit_applied_cents: 2500,
    amount_due_cents: 0,
    overdue: false,
  },
  {
    invoice_id: "99999999-0000-4000-8000-000000009003",
    status: "void",
    kind: "one_time",
    total_cents: 4500,
    issued_at: stamp(-64),
    period_start: null,
    period_end: null,
    due_on: null,
    credit_applied_cents: 0,
    amount_due_cents: 0,
    overdue: false,
  },
];

export const PORTAL_INVOICES = {
  invoices: INVOICE_ROWS,
  openCount: 1,
  openTotalCents: 10400,
  // One of the two is overdue on purpose: the overdue pill and the plain due
  // date are different layouts and only one of them was ever going to be seen.
  overdueCount: 1,
  nextDueOn: INVOICE_ROWS[0].due_on,
};

export const PORTAL_SUBS = [
  {
    subscription_id: "77777777-0000-4000-8000-000000007001",
    price_cents: 2400,
    frequency: "weekly",
    property_label: "Back yard and side run",
  },
];

export const PORTAL_ADDON_CATALOG = [
  {
    addon_service_id: "66666666-0000-4000-8000-000000006001",
    code: "deodorize",
    name: "Deodorising treatment",
    description: "A pet-safe enzyme spray over the whole yard after each visit.",
    kind: "recurring",
    unit_price_cents: 900,
    default_frequency: "every_visit",
  },
  {
    addon_service_id: "66666666-0000-4000-8000-000000006002",
    code: "deep-clean",
    name: "Seasonal deep clean",
    description: "A full sweep for the first visit after a winter thaw or a heavy leaf drop.",
    kind: "one_time",
    unit_price_cents: 8500,
    default_frequency: "once",
  },
];

export const PORTAL_CLIENT_ADDONS = [
  {
    addon_subscription_id: "55555555-0000-4000-8000-000000005001",
    addon_service_id: "66666666-0000-4000-8000-000000006001",
    name: "Deodorising treatment",
    frequency: "every_visit",
    price_cents: 900,
    quantity: 1,
    next_charge_on: day(2),
    status: "active",
  },
];

export const PORTAL_DOGS = [
  {
    dog_id: "44444444-0000-4000-8000-000000004001",
    name: "Marzipan",
    breed: "Bernese Mountain Dog",
    weight_class: "large",
    temperament: "friendly",
    notes: "Will follow the technician around the yard the entire time.",
  },
  {
    dog_id: "44444444-0000-4000-8000-000000004002",
    name: "Biscuit",
    breed: "Jack Russell Terrier",
    weight_class: "small",
    temperament: "anxious",
    notes: "Kept indoors during visits.",
  },
];

export const PORTAL_STATIONS = [
  {
    station_id: "33333333-0000-4000-8000-000000003001",
    label: "Back gate",
    location_description: "Beside the gate post, under the awning",
    liner_size: "13 gal",
    capacity_liners: 40,
    last_serviced_on: day(-3),
  },
  {
    station_id: "33333333-0000-4000-8000-000000003002",
    label: "Side run",
    location_description: "Against the fence, third post from the driveway",
    liner_size: "8 gal",
    capacity_liners: 25,
    last_serviced_on: day(-10),
  },
];

/** The codes are the ones `portalReportConcern` actually accepts. Written out
 *  wrong the first time -- "missed_area", "gate" -- and the portal rendered
 *  them raw, because `friendlyCategory` falls through to the code for anything
 *  it does not know. That looked exactly like a bug in the app. It was a bug
 *  in the fixture, and a fixture that invents enum values will keep producing
 *  findings that are not there. */
export const PORTAL_REQUESTS = [
  {
    ticket_id: "22222222-0000-4000-8000-000000002001",
    visit_id: "ffffffff-0000-4000-8000-00000000f001",
    visit_date: day(-3),
    category: "missed_spot",
    message:
      "The strip behind the shed looked like it had been missed — everything else was spotless though.",
    status: "resolved",
    resolution_note: "Re-swept the same afternoon and added a note to the route card.",
    resolved_at: stamp(-2),
    created_at: stamp(-3),
  },
  {
    ticket_id: "22222222-0000-4000-8000-000000002002",
    visit_id: null,
    visit_date: null,
    category: "gate_left_open",
    message: "Could the team use the side gate rather than the back one from now on?",
    status: "open",
    resolution_note: null,
    resolved_at: null,
    created_at: stamp(-1),
  },
];

/** The handler unwraps the RPC's single row, so the page reads an object.
 *  An array here renders "No referral code yet" -- true-looking, and wrong. */
export const PORTAL_REFERRAL = { referral_code: "ANASTASIA-8417" };

export const PORTAL_PROPERTIES = [
  {
    property_id: "11111111-0000-4000-8000-000000001001",
    label: "Home",
    street: STREET,
    city: "Ridgefield Heights",
    postal_code: "60614",
    dog_count: 2,
    frequency: "weekly",
    price_cents: 2400,
  },
];

/**
 * `/pay/i/:token` — the one-off payment link a customer gets in a text.
 *
 * Not part of the portal: no session, no OTP, no nav. Just an invoice and a
 * card field, opened on a phone by someone who was asked for money. It had
 * never been measured in the state that matters, because with no fixture
 * `getPublicInvoice` answers `{ found: false }` and the page renders "This
 * payment link isn't valid" — which lays out fine and proves nothing.
 *
 * camelCase and hand-built, because the handler reshapes the row: `label`,
 * `amountDueCents` net of credit, and the org and client names lifted out of
 * joined rows.
 */
export const PUBLIC_INVOICE = {
  found: true,
  invoice: {
    id: "99999999-0000-4000-8000-000000009001",
    // Five digits: a business well into its second year of invoices.
    label: "INV-10427",
    status: "open",
    currency: "usd",
    subtotalCents: 12900,
    totalCents: 12900,
    // Credit applied, so the "you owe less than the total" layout is the one
    // measured -- it is two lines where the simple case is one.
    creditAppliedCents: 2500,
    amountDueCents: 10400,
    periodStart: day(-34),
    periodEnd: day(-4),
    issuedAt: stamp(-4),
    paidAt: null,
    dueOn: day(-2),
  },
  orgName: PORTAL_ORG_NAME,
  clientName: PORTAL_CLIENT_NAME,
  items: [
    {
      id: "88888888-0000-4000-8000-000000008001",
      description: "Weekly yard service — 4 visits",
      amountCents: 9600,
      quantity: 1,
      unitAmountCents: null,
    },
    {
      id: "88888888-0000-4000-8000-000000008002",
      description: "Deodorising treatment, every visit",
      amountCents: 3600,
      // Itemized, so the pay page draws its "4 × $9.00" line and the sweep
      // measures the taller row rather than only the one-line case.
      quantity: 4,
      unitAmountCents: 900,
    },
    {
      id: "88888888-0000-4000-8000-000000008003",
      // Long on purpose: a line-item row is description against a
      // right-aligned amount, and only a long one pushes on the amount.
      description: "Seasonal deep clean — first visit after the autumn leaf drop, back yard only",
      amountCents: -300,
      quantity: 1,
      unitAmountCents: null,
    },
  ],
};

// ── /q/:token, the quote link ──────────────────────────────────────────────
//
// Same arrival as the pay link: a text or an email, opened on a phone, no
// session. Without a fixture `getPublicQuote` answers `{ found: false }` and
// the page renders "This quote link isn't valid", which lays out fine and
// measures nothing.
//
// Awkward on purpose, as the brief for this page asked:
//   * a business name of 80-odd characters, longer than PORTAL_ORG_NAME,
//     because the document's header is the name and nothing else;
//   * a line description of exactly 60 characters beside a right-aligned
//     amount, which is the row that pushes on its neighbour;
//   * both one-time and recurring lines, so BOTH totals draw -- the simple
//     one-total case is the one that would be measured by accident;
//   * a quantity of 1.5, so the arithmetic line under a description is the
//     long "1.5 × $13.33, one time" rather than "1 × $24.00";
//   * a contact email with nowhere to break, in a button.
//
// Four tokens, four states, because each state draws a different panel under
// the document: the accept form, the signed outcome, the declined outcome and
// the expired notice. camelCase: the handler reshapes the RPC's jsonb.

export const QUOTE_ORG_NAME =
  "Whitfield & Ramirez Yard, Waste and Pet Sanitation Services of Greater Lincoln Square";
/** Exactly 60 characters. */
export const QUOTE_LONG_LINE = "Common-area waste stations, emptied, relined and disinfected";
export const QUOTE_SIGNER = "Genevieve Okonkwo-Castellanos de la Fuente";

export const QUOTE_TOKENS = {
  sent: "dddddddd-0000-4000-8000-00000000d001",
  accepted: "dddddddd-0000-4000-8000-00000000d002",
  declined: "dddddddd-0000-4000-8000-00000000d003",
  expired: "dddddddd-0000-4000-8000-00000000d004",
} as const;

const QUOTE_LINES = [
  { description: QUOTE_LONG_LINE, quantity: 6, unitAmountCents: 450, amountCents: 2700, recurring: true },
  {
    description: "Weekly yard service, two dogs",
    quantity: 1,
    unitAmountCents: 2400,
    amountCents: 2400,
    recurring: true,
  },
  {
    description: "Initial cleanup of a yard not serviced since the spring thaw",
    quantity: 1,
    unitAmountCents: 14500,
    amountCents: 14500,
    recurring: false,
  },
  // 1.5 x 1333 = 1999.5, which the database rounds to 2000.
  { description: "Deodoriser", quantity: 1.5, unitAmountCents: 1333, amountCents: 2000, recurring: false },
];

function publicQuote(status: keyof typeof QUOTE_TOKENS) {
  return {
    found: true,
    quote: {
      label: "Q-10427",
      status,
      title: "Weekly service and common-area stations for the Lakeview Terrace Condominium Association",
      message:
        "Thanks for walking the grounds with me on Tuesday. This covers the courtyard, the east greenway and both dog runs. Stations are emptied on the same visit.",
      validUntil: status === "expired" ? day(-2) : day(30),
      sentAt: stamp(-1),
      acceptedAt: status === "accepted" ? stamp(0) : null,
      acceptedName: status === "accepted" ? QUOTE_SIGNER : null,
      declinedAt: status === "declined" ? stamp(0) : null,
      declineReason:
        status === "declined"
          ? "The board is holding next year's landscaping budget until the spring meeting, so we cannot commit to a recurring service before then."
          : null,
      recipientName: "Lakeview Terrace Condominium Association Board of Managers",
      currency: "usd",
    },
    org: {
      name: QUOTE_ORG_NAME,
      email: "office@whitfieldramirezyardwasteandpetsanitationservices.example.com",
      phone: "+1 (312) 555-0142",
      timezone: "America/Chicago",
    },
    lines: QUOTE_LINES,
    totals: { oneTimeCents: 16500, recurringCents: 5100 },
  };
}

export const PUBLIC_QUOTES: Record<string, ReturnType<typeof publicQuote>> = Object.fromEntries(
  (Object.keys(QUOTE_TOKENS) as Array<keyof typeof QUOTE_TOKENS>).map((s) => [
    QUOTE_TOKENS[s],
    publicQuote(s),
  ]),
);
