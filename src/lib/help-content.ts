// Feature 3: Knowledge Center content. Articles are deliberately short and
// plain-language, written from the exact confusion points persona QA hit:
// nav jargon (zones, skip rules, blackouts, DNA, royalties, churn score), the
// "Generate invoices → 0 generated" dead end, and add-on setup. Sections
// mirror the Settings groupings so the taxonomy is one users already know.

export type HelpArticle = {
  slug: string;
  title: string;
  section: string;
  /** Which roles this is most relevant to (shown as a chip, never hides content). */
  audience?: string;
  /** Plain paragraphs. Keep each one short. */
  body: string[];
};

export const HELP_SECTIONS = [
  "Getting started",
  "Business setup",
  "Customer-facing",
  "Communications",
  "Financial",
  "Team",
  "In the field",
] as const;

export const HELP_ARTICLES: HelpArticle[] = [
  // ── Getting started ────────────────────────────────────────────────────────
  {
    slug: "tour",
    title: "Take the guided tour",
    section: "Getting started",
    body: [
      "The first time you sign in, HoundStack walks you through the main areas of the app with a short guided tour. You can skip it at any step.",
      "Want to see it again? Use the button below the article list on this page. The tour restarts from the beginning.",
    ],
  },
  {
    slug: "checklist",
    title: 'The "Get started" checklist',
    section: "Getting started",
    body: [
      "The dashboard checklist tracks what's left to configure: verifying your email, creating zones, adding staff and clients, planning a first route, and setting up billing.",
      "It's different from the guided tour: the tour explains what things are, the checklist tracks what's left to set up. Dismiss it once you're rolling; it won't nag you again.",
    ],
  },
  {
    slug: "roles",
    title: "What each role can see and do",
    section: "Getting started",
    body: [
      "Owner: everything, including billing and payouts. Office manager: day-to-day operations (clients, invoices, routes, settings) but not the business's own subscription billing. Dispatcher: scheduling, routes, weather, and the client directory. Technician: My Day, the waste log, and field tools.",
      "If someone can't see a page you expect them to, their role is usually why. Roles are set in Settings → Users & roles.",
    ],
  },
  // ── Business setup ─────────────────────────────────────────────────────────
  {
    slug: "zones",
    title: "Zones: what they are and why they matter",
    section: "Business setup",
    body: [
      "A zone is a service area: a neighborhood, a ZIP-code prefix, a side of town. Every client property belongs to a zone.",
      "Zones drive almost everything geographic: routes are planned per zone, the weather page forecasts per zone, and reports can break revenue down by zone. Give each zone coordinates (or a postal prefix) so maps and forecasts work.",
      "Rule of thumb: one zone per area a tech can comfortably cover in a day.",
    ],
  },
  {
    slug: "skip-rules",
    title: "Skip rules: when a visit doesn't happen",
    section: "Business setup",
    body: [
      "A skip is a scheduled visit that doesn't happen: a locked gate, an aggressive dog loose in the yard, a client on vacation.",
      "Skip rules decide what happens to billing when a visit is skipped: some reasons still charge the client (you showed up, the gate was locked), others don't (you cancelled for weather).",
      "Set the defaults in Settings → Skip rules; techs pick a reason when they skip, and billing follows your rule automatically.",
    ],
  },
  {
    slug: "blackouts",
    title: "Blackout dates",
    section: "Business setup",
    body: [
      "Blackout dates are days your business doesn't operate: holidays, company events. No visits get auto-scheduled on a blackout date, and anything that would have landed there shifts.",
      "Set them in Settings → Blackouts before the holiday sneaks up on the schedule.",
    ],
  },
  {
    slug: "add-ons",
    title: "Add-on services (and billing them from the field)",
    section: "Business setup",
    body: [
      "Add-ons are extra billable services on top of the regular cleanup: haul-away, deodorizer, deck scrub. Define them with a price in Settings → Add-ons.",
      "Techs can bill an add-on mid-visit from My Day: the charge is capped per-visit (Settings → Preferences), the office sees every field charge for review, and prepaid clients are debited from credit while postpaid clients see it on the next invoice.",
      "If the Bill button in the field says there's nothing to bill, the add-on catalog is empty. Add services first.",
    ],
  },
  {
    slug: "deep-clean",
    title: "Seasonal deep cleans",
    section: "Business setup",
    body: [
      "A deep clean is a bigger, seasonal cleanup (typically spring) billed at a premium over the regular visit. Turn on seasonal deep cleans in Settings → Deep-clean, pick the months and the extra charge, and qualifying visits get flagged and billed automatically.",
    ],
  },
  // ── Customer-facing ────────────────────────────────────────────────────────
  {
    slug: "lead-form",
    title: "The lead form: your embeddable quote page",
    section: "Customer-facing",
    body: [
      "The lead form is a public page (and embeddable widget) where prospects request service. It collects their address, dog count, and frequency, and drops them into your Leads list.",
      "Customize the fields and branding in Settings → Lead form, then link it from your website or ads.",
    ],
  },
  {
    slug: "client-portal",
    title: "The client portal",
    section: "Customer-facing",
    body: [
      "Every client gets a private portal link where they can see upcoming visits, pay invoices, save a card, put service on hold, and refer neighbors.",
      "Clients sign in with a one-time code sent by email (or text, when texting is configured). If a client can't get their code, staff can read one to them over the phone from the client's detail page.",
    ],
  },
  {
    slug: "refer-a-business",
    title: "Refer a business: earn cash for referrals",
    section: "Customer-facing",
    body: [
      "Know another pet-service business that could use HoundStack? Share your referral link from Settings → Refer a business.",
      "When a business signs up through your link and becomes a paying customer, you earn a percentage of their first payment, paid out in cash after they've stayed active through a short holding period. Progress shows on the same page.",
    ],
  },
  // ── Communications ─────────────────────────────────────────────────────────
  {
    slug: "churn-score",
    title: "Churn score: who's at risk of leaving",
    section: "Communications",
    body: [
      "The churn score (0–100) estimates how likely a client is to cancel, based on signals like skipped visits, unpaid invoices, complaints, and how long since they signed up. Higher = more at risk.",
      'Clients at 60+ show an "at risk" badge. The AI churn panel on the Clients page suggests who to check in with. A quick call or a small credit often saves the account.',
    ],
  },
  {
    slug: "ai-tools",
    title: "Where the AI tools live",
    section: "Communications",
    body: [
      "AI tools are embedded where they're useful, not on a separate page: review-reply suggestions on Settings → Reviews, churn risk on Clients, dispatch suggestions on Routes, zone pricing on Zones, and the weekly digest + marketing content on the Dashboard.",
      "They're bring-your-own-key: add your Anthropic or OpenAI API key once in Settings → AI Tools and every panel uses it.",
    ],
  },
  // ── Financial ──────────────────────────────────────────────────────────────
  {
    slug: "generate-invoices",
    title: '"Generate from visits" vs. "New invoice"',
    section: "Financial",
    body: [
      "Generate from visits bills completed, not-yet-billed visits. It's the batch button for your regular cadence. If it says it generated 0 invoices, that means there were no completed unbilled visits in the window, not that something failed.",
      'New invoice is the direct route: pick a client, add line items, bill immediately. Use it for one-off jobs that never went through the schedule: "I did the work, now I bill."',
    ],
  },
  {
    slug: "payments-vs-billing",
    title: "Payments vs. Billing: two different money pages",
    section: "Financial",
    body: [
      "Payments (in the sidebar) is money coming in from your clients: your Stripe account, balances, payouts to your bank, and saved client cards.",
      "Billing (in Settings) is money going out to HoundStack: your own subscription plan for using the software.",
      'If clients say their saved card stopped working after you reconnected a different Stripe account, use "Check saved client cards" on the Payments page. It finds affected clients and prompts them to re-add a card.',
    ],
  },
  {
    slug: "credit-balance",
    title: "Account credit vs. amount owed",
    section: "Financial",
    body: [
      "A client's credit is money on their account (referral rewards, prepayments, goodwill credits) that automatically offsets future charges.",
      "An open invoice is what they currently owe. A client can have $0 credit and a $125 open invoice at the same time. The two numbers answer different questions.",
    ],
  },
  {
    slug: "royalties",
    title: "Royalties: for multi-brand operators",
    section: "Financial",
    body: [
      "The Royalties page applies if separate businesses pay you a percentage of their revenue (a franchise-style arrangement). It calculates and invoices those royalty fees across linked organizations.",
      "Running a single location? You can ignore this page entirely. Full multi-location management (shared staff, cross-location reporting) is on the roadmap.",
    ],
  },
  // ── Team ───────────────────────────────────────────────────────────────────
  {
    slug: "users-roles",
    title: "Inviting your team and setting roles",
    section: "Team",
    body: [
      'Invite teammates from Settings → Users & roles. Each person gets a role (see "What each role can see and do") that controls their access.',
      'Per-technician routing controls live in each user\'s "Routing & addresses" panel: availability for routes, daily capacity, and route start/end addresses. Plans are priced per active seat, so deactivating someone frees their seat.',
    ],
  },
  // ── In the field ───────────────────────────────────────────────────────────
  {
    slug: "my-day",
    title: "My Day: the technician's home screen",
    section: "In the field",
    audience: "Technicians",
    body: [
      "My Day lists the visits assigned to you for the day, in route order, with one-tap directions, start/complete buttons, photo capture, skip (with a reason), and add-on billing.",
      'Complete visits as you finish them. Completed visits are what invoicing runs on. A visit left "in progress" overnight shows up in the office\'s stuck-visit count.',
    ],
  },
  {
    slug: "waste-log",
    title: "The waste log and disposal manifests",
    section: "In the field",
    audience: "Technicians",
    body: [
      'Many jurisdictions require records of commercial pet-waste disposal. The waste log is that record: each "dump" entry (a disposal manifest) captures the facility, date, weight, bags, ticket number, and an optional receipt photo.',
      "Log a dump every time you unload at a disposal facility. Facilities are saved with a one-tap Directions link.",
    ],
  },
  {
    slug: "dna",
    title: "DNA compliance",
    section: "In the field",
    body: [
      "Some HOAs and municipalities run dog-DNA programs: unscooped waste is tested and matched to a registered dog. The DNA page tracks samples and matches for properties enrolled in such a program.",
      "Not in a DNA program? You can ignore this page.",
    ],
  },
];

export function getArticle(slug: string | undefined): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}
