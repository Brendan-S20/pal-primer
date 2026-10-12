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
  // A pet-waste plan (20261011160000): no weekday set, the seeded service,
  // so the header chip reads "Weekly · 2 dogs · ..." exactly as before.
  primary_weekdays: null,
  primary_service_name: "Pet waste removal",
  primary_service_line: "pet_waste",
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
    // Taxed, so the row draws "includes $7.93 Sales tax (8.25%)" beside the
    // amount and the status chips, and has to wrap on a phone. 9,607 x 8.25%
    // = 792.58 -> 793; total 10,400.
    tax_cents: 793,
    tax_rate_bps: 825,
    tax_label: "Sales tax",
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
    weekdays: null,
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
  // An extra cleanup already booked, and one still waiting: the row puts a
  // "booked for" day beside the category, which is the widest title the list
  // draws, and the badge says Booked rather than Resolved.
  {
    ticket_id: "22222222-0000-4000-8000-000000002003",
    visit_id: null,
    visit_date: null,
    category: "one_off_request",
    message: "Having thirty people over for my daughter's graduation on Saturday afternoon.",
    status: "resolved",
    resolution_note: "Booked for Fri, Sep 4.",
    resolved_at: stamp(-1),
    created_at: stamp(-2),
    requested_on: day(7),
    booked_on: day(7),
    // A request for one of the business's services reads as that service,
    // and this is the longest name the catalog fixture has, beside the
    // "booked for" day: the widest title the list draws.
    service_name: "30-minute neighbourhood walk with a long-ish name",
  },
  {
    ticket_id: "22222222-0000-4000-8000-000000002004",
    visit_id: null,
    visit_date: null,
    category: "one_off_request",
    message: null,
    status: "open",
    resolution_note: null,
    resolved_at: null,
    created_at: stamp(0),
    requested_on: day(12),
    booked_on: null,
    // The extra cleanup: no service, so it still reads "Extra visit".
    service_name: null,
  },
];

/**
 * `portalOneOffBookingOptions`, the extra-cleanup card on Requests. Two
 * properties, so the "Where" picker draws beside the day picker -- the wider
 * of the card's two layouts -- and the longest street in the dataset in it. A
 * price, so the sentence above the pickers is its longer form. Weekdays only,
 * from the fixture's tomorrow through 30 days, as the server would send.
 */
const WEEKDAYS_AHEAD = Array.from({ length: 30 }, (_, i) => day(i + 1)).filter((d) => {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
});
export const PORTAL_ONE_OFF_OPTIONS = {
  today: day(0),
  days: WEEKDAYS_AHEAD,
  properties: [
    { id: "11111111-0000-4000-8000-000000001001", label: "Home", street: STREET, city: "Ridgefield Heights" },
    {
      id: "11111111-0000-4000-8000-000000001002",
      label: "Lake house",
      street: "4 Old Mill Pond Road West",
      city: "Wauconda Harbor",
    },
  ],
  autoAccept: false,
  priceCents: 4500,
  // The business's bookable services (phase 5): the extra cleanup at the
  // one-off price, and a walk at its own, so the card draws its "What".
  services: [
    {
      id: "55555555-0000-4000-8000-000000000001",
      name: "Pet waste removal",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: null,
      priceCents: 4500,
      perExtraPetCents: 0,
      petWaste: true,
    },
    {
      id: "55555555-0000-4000-8000-000000000002",
      name: "30-minute neighbourhood walk with a long-ish name",
      price_unit: "visit",
      base_price_cents: 2500,
      extra_pet_cents: 500,
      default_duration_min: 30,
      priceCents: 2500,
      perExtraPetCents: 500,
      petWaste: false,
    },
  ],
  petsByProperty: {
    "11111111-0000-4000-8000-000000001001": 2,
    "11111111-0000-4000-8000-000000001002": 1,
  },
  currency: "usd",
};

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
    // Taxed, so the pay link draws its sales-tax line: 11,917 x 8.25% =
    // 983.15 -> 983. The total, the credit and the amount due are unchanged,
    // so the tip arithmetic the spec checks (104.00 + 7.50) still holds.
    subtotalCents: 11917,
    taxCents: 983,
    taxRateBps: 825,
    taxLabel: "Sales tax",
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
      // 8,617 + 3,600 - 300 = 11,917, the taxed subtotal, so the lines, the
      // tax and the total on the page all add up.
      amountCents: 8617,
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

