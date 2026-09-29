import type { Locator, Page } from "@playwright/test";
import {
  CLIENT_ID,
  LEAD_ID,
  LEAD_NAME,
  LONG_STAFF_NAME,
  ORG_ID,
  REFUND_CLIENT_NAME,
  REFUND_INVOICE_ID,
  QUOTE_ACCEPTED_ID,
  QUOTE_DRAFT_ID,
  QUOTE_PROSPECT_NAME,
} from "./dataset";

/**
 * The authenticated surfaces this sweep measures, and — the important half —
 * the proof that each one actually rendered.
 *
 * ── WHY EVERY SURFACE CARRIES ITS OWN PROOF ───────────────────────────────
 *
 * `every-public-page-at-every-width.spec.ts` explains why `settle()` exists:
 * every assertion in a sweep like this is of the form "nothing is wrong", and
 * on a blank page they are all true. It guards with element and character
 * counts, which is enough when the only way to get a blank page is a crash.
 *
 * Behind `/_authenticated` there is a second way, and it is not blank. An
 * expired session, a stub that stopped matching, a `beforeLoad` that decided
 * this account has no organization — every one of those lands on `/auth` or
 * `/no-workspace`, which are REAL PAGES. They render several hundred elements
 * and a thousand characters of text; they pass a size threshold with room to
 * spare; and they are laid out well, because the public half of this sweep has
 * been measuring them since the day it was written.
 *
 * So a signed-in sweep that only checks "something rendered" is a sweep that
 * can report 80 green assertions about the sign-in page. The count guard is
 * exactly the wrong shape for that failure — it is the same failure the public
 * sweep's comment describes, wearing a login form.
 *
 * Hence: a per-surface locator naming something ONLY THAT PAGE draws, and
 * `expectsData`, a fixture value that can only be on screen if the fixture
 * reached the component. "Users & roles" proves the settings page; "Alejandro
 * Villanueva-Castro" proves its table has rows in it. A page that renders its
 * heading and an empty state passes the first and fails the second, which is
 * the honest outcome — an empty table has no layout to measure.
 */
export type Surface = {
  /** Reads as the test name. */
  id: string;
  path: string;
  /** localStorage keys the route reads at mount to choose a layout. */
  prefs?: Record<string, string>;
  /** Something only this page draws. */
  proof: (page: Page) => Locator;
  /** Human name for the proof, for the failure message. */
  proofLabel: string;
  /** A fixture value that proves data reached the component, not just chrome. */
  expectsData: string;
  /** Open the control that does not exist until somebody opens it. */
  open?: (page: Page) => Promise<void>;
  /** What the `open` step is expected to have put on the screen. */
  opened?: (page: Page) => Locator;
  openedLabel?: string;
};

const CLIENT_DETAIL = `/clients/${CLIENT_ID}`;
const TENANT_DETAIL = `/platform/tenants/${ORG_ID}`;

