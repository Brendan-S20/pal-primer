// Knowledge Center content. Articles are short and plain-language, written
// from the confusion points persona QA hit. Sections mirror the Settings
// groupings so the taxonomy is one users already know.
//
// Body/step text supports two inline link forms rendered by /help:
//   [label](article:slug)  -> internal link to another article
//   [label](/app/path)     -> link to a page in the app
// plus **bold**. Keep paragraphs short.

export type HelpArticle = {
  slug: string;
  title: string;
  section: string;
  /** Which roles this is most relevant to (shown as a chip, never hides content). */
  audience?: string;
  /** Plain paragraphs (inline links + bold supported). */
  body: string[];
  /** Optional numbered walkthrough rendered as "Step-by-step". */
  steps?: string[];
  /** Optional deep link into the app ("Open Zones"). */
  appLink?: { to: string; label: string };
  /** Slugs of related articles, rendered as chips at the bottom. */
  related?: string[];
};

export const HELP_SECTIONS = [
  "Getting started",
  "Business setup",
  "Client-facing",
  "Communications",
  "Financial",
  "Team",
  "In the field",
] as const;

export const HELP_ARTICLES: HelpArticle[] = [
  // ── Getting started ────────────────────────────────────────────────────────
  {
    slug: "first-30-minutes",
    title: "Your first 30 minutes: from empty account to a scheduled, billable week",
    section: "Getting started",
    body: [
      "The fastest path from a fresh account to a working day is the [guided setup](article:tour): six short steps, each done in place, and the [Get started checklist](article:checklist) on your dashboard tracks the same six. In order:",
    ],
    steps: [
      "Your business details: the address your routes start from, and the time zone that decides what counts as today.",
      "Your service area and price: where you work and what you charge per visit. New clients in the area are quoted that price. Draw more areas later in [Zones](/zones); see [Zones: what they are](article:zones).",
      "Your first client: one at a time from [Clients](/clients), or everything at once with [Import](article:import-clients).",
      "Who runs the route: say that you do, or invite a tech in [Users & roles](/settings/users). See [What each role can see and do](article:roles).",
      "Where the day ends: your dump site, so routes finish there instead of wherever the last stop happens to be.",
      "Get paid: connect payouts in [Payments](/payments) so invoices are payable online. See [Getting paid](article:getting-paid).",
    ],
    appLink: { to: "/setup", label: "Open the guided setup" },
    related: ["checklist", "tour", "import-clients", "routes-planning", "getting-paid"],
  },
  {
    slug: "tour",
    title: "The guided setup",
    section: "Getting started",
    body: [
      "The first time an owner signs in, a bar at the top of the page offers to set the business up in six short steps. Each step is done right there: you type the address, set the price, add a client. Nothing is a slideshow.",
      "Every step can be skipped and finished later. Leave in the middle and the bar takes you back to the step you were on, on any page and after a reload. Choose Not now and it goes away; open it again from the dashboard checklist or with the button below the article list on this page.",
    ],
    appLink: { to: "/setup", label: "Open the guided setup" },
    related: ["first-30-minutes", "checklist"],
  },
  {
    slug: "checklist",
    title: 'The "Get started" checklist',
    section: "Getting started",
    body: [
      "The [dashboard](/dashboard) checklist lists the same six steps as the [guided setup](article:tour) and ticks each one off as it is done: business details, service area and price, first client, who runs the route, where the day ends, and payouts.",
      "Guide me opens the guided setup at the first step still open. Dismiss the checklist once you're rolling; it won't nag you again.",
    ],
    related: ["first-30-minutes", "tour"],
  },
  {
    slug: "roles",
    title: "What each role can see and do",
    section: "Getting started",
    body: [
      "**Owner:** everything, including billing and payouts. **Office manager:** day-to-day operations (clients, invoices, routes, settings) but not the business's own subscription billing. **Dispatcher:** the schedule, routes, weather, clients, and messages. A dispatcher books one-off visits and grooms at the prices the business has set; only an owner or office manager can change a price. A dispatcher can add a client and start their plan at the set price, move a visit to another day or another technician, and text a client. Completing or canceling a visit from the office, invoices and payments, prices, settings, and who has access stay with the owner and office manager. **Technician:** [My Day](article:my-day), the [waste log](article:waste-log), and field tools.",
      "If someone can't see a page you expect them to, their role is usually why. Roles are set in [Users & roles](/settings/users).",
    ],
    appLink: { to: "/settings/users", label: "Open Users & roles" },
    related: ["users-roles", "my-day"],
  },
  {
    slug: "import-clients",
    title: "Import your clients from another system",
    section: "Getting started",
    body: [
      "Moving from Jobber, a spreadsheet, or another tool? The importer takes a CSV and creates clients, properties, and dogs in one pass.",
      "Import **clients first**. Properties and dogs link back to a client by its external id from the original system.",
    ],
    steps: [
      "Export a CSV from your old system (the [Import](/imports) page has per-source instructions and a template you can download).",
      "On [Import](/imports), pick the source and entity, then choose your CSV file.",
      "Review the preview: every row shows whether it will be created, updated, or skipped, with the reason.",
      "Commit the import. If your subscription doesn't allow new clients, you'll be told once up front, before anything is written.",
      "Spot-check a few clients in [Clients](/clients), then repeat for properties and dogs if you have them.",
    ],
    appLink: { to: "/imports", label: "Open Import" },
    related: ["first-30-minutes", "zones"],
  },
  // ── Business setup ─────────────────────────────────────────────────────────
  {
    slug: "zones",
    title: "Zones: what they are and why they matter",
    section: "Business setup",
    body: [
      "A zone is a service area: a neighborhood, a ZIP-code prefix, a side of town. Every client property belongs to a zone.",
      "Zones drive almost everything geographic: [routes](article:routes-planning) are planned per zone, the [weather forecast](article:weather) in the header covers each zone, and reports can break revenue down by zone. Give each zone coordinates (or a postal prefix) so maps and forecasts work.",
      "Rule of thumb: one zone per area a tech can comfortably cover in a day.",
    ],
    appLink: { to: "/zones", label: "Open Zones" },
    related: ["routes-planning", "weather", "first-30-minutes"],
  },
  {
    slug: "routes-planning",
    title: "Plan your first routes",
    section: "Business setup",
    body: [
      "Routes turn scheduled visits into an ordered day for each tech. Week and month show the calendar beside the map, with each technician in their own color in both. Hover a visit for who is running it, where, and its status. Today shows a drag-and-drop board with a column per tech.",
      'Only people set to run routes appear here. If someone is missing, turn on "Runs routes" for them in [Users & roles](/settings/users).',
    ],
    steps: [
      "Open the [Schedule](/routes) and pick Today, Week, or Month.",
      "In week or month, filter by type, team or status to narrow both the calendar and the map at once.",
      "Unassigned visits appear grouped by zone. Drag them onto a tech, or use auto-assign to balance by capacity.",
      "Drag within a tech's column to set the drive order. Directions links use the property's address or coordinates.",
      "Check the [weather forecast](article:weather) (the cloud icon in the header) for risky days; the weather check on Routes can move flagged visits off a storm day in one click.",
      "Techs see the final order on [My Day](article:my-day) the moment you're done.",
      "Workday hours, work days and travel assumptions are set once in [Settings → Scheduling](/settings/scheduling), not on the routes screen.",
    ],
    // The button says "Schedule" because that is what the page is called in the
    // sidebar and in the mobile tab bar. Help that sends someone to look for
    // "Routes" in a nav that says "Schedule" is help that costs a support
    // ticket. The `to` is untouched — the URL is an implementation detail
    // nobody reads, and renaming it would break every link and test built on it
    // for no gain a customer can perceive.
    appLink: { to: "/routes", label: "Open Schedule" },
    related: ["zones", "weather", "my-day"],
  },
  {
    slug: "weather",
    title: "Weather and rescheduling",
    section: "Business setup",
    body: [
      "The cloud icon in the top bar opens this week's forecast for your main service areas. Nearby [zones](article:zones) are grouped into one card, and risky days (heavy rain, high wind, storms, hard freezes) are highlighted so you can spot trouble at a glance.",
      "To act on a risky day, open the [Schedule](/routes): the weather check there flags at-risk visits and can move them to a safe day. Clients can get an automatic weather-reschedule email when their visit moves.",
      "Forecasts are cached, so if the weather service is briefly unavailable you'll see the last saved forecast instead of an error.",
    ],
    // Same page, same name as the nav gives it. See routes-planning above.
    appLink: { to: "/routes", label: "Open Schedule" },
    related: ["zones", "routes-planning", "blackouts"],
  },
  {
    slug: "skip-rules",
    title: "Skip rules: when a visit doesn't happen",
    section: "Business setup",
    body: [
      "A skip is a scheduled visit that doesn't happen: a locked gate, an aggressive dog loose in the yard, a client on vacation.",
      "Skip rules decide what happens to billing when a visit is skipped: some reasons still charge the client (you showed up, the gate was locked), others don't (you canceled for weather).",
      "Set the defaults in [Skip rules](/settings/skip-rules); techs pick a reason when they skip on [My Day](article:my-day), and billing follows your rule automatically.",
    ],
    appLink: { to: "/settings/skip-rules", label: "Open Skip rules" },
    related: ["my-day", "generate-invoices"],
  },
  {
    slug: "blackouts",
    title: "Blackout dates",
    section: "Business setup",
    body: [
      "Blackout dates are days your business doesn't operate: holidays, company events. No visits get auto-scheduled on a blackout date, and anything that would have landed there shifts.",
      "Set them in [Blackouts](/settings/blackouts) before the holiday sneaks up on the schedule.",
    ],
    appLink: { to: "/settings/blackouts", label: "Open Blackouts" },
    related: ["weather", "routes-planning"],
  },
  {
    slug: "add-ons",
    title: "Add-on services (and billing them from the field)",
    section: "Business setup",
    body: [
      "Add-ons are extra billable services on top of the regular cleanup: haul-away, deodorizer, deck scrub. Define them with a price in [Add-ons](/settings/addons).",
      "Techs can bill an add-on mid-visit from [My Day](article:my-day): the charge is capped per-visit (Settings -> Preferences), the office sees every field charge for review, and prepaid clients are debited from credit while postpaid clients see it on the next invoice.",
      "If the Bill button in the field says there's nothing to bill, the add-on catalog is empty. Add services first.",
    ],
    steps: [
      "Open [Settings -> Add-ons](/settings/addons) and create each service with a name and price.",
      "Set the per-visit field-charge cap in Settings -> Preferences if the default doesn't fit.",
      "On a visit in [My Day](/my-day), a tech taps the add-on panel, picks the service and quantity, and confirms the charge.",
      "Review field charges from the office; they land on the client's next invoice (or debit prepaid credit immediately).",
    ],
    appLink: { to: "/settings/addons", label: "Open Add-ons" },
    related: ["my-day", "generate-invoices", "platform-addons"],
  },
  {
    slug: "deep-clean",
    title: "Seasonal deep cleans",
    section: "Business setup",
    body: [
      "A deep clean is a bigger, seasonal cleanup (typically spring) billed at a premium over the regular visit. Turn on seasonal deep cleans in [Deep-clean](/settings/deep-clean), pick the months and the extra charge, and qualifying visits get flagged and billed automatically.",
    ],
    appLink: { to: "/settings/deep-clean", label: "Open Deep-clean" },
    related: ["add-ons", "generate-invoices"],
  },
  // ── Client-facing ──────────────────────────────────────────────────────────
  {
    slug: "lead-form",
    title: "Your signup & quote form",
    section: "Client-facing",
    body: [
      "Your signup & quote form is one public page (and embeddable widget) for new clients. They enter their ZIP, dogs and frequency and see your price where you have priced that zone, then either start service with a card or ask you for a quote. Every signup and every quote request lands in your [Leads](/leads) list, labeled so you can tell them apart.",
      "Choose whether new clients can start service online, and customize the questions and branding, in [Signup & quote form](/settings/online-signup). With online signup off, the page takes quote requests only and shows no prices. Old lead form links keep working and open the same page.",
    ],
    steps: [
      "Open [Settings -> Signup & quote form](/settings/online-signup) and decide whether to accept signups online.",
      "Copy the link or the embed snippet onto your website.",
      "New signups and quote requests appear in [Leads](/leads); use Preview form there to see exactly what prospects see.",
      "Convert a quote request to a client in one click; a paid signup is already a client, and its lead links to it.",
    ],
    appLink: { to: "/settings/online-signup", label: "Open Signup & quote form settings" },
    related: ["client-portal", "first-30-minutes"],
  },
  {
    slug: "client-portal",
    title: "The client portal",
    section: "Client-facing",
    body: [
      "Every client gets a private portal link where they can see upcoming visits, pay invoices, save a card, put service on hold, and refer neighbors.",
      "Clients sign in with a one-time code sent by email. Codes by text are coming soon. If a client can't get their code, staff can read one to them over the phone from the client's detail page in [Clients](/clients).",
      "The portal carries your branding: set your logo and brand color in [Client portal](/settings/client-portal).",
    ],
    related: ["lead-form", "getting-paid", "credit-balance", "reclean-requests"],
  },
  {
    slug: "reclean-requests",
    title: "Re-clean requests",
    section: "Client-facing",
    audience: "Owners and office managers",
    body: [
      "If you promise clients a free re-clean when a spot gets missed, they can ask for it themselves. For a set number of hours after a visit is completed, that visit shows a **Request a re-clean** button in the client's [portal](article:client-portal), with an optional note about what to look at.",
      "The request lands in [Concerns](/concerns) labelled **Re-clean request**, and you get the same email and notification a concern sends. Asking twice for the same visit gives you one request, not two.",
      "Set the window in [Business defaults](/settings/business) under **Re-clean guarantee**. It starts at 48 hours and can be anything up to a week (168). Set it to 0 to turn the guarantee off: the button disappears from every client's portal.",
      "The window is measured from when the visit was finished, not the day it was scheduled. A visit completed at 6 PM Monday with a 48-hour guarantee can be asked about until 6 PM Wednesday.",
    ],
    steps: [
      "Open [Concerns](/concerns) and find the **Re-clean request**. It says which visit it's about.",
      "Press **Schedule re-clean** and pick a day. It starts on tomorrow, in your business's time zone.",
      "HoundStack books a one-off visit at the same property, for $0, with the tech who did the original visit, and notes on the client's timeline why it exists.",
      "The request moves to In progress and shows **Re-clean booked for** that day. Mark it resolved once the re-clean is done.",
    ],
    appLink: { to: "/concerns", label: "Open Concerns" },
    related: ["client-portal", "skip-rules"],
  },
  {
    slug: "refer-a-business",
    title: "Refer a business: earn cash for referrals",
    section: "Client-facing",
    body: [
      "Know another pet service business that could use HoundStack? Share your referral link from [Refer a business](/settings/referrals).",
      "When a business signs up through your link and becomes a paying customer, you earn a percentage of their first payment, paid out in cash after they've stayed active through a short holding period. Progress shows on the same page.",
    ],
    appLink: { to: "/settings/referrals", label: "Open Refer a business" },
    related: ["client-portal"],
  },
  // ── Communications ─────────────────────────────────────────────────────────
  {
    slug: "texting-setup",
    title: "Texting your clients: setup, consent, and STOP",
    section: "Communications",
    body: [
      // IMP-9: this told customers two-way texting ran on "your own Twilio
      // account, connected in SMS settings". Both halves are retired — there is
      // no account to bring and no form to connect it in.
      // 2026-10-06: this said automated notifications and portal codes went
      // out through the platform sender. They no longer do: HoundStack's own
      // number texts the people who sign in to HoundStack, never their clients.
      // 2026-10-07: says "coming soon" first, and points the automated-text
      // switches at Settings > Automation, where they are. It pointed at SMS
      // settings, which has none.
      // 2026-10-29 (#538): one subaccount per business, registered in that
      // business's own name (toll-free verification by default). The owner
      // files it from Settings > Texting.
      // 2026-11-09 (site-r2-05): Managed texting is on sale. Nothing here says
      // "coming soon"; after submitting, texting is "Under review, usually
      // ready shortly" until HoundStack switches it on.
      "Texting your clients is the **Managed texting** add-on on [Plan & billing](/settings/billing). Your business texts from its own toll-free number, registered with US carriers in your business's legal name. There is no Twilio account to connect: add Managed texting, fill in your business details in [Texting settings](/settings/sms), and HoundStack files the registration for you.",
      "After you submit, Texting settings shows **Under review, usually ready shortly** until we switch your number on, and we tell you the moment it is live. Until then, visit reminders, on-my-way notices, review requests, overdue and declined-card reminders, and portal sign-in codes go by email instead, and the texting controls in the app (New message in [Messages](/messages), the composer on a client's page, the text switches in [Automation](/settings/automation)) show an Under review badge instead of sending. Your settings are kept, and they light up on their own when your number is live.",
      "Once it is live, every text includes opt-out instructions, and a client who replies STOP is blocked from further texts automatically. A client is texted only after they have agreed to texts, which you can record now on their Communication tab. Consent details live in the public [SMS policy](/legal/sms).",
      "Pick which automated texts go out in [Automation](/settings/automation), under Text notifications; the emails that stand in for them are in [Emails](/settings/emails). Per-client opt-outs show on the client's page.",
    ],
    appLink: { to: "/settings/sms", label: "Open Texting settings" },
    related: ["client-portal", "ai-tools"],
  },
  {
    slug: "churn-score",
    title: "Churn score: who's at risk of leaving",
    section: "Communications",
    body: [
      "The churn score (0-100) estimates how likely a client is to cancel, based on signals like how long since their last visit, skipped visits, unpaid invoices, and how long since they signed up. Higher = more at risk.",
      'Clients at 60+ show an "at risk" badge in [Clients](/clients). The churn risk panel on the same page lists who to check in with, and each score comes with the one or two signals behind it. A quick call or a small credit often saves the account.',
    ],
    appLink: { to: "/clients", label: "Open Clients" },
    related: ["ai-tools", "credit-balance"],
  },
  {
    slug: "ai-tools",
    title: "Where the office tools live",
    section: "Communications",
    body: [
      "The office tools sit where you use them, not on a separate page: review reply drafts on [Reviews & referrals](/settings/reviews), [churn risk](article:churn-score) on Clients, and the weekly digest on the [Dashboard](/dashboard). Each one is worked out from your own data, the same way every time.",
      "To assign the day's visits to your techs, use auto-routing on the [Schedule](/routes). It plans with real road distances.",
      "Coming soon: marketing posts, and the [AI Receptionist](article:platform-addons), which will answer client texts and calls for you. Neither is switched on for anyone yet.",
    ],
    appLink: { to: "/settings/ai", label: "Open AI usage" },
    related: ["churn-score", "platform-addons", "texting-setup"],
  },
  // ── Financial ──────────────────────────────────────────────────────────────
  {
    slug: "getting-paid",
    title: "Getting paid: from completed visit to money in the bank",
    section: "Financial",
    body: [
      "The billing pipeline is: complete visits -> generate invoices -> clients pay (online, autopay, or saved card) -> Stripe pays out to your bank.",
    ],
    steps: [
      "Connect your Stripe account in [Payments](/payments). This is where client money flows; payouts land in your bank on Stripe's schedule.",
      "Techs complete visits on [My Day](/my-day) as they finish. Completed visits are what invoicing runs on.",
      'On [Invoices](/invoices), "Generate from visits" bills everything completed and unbilled. Use "New invoice" for one-off work. See [Generate vs New invoice](article:generate-invoices).',
      "Clients pay from their [portal](article:client-portal) (card on file, autopay, or a payment link). Overdue reminders can go out automatically.",
      "Paid in cash, by check, bank transfer, Venmo or Zelle? Open the invoice and choose **Record payment**. Pick how it was paid, add the check number or reference, and set the day it arrived. The invoice is marked paid, and your cash-basis reports count it on that day. This works without Stripe connected.",
      "Watch it all on [Reports](/reports): revenue, accounts receivable aging, and payouts.",
    ],
    appLink: { to: "/payments", label: "Open Payments" },
    related: ["generate-invoices", "payments-vs-billing", "client-portal"],
  },
  {
    slug: "generate-invoices",
    title: 'Invoicing a visit, "New invoice" and "Generate from visits"',
    section: "Financial",
    body: [
      "**Invoice this visit** is the usual route: open a completed visit and invoice it there. The invoice names the visit, so it is never billed again.",
      "**New invoice** bills a client directly. Pick a client and the visits and add-ons not yet invoiced are listed: tick the ones this invoice covers so they are not billed a second time. Leave them unticked and add your own lines for work that never went through the schedule.",
      "**Generate from visits** is the catch-up: it bills completed visits that are not on any invoice yet. The end of each client's cycle runs the same thing. If it says it generated 0 invoices, there was no unbilled work in the window, not that something failed.",
    ],
    appLink: { to: "/invoices", label: "Open Invoices" },
    related: ["getting-paid", "skip-rules", "add-ons"],
  },
  {
    slug: "payments-vs-billing",
    title: "Payments vs. Billing: two different money pages",
    section: "Financial",
    body: [
      "[Payments](/payments) (in the sidebar) is money coming **in** from your clients: your Stripe account, balances, payouts to your bank, and saved client cards.",
      "[Billing](/settings/billing) (in Settings) is money going **out** to HoundStack: your own subscription plan for using the software, plus any [platform add-ons](article:platform-addons).",
      'If clients say their saved card stopped working after you reconnected a different Stripe account, use "Check saved client cards" on the Payments page. It finds affected clients and prompts them to re-add a card.',
    ],
    related: ["getting-paid", "platform-addons"],
  },
  {
    slug: "platform-addons",
    title: "Plan add-ons",
    section: "Financial",
    body: [
      "Add-ons are optional extras for your HoundStack plan, billed on the same subscription invoice. They live at the bottom of [Billing](/settings/billing).",
      "Available now: **priority support** (on the Launch plan; Growth and Scale already include it), and a one-time **done-for-you setup** where we configure the whole platform with you.",
      "Coming soon: the **AI Receptionist**, which will answer client texts and calls using your FAQ and your own prices; and **white label** (your own domain on the client portal and emails). They show a Coming soon badge on Billing and cannot be bought yet. **Managed texting** has launched and is on Billing now. You can draft the receptionist's persona and FAQ now in [AI receptionist settings](/settings/ai-receptionist).",
      "Adding or removing a monthly add-on adjusts your next invoice automatically (prorated); one-time services land on your next invoice once. Note: these are different from your own [client-facing add-on services](article:add-ons).",
    ],
    appLink: { to: "/settings/billing", label: "Open Billing" },
    related: ["payments-vs-billing", "ai-tools", "add-ons"],
  },
  {
    slug: "credit-balance",
    title: "Account credit vs. amount owed",
    section: "Financial",
    body: [
      "A client's **credit** is money on their account (referral rewards, prepayments, goodwill credits) that automatically offsets future charges.",
      "An **open invoice** is what they currently owe. A client can have $0 credit and a $125 open invoice at the same time; the two numbers answer different questions.",
    ],
    related: ["getting-paid", "client-portal"],
  },
  {
    slug: "royalties",
    title: "Royalties: for multi-brand operators",
    section: "Financial",
    body: [
      "The Royalties page applies if separate businesses pay you a percentage of their revenue (a franchise-style arrangement). It calculates and invoices those royalty fees across linked organizations.",
      "Open Royalties from the sidebar to review linked businesses and their totals. Each business keeps its own clients and staff.",
    ],
    related: ["payments-vs-billing"],
  },
  // ── Team ───────────────────────────────────────────────────────────────────
  {
    slug: "users-roles",
    title: "Inviting your team and setting roles",
    section: "Team",
    body: [
      "Invite teammates from [Users & roles](/settings/users). Each person gets a role (see [What each role can see and do](article:roles)) that controls their access.",
      'Open a person\'s "Routing & addresses" panel to set whether they run routes, whether they are available right now, their daily capacity, and where their route starts and ends. Only people who run routes appear on the dispatch board or can be assigned visits. Plans are priced per active seat, so deactivating someone frees their seat.',
    ],
    appLink: { to: "/settings/users", label: "Open Users & roles" },
    related: ["roles", "routes-planning", "time-clock"],
  },
  {
    slug: "time-clock",
    title: "Time clock and timesheets",
    section: "Team",
    audience: "Owners, office managers and technicians",
    body: [
      "Everyone who runs a route clocks in and out from the card at the top of [My Day](/my-day). It shows when you clocked in and how long you have been on. Clocking out tells you your hours for the day and how many visits you completed.",
      "No signal? Tap anyway. The tap is saved on your phone with the time you made it and sent when you are back online, so the timesheet shows the time you actually clocked in, not the time your signal came back.",
      "The office sees the week in [Timesheets](/timesheets): hours per person per day, the week's total, **overtime past 40 hours** highlighted, and the visits each person completed beside the hours. A shift that runs past midnight is split between the two days on your business's clock.",
      "Somebody forgot to clock out, or forgot the whole day? Tap the day to fix a shift, or use **Add time**. Corrections are marked as made by the office. **Export CSV** gives you one row per shift with the date, clock-in, clock-out, hours and visits completed, ready for payroll.",
      "Only owners and office managers can see everyone's hours and correct them. A technician sees only their own.",
    ],
    steps: [
      "Tech: tap **Clock in** on My Day when the day starts, and **Clock out** when it ends. Clock out and back in for an unpaid break.",
      "Office: open [Timesheets](/timesheets) and pick the week. Days with nobody on the clock show a dash.",
      "Fix anything that looks wrong: tap the day, then **Edit** or **Clock out** on the shift.",
      "Export the CSV and send it to whoever runs payroll.",
    ],
    appLink: { to: "/timesheets", label: "Open Timesheets" },
    related: ["my-day", "users-roles", "roles"],
  },
  // ── In the field ───────────────────────────────────────────────────────────
  {
    slug: "my-day",
    title: "My Day: the technician's home screen",
    section: "In the field",
    audience: "Technicians",
    body: [
      "[My Day](/my-day) lists the visits assigned to you for the day, in route order, with one-tap directions, start/complete buttons, photo capture, skip (with a [reason](article:skip-rules)), and [add-on billing](article:add-ons).",
      "Complete visits as you finish them; completed visits are what [invoicing](article:getting-paid) runs on. A visit left in progress overnight shows up in the office's stuck-visit count.",
    ],
    appLink: { to: "/my-day", label: "Open My Day" },
    related: ["time-clock", "waste-log", "skip-rules", "add-ons"],
  },
  {
    slug: "waste-log",
    title: "The waste log and disposal manifests",
    section: "In the field",
    audience: "Technicians",
    body: [
      "Many jurisdictions require records of commercial pet-waste disposal. The [waste log](/waste-log) is that record: each dump entry (a disposal manifest) captures the facility, date, weight, bags, ticket number, and an optional receipt photo.",
      "Log a dump every time you unload at a disposal facility. Facilities are saved with a one-tap Directions link.",
    ],
    appLink: { to: "/waste-log", label: "Open Waste log" },
    related: ["my-day", "dna"],
  },
  {
    slug: "dna",
    title: "DNA compliance",
    section: "In the field",
    body: [
      "Some HOAs and municipalities run dog-DNA programs: unscooped waste is tested and matched to a registered dog. The [DNA page](/dna) tracks samples, lab results, matches, and violation notices for properties enrolled in such a program.",
      "Not in a DNA program? You can ignore this page.",
    ],
    appLink: { to: "/dna", label: "Open DNA compliance" },
    related: ["waste-log"],
  },
];

export function getArticle(slug: string | undefined): HelpArticle | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}