/**
 * The intent the pay link's form is built on, with tipping ON: without it
 * `createPublicInvoicePaymentIntent` answers nothing, the payment card stays
 * on "Preparing secure payment…", and the tip choices -- five buttons in a
 * grid, the tallest thing in the card -- are never drawn or measured.
 *
 * `dueCents` is the invoice's amount due, the figure the percentages are
 * taken of, so the 15% button reads $15.60. The client secret is shaped like
 * Stripe's and points at nothing: the network fence answers Stripe.js with
 * an empty script, so the card field itself never mounts.
 */
export const PUBLIC_INVOICE_INTENT = {
  clientSecret: "pi_3QyTipFixture000000000_secret_fixture00000000000",
  publishableKey: "pk_test_fixture_not_a_real_key",
  stripeAccount: "acct_1FixtureNotReal0",
  amountCents: PUBLIC_INVOICE.invoice.amountDueCents,
  dueCents: PUBLIC_INVOICE.invoice.amountDueCents,
  tipCents: 0,
  tipsEnabled: true,
  currency: "usd",
};

/** The portal's pay screen, on the one open invoice ($104.00 due). */
export const PORTAL_PAY_INVOICE_ID = INVOICE_ROWS[0].invoice_id;
export const PORTAL_INVOICE_INTENT = {
  ...PUBLIC_INVOICE_INTENT,
  amountCents: INVOICE_ROWS[0].amount_due_cents,
  dueCents: INVOICE_ROWS[0].amount_due_cents,
  invoiceId: PORTAL_PAY_INVOICE_ID,
  businessName: PORTAL_CLIENT_NAME,
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
      // A deposit on every state, so the notice before accepting and the Pay
      // button after it are both on a page the sweep measures.
      depositCents: 150000,
      depositPayUrl:
        status === "accepted"
          ? "https://app.houndstack.com/pay/i/eeeeeeee-0000-4000-8000-00000000d002"
          : null,
      depositPaid: false,
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

// ── /track/:token, the live map in the "on my way" text ────────────────────
//
// The SAME shape getPublicTracking returns (publicTrackingView in
// src/lib/live-tracking.ts), not the SQL function's snake_case: the stub
// answers the server function, and a fixture in the database's shape would
// render "This tracking link isn't valid" and measure that.
//
// The long business name is the one the quote link uses, 85 characters, in a
// heading at 320px. The tech's name is long on purpose too, because it sits in
// the headline AND in the legend beside a dot. Positions are already rounded
// to 3 places, as the page is always handed them.
export const TRACKING_ORG_NAME = QUOTE_ORG_NAME;
export const TRACKING_TECH_NAME = "Maximiliano";

export const TRACKING_TOKENS = {
  en_route: "eeeeeeee-0000-4000-8000-00000000e001",
  en_route_unshared: "eeeeeeee-0000-4000-8000-00000000e002",
  arrived: "eeeeeeee-0000-4000-8000-00000000e003",
  done: "eeeeeeee-0000-4000-8000-00000000e004",
  ended: "eeeeeeee-0000-4000-8000-00000000e005",
} as const;

function publicTracking(state: keyof typeof TRACKING_TOKENS) {
  const enRoute = state === "en_route" || state === "en_route_unshared";
  return {
    found: true as const,
    status: (enRoute ? "en_route" : state) as "en_route" | "arrived" | "done" | "ended",
    businessName: TRACKING_ORG_NAME,
    techName: TRACKING_TECH_NAME,
    eta: enRoute ? "between 10:15 AM and 10:45 AM" : null,
    tech:
      state === "en_route"
        ? { lat: 41.91, lng: -87.65, recordedAt: new Date(Date.now() - 90_000).toISOString() }
        : null,
    home: enRoute ? { lat: 41.922, lng: -87.648 } : null,
  };
}

export const PUBLIC_TRACKING: Record<string, ReturnType<typeof publicTracking>> = Object.fromEntries(
  (Object.keys(TRACKING_TOKENS) as Array<keyof typeof TRACKING_TOKENS>).map((s) => [
    TRACKING_TOKENS[s],
    publicTracking(s),
  ]),
);

// ── /signup/:slug, the public signup, with first-cleanup tiers ─────────────
//
// The business prices the first cleanup by "when was your yard last
// cleaned?", so the page draws a fourth question in the service card and a
// first-cleanup line in the quote panel beside the per-visit price. The last
// answer is long on purpose: it is the label a Select trigger and the quote
// panel's "Last cleaned:" line both have to hold at 320px. Wording like this
// is the owner's to choose, and an owner will choose a sentence.

export const SIGNUP_LONG_TIER_LABEL = "Three months or more, or honestly never since we moved in";

const SIGNUP_TIERS = [
  { id: "within_a_week", label: "Within a week", price_cents: 4500 },
  { id: "one_to_four_weeks", label: "1–4 weeks", price_cents: 7500 },
  { id: "one_to_three_months", label: "1–3 months", price_cents: 11000 },
  { id: "three_months_or_never", label: SIGNUP_LONG_TIER_LABEL, price_cents: 15000 },
];

/** `getPublicSignupForm`: the business, its branding, the form's own
 *  settings (none customised here, so the page draws its defaults), whether
 *  "Start service" is on offer, and the first-cleanup answers. */
export const SIGNUP_FORM = {
  id: PORTAL_ORG_ID,
  name: PORTAL_ORG_NAME,
  currency: "usd",
  logoUrl: null,
  brandColor: null,
  resolvedSlug: PORTAL_SLUG,
  instantStart: true,
  form: {
    brandColor: null,
    logoUrl: null,
    headline: "",
    intro: "",
    confirmation: "",
    fields: { phone: true, location: true, dogCount: true, message: true },
  },
  firstCleanup: {
    mode: "by_last_cleaned",
    tiers: SIGNUP_TIERS.map(({ id, label }) => ({ id, label })),
  },
};

// ── The same form for a business that only wants leads ─────────────────────
//
// Online signup switched off: no price, no card, one "Request a quote"
// button. The owner has written their own headline and confirmation, and an
// owner writes a sentence, so both are long: the headline is the h1 a 320px
// phone has to wrap, the confirmation the card a sent request leaves behind.

export const QUOTE_ONLY_SLUG = "ravenswood-manor-quotes-only-please-call-first";
export const QUOTE_ONLY_HEADLINE =
  "Request your free, no-obligation quote for weekly pet waste removal in Ravenswood Manor";
export const QUOTE_ONLY_CONFIRMATION =
  "Thank you! Marisol or Dev will call you within one business day to walk your yard and confirm your price.";

export const SIGNUP_FORM_QUOTE_ONLY = {
  ...SIGNUP_FORM,
  resolvedSlug: QUOTE_ONLY_SLUG,
  instantStart: false,
  form: {
    ...SIGNUP_FORM.form,
    headline: QUOTE_ONLY_HEADLINE,
    confirmation: QUOTE_ONLY_CONFIRMATION,
  },
  firstCleanup: { mode: "off", tiers: [] as Array<{ id: string; label: string }> },
};

/** A ZIP the business has no zone for: the instant page turns into a quote
 *  request rather than a dead end. */
export const NO_ZONE_ZIP = "99501";

/** `getSignupQuote` for one dog: every answer priced for this yard, and the
 *  answer the sweep picks priced into `initial_cleanup_cents`. */
export function signupQuote(lastCleaned: string | undefined) {
  const picked = SIGNUP_TIERS.find((t) => t.id === lastCleaned) ?? null;
  return {
    available: true as const,
    quote: {
      organization_id: PORTAL_ORG_ID,
      zone_id: "dddddddd-0000-4000-8000-00000000d0f1",
      zone_name: "Ravenswood Manor / Lincoln Square North",
      base_price_cents: 2500,
      per_dog_addl_cents: 500,
      recurring_price_cents: 2500,
      initial_cleanup_cents: picked ? picked.price_cents : null,
      currency: "usd",
      first_cleanup_mode: "by_last_cleaned",
      first_cleanup_label: picked?.label ?? null,
      first_cleanup_options: SIGNUP_TIERS.map((t) => ({
        id: t.id,
        label: t.label,
        priceCents: t.price_cents,
      })),
    },
  };
}