export const SURFACES: Surface[] = [
  {
    // The account page. Carries the two most consequential controls in the
    // product -- "Ways to sign in" and Delete your account -- and neither had
    // ever been measured at any width, because this surface was not on the
    // list. Both shipped in the last two days.
    id: "/profile",
    path: "/profile",
    proof: (p) => p.getByText("Ways to sign in", { exact: true }).first(),
    proofLabel: 'the "Ways to sign in" card',
    expectsData: "Delete your account",
  },
  {
    // Added 2026-09-29 with calendar feeds. The card draws two rows and, once
    // a link is made, a box holding a 95-character URL and four buttons that
    // have to wrap on a phone. "Create link" on the all-visits row is the
    // open step (the other row needs a confirm), and the URL box is what it
    // has to put on screen. The data proof is the "last read" line, which
    // only draws when the fixture's lastFetchedAt reached the card.
    id: "/profile · calendar link",
    path: "/profile",
    proof: (p) => p.getByText("Calendar feed", { exact: true }).first(),
    proofLabel: 'the "Calendar feed" card',
    expectsData: "Last read by a calendar",
    open: async (p) => {
      await p.getByRole("button", { name: "Create link", exact: true }).first().click();
    },
    opened: (p) => p.getByRole("link", { name: "Add to Google Calendar" }),
    openedLabel: "the new link's buttons",
  },
  {
    id: "/dashboard",
    path: "/dashboard",
    proof: (p) => p.getByText("Today's routes", { exact: false }).first(),
    proofLabel: 'the "Today\'s routes" header block',
    expectsData: "Alejandro Villanueva-Castro",
  },
  {
    id: "/routes · day board",
    path: "/routes",
    prefs: { "routes.viewMode": "board", "routes.range": "today" },
    proof: (p) => p.getByRole("button", { name: "Auto-routing" }),
    proofLabel: "the dispatch toolbar",
    expectsData: "Anastasia Vandermolen-Whitaker",
  },
  {
    // The week view shipped today. CLAUDE.md: "a seven-column week … does not
    // become usable by getting smaller", which is a claim about 360px.
    id: "/routes · week view",
    path: "/routes",
    prefs: { "routes.viewMode": "board", "routes.range": "week" },
    proof: (p) => p.getByText("Lanes", { exact: true }).first(),
    proofLabel: "the week lane strip",
    expectsData: "Alejandro Villanueva-Castro",
  },
  {
    // A floating card. It is invisible to any sweep that measures first paint,
    // and it is 320px of controls over a board — precisely the shape that
    // fails on a 360px viewport.
    id: "/routes · auto-routing card open",
    path: "/routes",
    prefs: { "routes.viewMode": "board", "routes.range": "today" },
    proof: (p) => p.getByRole("button", { name: "Auto-routing" }),
    proofLabel: "the dispatch toolbar",
    expectsData: "Anastasia Vandermolen-Whitaker",
    open: async (p) => {
      await p.getByRole("button", { name: "Auto-routing" }).click();
    },
    opened: (p) => p.getByRole("dialog", { name: "Auto-routing" }),
    openedLabel: "the auto-routing card",
  },
  {
    id: "/clients",
    path: "/clients",
    proof: (p) => p.getByRole("heading", { name: "Clients", exact: true }).first(),
    proofLabel: 'the "Clients" heading',
    expectsData: "Kimberly-Anne Rutherford-Sinclair",
  },
  {
    id: "/clients/:id",
    path: CLIENT_DETAIL,
    proof: (p) => p.getByRole("tab", { name: "Reviews & referrals" }),
    proofLabel: "the nine-tab detail strip",
    expectsData: "Anastasia Vandermolen-Whitaker",
  },
  {
    // Seven address autocomplete fields were wired today; this is the first
    // step of the form that owns one.
    id: "/clients/new",
    path: "/clients/new",
    proof: (p) => p.getByRole("heading", { name: "New client" }).first(),
    proofLabel: 'the "New client" heading',
    expectsData: "Account type",
  },
  {
    // The wizard started from a lead: the "Started from the lead" panel and
    // the existing-client warning inside it sit above the stepper, and both
    // carry a 46-character name. "Account type" alone would pass on the blank
    // wizard, so the proof is the panel only a lead draws.
    id: "/clients/new?fromLead",
    path: `/clients/new?fromLead=${LEAD_ID}`,
    proof: (p) => p.getByText("Started from the lead").first(),
    proofLabel: 'the "Started from the lead" panel',
    expectsData: LEAD_NAME,
  },
  {
    id: "/invoices",
    path: "/invoices",
    proof: (p) => p.getByText("COLLECTED THIS MONTH").first(),
    proofLabel: "the invoice money row",
    expectsData: "Jean-Baptiste Moreau-Lachapelle",
  },
  {
    // Added 2026-09-28 with Refund on the invoice. The proof is the Refund
    // button itself, which only draws for a Stripe payment with money left on
    // it — so a fixture that stopped reaching the payments list fails here
    // rather than measuring the page without its one new control.
    id: "/invoices/:id",
    path: `/invoices/${REFUND_INVOICE_ID}`,
    proof: (p) => p.getByRole("button", { name: "Refund", exact: true }).first(),
    proofLabel: "the Refund button on the card payment",
    expectsData: REFUND_CLIENT_NAME,
  },
  {
    // The dialog, walked to its confirm step: the sentence with the exact
    // dollars and a 39-character name in it, and the button that moves money.
    // A 360px phone is where this has to fit, because that is where the owner
    // is standing when a customer asks for their money back.
    id: "/invoices/:id · refund confirm",
    path: `/invoices/${REFUND_INVOICE_ID}`,
    proof: (p) => p.getByRole("button", { name: "Refund", exact: true }).first(),
    proofLabel: "the Refund button on the card payment",
    expectsData: REFUND_CLIENT_NAME,
    open: async (p) => {
      await p.getByRole("button", { name: "Refund", exact: true }).first().click();
      await p.getByRole("button", { name: "Review refund" }).click();
    },
    opened: (p) => p.getByRole("button", { name: "Refund $147.60" }),
    openedLabel: "the confirm step's Refund $147.60 button",
  },
  {
    id: "/settings/users",
    path: "/settings/users",
    proof: (p) => p.getByRole("heading", { name: "Users & roles" }).first(),
    proofLabel: 'the "Users & roles" heading',
    expectsData: "Marguerite Delacroix-Bennett",
  },
  {
    // The long-value case CLAUDE.md names by hand: a signup URL with nowhere
    // to break, in a box that may or may not let you read the end of it.
    id: "/settings/online-signup",
    path: "/settings/online-signup",
    proof: (p) => p.getByRole("heading", { name: "Online signup" }).first(),
    proofLabel: 'the "Online signup" heading',
    expectsData: "whitfield-ramirez-yard-and-waste-services",
  },
  {
    id: "/settings/scheduling",
    path: "/settings/scheduling",
    proof: (p) => p.getByRole("heading", { name: "Scheduling" }).first(),
    proofLabel: 'the "Scheduling" heading',
    expectsData: "The working day",
  },
  {
    // The owner's side of the calendar card: the access-code switch with the
    // paragraph explaining why it is off, under the same two link rows. The
    // switch only draws for manage_settings, and its label is the proof.
    id: "/settings/scheduling · calendar feeds",
    path: "/settings/scheduling",
    proof: (p) => p.getByText("Include gate codes in technicians' own calendars").first(),
    proofLabel: "the access-code switch",
    expectsData: "Last read by a calendar",
  },
  {
    id: "/my-day",
    path: "/my-day",
    proof: (p) => p.getByText("SAFETY WARNINGS", { exact: false }).first(),
    proofLabel: "a visit card's hazard banner",
    expectsData: "Anastasia Vandermolen-Whitaker",
  },
  {
    id: "/zones",
    path: "/zones",
    proof: (p) => p.getByRole("heading", { name: "Zones" }).first(),
    proofLabel: 'the "Zones" heading',
    expectsData: "Ravenswood Manor / Lincoln Square North",
  },
  {
    id: "/notifications",
    path: "/notifications",
    proof: (p) => p.getByRole("heading", { name: "Alerts" }).first(),
    proofLabel: 'the "Alerts" heading',
    expectsData: "Northbrook Homeowners Association #4471",
  },

  // ── The platform console. A separate shell with its own sidebar, and the
  //    audit's own note says it is desktop-only by intent — which is a claim
  //    about a phone that nobody has ever measured on one.
  {
    id: "/platform/overview",
    path: "/platform/overview",
    proof: (p) => p.getByText("Health of the SaaS at a glance").first(),
    proofLabel: "the overview strapline",
    expectsData: "CONVERSION PIPELINE",
  },
  {
    id: "/platform/tenants",
    path: "/platform/tenants",
    proof: (p) => p.getByText("Every organization on the platform").first(),
    proofLabel: "the tenants strapline",
    expectsData: "Scoopy Doo Waste Removal & Sanitation Cooperative",
  },
  {
    id: "/platform/tenants/:id",
    path: TENANT_DETAIL,
    proof: (p) => p.getByRole("tab", { name: "Audit" }),
    proofLabel: "the tenant tab strip",
    expectsData: "sub_1QxT7HkPmZ3vLd8RaFn2Wq0Bs",
  },
  {
    // The audit-diff view shipped today. It renders before/after values, so
    // it is a page full of opaque ids in narrow columns.
    id: "/platform/tenants/:id · audit diff",
    path: TENANT_DETAIL,
    proof: (p) => p.getByRole("tab", { name: "Audit" }),
    proofLabel: "the tenant tab strip",
    expectsData: "sub_1QxT7HkPmZ3vLd8RaFn2Wq0Bs",
    open: async (p) => {
      await p.getByRole("tab", { name: "Audit" }).click();
    },
    opened: (p) => p.getByText("changed to", { exact: false }).first(),
    openedLabel: "a before/after diff row",
  },
  {
    // Added 2026-08-20. This page was never swept, and it is the one screen
    // where a customer decides to spend money: the plan cards and the paragraph
    // above the card field are the only place the metered AI charge is
    // disclosed before payment. `expectsData` is the allowance line rather than
    // a price, because a card that renders the price and drops the allowance is
    // exactly the regression worth catching.
    id: "/settings/billing",
    path: "/settings/billing",
    proof: (p) => p.getByRole("heading", { name: "Manage subscription" }).first(),
    proofLabel: 'the "Manage subscription" heading',
    expectsData: "750 AI actions",
  },
  {
    // The pager shipped today, and it only exists past row 150.
    id: "/platform/users",
    path: "/platform/users",
    proof: (p) => p.getByText("Global directory across every tenant").first(),
    proofLabel: "the directory strapline",
    expectsData: "of 173 users",
  },
  {
    id: "/platform/plans",
    path: "/platform/plans",
    proof: (p) => p.getByRole("heading", { name: "Plans" }).first(),
    proofLabel: 'the "Plans" heading',
    expectsData: "Enterprise (annual, invoiced)",
  },
  {
    // Eight columns of mostly numbers, two of them money that has to stay
    // readable side by side, and a 37-character client name in the first one.
    // Below md it is cards instead, which is the "dense grids reflow, they do
    // not shrink" rule rather than a nicety -- so this surface measures two
    // different layouts and both need to hold.
    id: "/pricing-drift",
    path: "/pricing-drift",
    proof: (p) => p.getByRole("heading", { name: "Who is off the rate card" }).first(),
    proofLabel: 'the "Who is off the rate card" heading',
    expectsData: "Kimberly-Anne Rutherford-Sinclair",
  },
  {
    // Added 2026-09-28. Until then this page was measured only by the
    // unlisted-route sweep, at two phone widths, with no fixture: it drew its
    // empty state and no "Preview form" button, and its header fit. On a real
    // org it laid out at 495px on a 360px phone. The proof is that button
    // rather than the heading, because the button only exists when the
    // lead-form config reached the page, and without it the header this
    // measures is narrower than the one that ships.
    id: "/leads",
    path: "/leads",
    proof: (p) => p.getByText("Preview form", { exact: true }).first(),
    proofLabel: 'the "Preview form" button, which only draws once the lead-form config arrived',
    expectsData: "genevieve.okonkwo-castellanos@lakeviewterracecondoassociation.example.com",
  },
  {
    // Added 2026-09-28, for the same reason. With no fixture the page threw on
    // a null and the unlisted sweep measured the error boundary; on a real org
    // it laid out at 786px on a 360px phone, and at 768 a half-width card's
    // table pushed it to 1025px. `expectsData` is a zone name because it can
    // only come from the per-zone table, the last of the grids to render.
    id: "/reports",
    path: "/reports",
    proof: (p) => p.getByText("Tech productivity", { exact: true }).first(),
    proofLabel: 'the "Tech productivity" card',
    expectsData: "Uptown / Edgewater Beach Commercial Grounds",
  },
  {
    // Added 2026-09-28 with the page. A week grid is the shape CLAUDE.md names
    // ("a seven-column week ... does not become usable by getting smaller"),
    // so below lg it is one card per person instead, and this surface
    // measures both. `expectsData` is the 46-character name, which only
    // arrives with the week's rows; the proof is a stat that only draws once
    // the sheet has been built from them.
    id: "/timesheets",
    path: "/timesheets",
    proof: (p) => p.getByText("Hours this week", { exact: true }).first(),
    proofLabel: 'the "Hours this week" stat',
    expectsData: LONG_STAFF_NAME,
  },
  {
    // The dialog a forgotten clock-out is fixed from. Opened on the longest
    // name's Saturday, the shift that runs past midnight, so the dialog draws
    // the split-shift wording beside a 46-character title.
    id: "/timesheets · a day opened",
    path: "/timesheets",
    proof: (p) => p.getByText("Hours this week", { exact: true }).first(),
    proofLabel: 'the "Hours this week" stat',
    expectsData: LONG_STAFF_NAME,
    open: async (p) => {
      await p
        .getByRole("button", { name: new RegExp(`^${LONG_STAFF_NAME}, Sat`) })
        .filter({ visible: true })
        .first()
        .click();
    },
    opened: (p) => p.getByText("part of a shift across midnight", { exact: false }).first(),
    openedLabel: "the day dialog's split-shift row",
  },
  {
    // "Add time" for a day nobody clocked: a person picker of long names and
    // four date and time fields in a dialog that has to fit a 360px phone.
    id: "/timesheets · add time",
    path: "/timesheets",
    proof: (p) => p.getByText("Hours this week", { exact: true }).first(),
    proofLabel: 'the "Hours this week" stat',
    expectsData: LONG_STAFF_NAME,
    open: async (p) => {
      await p.getByRole("button", { name: "Add time", exact: true }).click();
    },
    opened: (p) => p.getByRole("dialog", { name: "Add time" }),
    openedLabel: "the Add time dialog",
  },
  {
    // Added 2026-09-28 with customer re-clean requests. Until then the unlisted
    // sweep measured this page's empty state only. A re-clean card puts a
    // sentence and a "Schedule re-clean" button on one row, and that button
    // only draws when a request with its original visit reached the page — so
    // it is the proof, and a 33-character client name is the data.
    id: "/concerns",
    path: "/concerns",
    proof: (p) => p.getByRole("button", { name: "Schedule re-clean" }).first(),
    proofLabel: 'the "Schedule re-clean" button, which only draws on a re-clean request',
    expectsData: "Kimberly-Anne Rutherford-Sinclair",
  },
  {
    // Added 2026-09-29 with extra cleanups from the portal. The row puts the
    // asked-for day and a long street beside Decline and Book it; "Book it"
    // only draws on an open extra-cleanup request, and opening it draws the
    // dialog with the date, the price the office must set (no one-off price
    // in the fixture) and the technician picker.
    id: "/concerns · extra cleanup",
    path: "/concerns",
    proof: (p) => p.getByRole("button", { name: "Book it", exact: true }).first(),
    proofLabel: 'the "Book it" button, which only draws on an extra-cleanup request',
    expectsData: "block party",
    open: async (p) => {
      await p.getByRole("button", { name: "Book it", exact: true }).first().click();
    },
    opened: (p) => p.getByRole("dialog", { name: "Book the extra cleanup" }),
    openedLabel: "the Book the extra cleanup dialog",
  },
  {
    // Added 2026-09-29. The page was only reached by the unlisted sweep and a
    // one-off spec that checks the cards exist. The extra-cleanup card draws
    // only for manage_settings and only once its settings arrived, and its
    // "Needs a price first" line only when the fixture has no price.
    id: "/settings/client-portal",
    path: "/settings/client-portal",
    proof: (p) => p.getByText("Extra cleanups from the portal", { exact: true }).first(),
    proofLabel: 'the "Extra cleanups from the portal" card',
    expectsData: "Needs a price first.",
  },
  {
    // Added 2026-09-28 with quotes. A row puts a label, a status badge and a
    // "not a client yet" note on one line, a 58-character prospect name under
    // it, and both totals beside it. The chips only draw once the list has
    // counted something, and the prospect's name only comes from the fixture.
    id: "/quotes",
    path: "/quotes",
    proof: (p) => p.getByRole("group", { name: "Filter by status" }),
    proofLabel: "the status filter chips",
    expectsData: QUOTE_PROSPECT_NAME,
  },
  {
    // An accepted quote to a prospect: the action row (Convert to client,
    // Copy link, Duplicate), the timeline with the signature, and the
    // document with a 60-character line and both totals. Convert only draws
    // on an accepted, unconverted quote, so it is the proof.
    id: "/quotes/:id · accepted",
    path: `/quotes/${QUOTE_ACCEPTED_ID}`,
    proof: (p) => p.getByRole("button", { name: "Convert to client" }),
    proofLabel: 'the "Convert to client" button',
    expectsData: "Genevieve Okonkwo-Castellanos de la Fuente",
  },
  {
    // A draft opens in the editor: a recipient switch, four line cards each
    // with a quantity, a price, a per-visit box and a remove button, which is
    // the row that has to wrap rather than widen at 320px.
    id: "/quotes/:id · draft",
    path: `/quotes/${QUOTE_DRAFT_ID}`,
    proof: (p) => p.getByRole("button", { name: "Save and send" }),
    proofLabel: 'the editor\'s "Save and send" button',
    expectsData: LEAD_NAME,
  },
];
