# Scoop CRM Wrap-Up — Execution Plan

Six batches, run in order. Each batch ends with a live end-to-end verification against the listed demo accounts (screenshots via headless Playwright where UI-visible). No batch closes on "should work now."

Locked decisions I will not re-litigate: separate `platform_admins` table + `is_platform_admin()`; unlimited staff on every tier; one reconciled `billing_status` / `plan_name` per org read by every surface; one shared boundary-editor component for Zones + Properties.

---

## Batch 1 — Billing source of truth (blocks everything else)

**Server:**

- Add `public.get_org_billing_state(org_id)` SQL security-definer returning `{ plan_id, plan_name, billing_status, active_client_count, band_min, band_max, price_cents, stripe_status }`. Derives plan from `active_client_count` against `platform_plans` bands; reconciles with `organizations.stripe_subscription_id` state; `billing_status` ∈ `free | active | past_due | canceled | grace`.
- Rewrite `getBillingStatus` (tenant) and `getPlatformTenants` / `platform-overview` / `platform-revenue` / `platform-health` server fns to read from this one function. Delete every ad-hoc "Paid tier" / "Pro" derivation.
- Tier engine: on client add/remove and on nightly cron, if `active_client_count` crosses a band, transition state honoring existing grace-period rule and create a real Stripe subscription (or `subscription.update` for band change) + invoice via existing platform Stripe keys.
- Fix `/platform/revenue` + `/platform/health` "$5,270" bug: those widgets currently sum tenant AR. Rewrite to read platform SaaS AR from `platform_invoices` (unpaid). Add a clearly labeled separate "Tenant client-AR rollup" tile if we want to keep that number visible.
- Fix `/platform/health` "Pending signups": point at same query as `/platform/signup-requests` (status = pending).

**Client:**

- `/dashboard` badge, `/billing` "Current plan", `/platform/tenants` list Plan+Status columns, `/platform/revenue`, `/platform/health` all read `plan_name` + `billing_status` from the new server value.
- `/billing` "Open customer portal" button: wire to `createBillingPortal` (already exists) — currently the click handler is missing/broken.
- `/pricing` public page: rewrite tier cards to mirror `platform_plans` exactly (Free, Puppy, Fetch $59, Scoop $99, Haul $149, Pack Leader $2/client, Kennel $1.50/client). Remove "1 technician" from Free — say "Unlimited staff."
- `/platform/plans` Free vs Puppy duplication: I'll ask the user which is intentional; default action is to keep one and delete the other after confirmation (out-of-band, not blocking this batch).

**Verify:** [owner@demo.test](mailto:owner@demo.test) → Dashboard + Billing show same plan matching `/platform/plans`. Platform admin → Tenants + Revenue + Health agree with tenant's view. Fresh `/request-access` submission → Health counter increments. Portal button navigates to Stripe.

---

## Batch 2 — Platform admin core repair

- **Fix `/platform/tenants/$id` render:** route matches but shows list content. Inspect `platform.tenants.$id.tsx` for layout/Outlet wiring — likely the tenants list layout is not rendering `<Outlet />` for the child, or the child is nested wrong. Fix so detail workspace (Overview/Users/Billing/Invoices/Feature flags/Notes/Audit) actually renders.
- **Migrate `platform_admin` out of tenant role enum:**
  - New migration: create `public.platform_admins (user_id uuid pk, granted_at, granted_by)` + GRANTs + RLS + `is_platform_admin(uuid)` security-definer.
  - Data migration: for every `user_roles` row with `role = 'platform_admin'`, insert into `platform_admins` and delete the `user_roles` row.
  - Drop `platform_admin` from `app_role` enum (rename-swap-drop pattern to keep FKs intact).
  - Replace every `has_role(uid,'platform_admin')` call across server fns / RLS policies with `is_platform_admin(uid)`.
- **UI cleanup:**
  - Remove "Platform admin" option from New Invite role dropdown (`settings.users.tsx` and any platform invite dialog).
  - `/settings/users` Team table: filter out users present in `platform_admins`.
  - `/platform/users` directory: show platform admins in a separate section, not tagged to a tenant org.

**Verify:** click into a tenant from Tenants list, Users directory, Overview conversion pipeline — all three render detail workspace. New Invite has no "Platform admin" option. Tenant `/settings/users` does not list [brendan@thenorth.consulting](mailto:brendan@thenorth.consulting).

---

## Batch 3 — Map crash + data wiring

- **Shared boundary editor:** extract existing working Property boundary component into `src/components/BoundaryEditor.tsx` (draw / view / undo / clear on Leaflet, using ref-based mode + guarded `clearLayers`). Refactor both `/zones` "Set on map" and `/properties/$id/boundary` to use it. Deletes the duplicated buggy Zones implementation entirely.
- **Clients list Dogs column:** in `getClientsList` (or wherever `clients.index.tsx` queries) join `dogs` on `client_id` (same source `/dna` uses) and return count. Update column to render that count.
- **Weather:** inspect `weather.functions.ts` + `weather-day.functions.ts`. If provider key is missing, surface an honest "Weather not configured — add API key in Settings" state on `/weather` and `/routes` weather panel, and log a server warning. If key exists but call fails, add error toast + retry. Ask user whether to wire a specific provider (Open-Meteo needs no key — likely preferred) as clarifying Q before I implement.

**Verify:** Zones "Set on map" — draw 3+ points, switch to View, drag, switch back to Draw — zero errors. Clients list Dogs column matches DNA registered-dogs counts. Weather page shows real forecast or clear not-configured state.

---

## Batch 4 — AI tools: fix or honestly disable

For each of Marketing content / Churn risk / Zone pricing / AI dispatch on `/ai-tools`:

- Add loading state (button spinner + disabled) around the mutation.
- Add error toast on failure (`onError: (e) => toast.error(e.message)`).
- Debug the underlying `ai-tools.functions.ts` calls — likely they call Lovable AI Gateway but silently swallow errors or return an empty shape the UI can't render. Fix the server fn to return the shape the UI expects; if the model call itself fails, surface the error.
- **Weekly digest "Suggested next steps":** inspect `digest.functions.ts` / `digest.server.ts`. Report back to the user whether the text is model-generated per-org or templated. If templated, relabel UI as "Guidance" and stop implying personalization.

**Verify:** each of the 6 sub-tools produces real output OR shows a clear loading + error state. Never silent.

---

## Batch 5 — Mobile pass (390px viewport)

- **Public site header:** add hamburger + Sheet drawer to `MarketingLayout.tsx` mirroring authenticated sidebar pattern. Nav links: Services, Pricing, About, Contact, Sign in.
- `**/clients` table:** change wrapper to `overflow-x-auto`. Build responsive stacked-card layout `<div class="sm:hidden">` showing name / balance / contact / status per client; keep table for `sm:` and up.
- `**/analytics` page:** add `overflow-x-hidden` + `max-w-full` on the authenticated layout content wrapper (or on the analytics route root). Verify no other route relies on horizontal page scroll.
- **Dispatcher + Tech mobile walkthrough:** log in as each, run through primary flows on 390px, screenshot any clipping/overflow. File follow-ups only if issues found.

**Verify at 390px:** public nav opens via hamburger, all links work. `/clients` cards render, every field visible. `/analytics` no page-level horizontal scroll. Dispatcher + Tech primary flows clean.

---

## Batch 6 — Polish

- **Reseed demo:** update `demo.functions.ts` seed so `tech@demo.test` has ≥1 visit today (assign 2–3 of today's visits from Morgan Manager to Taylor Tech).
- **Tab title consistency:** grep for `"ScoopCRM"` — fix on `/neighbors`, `/dna`, `/reports` head() to `"Scoop CRM"`.
- **Inventory "Assign" action:** add button on `/inventory` "Assigned to techs" tab opening a small dialog to assign an item to a staff member (writes to `inventory_assignments`).
- **Date mismatch:** audit `/my-day` + `/routes` default-date derivation — likely one uses UTC `toISOString().slice(0,10)` and the other uses local. Standardize on local-tz date.
- **New Invite dialog a11y:** add `<DialogDescription>` (or `aria-describedby`) to silence Radix warning.
- `**/contact` vs `/request-access`:** ask user which to keep or how to differentiate copy — clarifying Q, then implement.

---

## Clarifying questions I'll ask before/during execution

1. `/platform/plans` — is Free vs Puppy (both $0, 0–3 clients) intentional? Which to keep?
2. Weather — OK to wire Open-Meteo (no key) as default provider?
3. `/contact` vs `/request-access` — collapse into one, or clearly differentiate ("book a demo" vs "self-serve signup")?

I'll ask #1 and #2 at the start of the relevant batch so they don't block Batch 1. #3 is a Batch 6 question.

---

## Technical notes

- All new server fns: `requireSupabaseAuth`, plus `is_platform_admin()` gate for platform ones.
- `supabaseAdmin` always via `await import()` inside handlers.
- Migrations: schema-only via `supabase--migration`; data reseeds via `supabase--insert`.
- Stripe: reuse existing `STRIPE_SECRET_KEY`; band-change → `stripe.subscriptions.update` with new price, prorate default.
- Verification uses Playwright headless against `http://localhost:8080` with the injected owner/manager/dispatcher/tech sessions; platform admin via password login flow.

## Out of scope

- Adding marketing copy for AI receptionist / DNA / neighbor canvassing (business decision, per user).
- Analytics/observability dashboards beyond existing.
- Stripe live-mode migration.

(inlcuding for context: Locked decisions — restating so nothing below re-litigates them

1. Platform admins live in a separate `platform_admins` table, gated by an `is_platform_admin()` security-definer function. **Never** a value inside the tenant-facing role enum (`owner` / `office_manager` / `dispatcher` / `tech`).
2. Pricing: free while an org has ≤3 active clients; active-client-band tiers above that; **unlimited staff seats on every tier, free or paid, always.**
3. One reconciled `billing_status` / `plan_name` per organization. Every surface that displays plan/billing info — public pricing page, tenant Billing page, Owner dashboard badge, Platform Admin Tenants list, Platform Admin Revenue/Health — must read this one computed value. No screen computes its own answer.
4. One shared boundary-drawing map component. Zones' "map coverage" and Properties' "sketch boundary" are the same interaction (draw/view/undo/clear a polygon on a Leaflet map) and must not be two separately-maintained implementations.

---

## Batch 1 — Billing source of truth (do this first; blocks everything else)

**The problem, exactly as reproduced:** the demo org "Demo Pet Waste Co" has 15 active clients — 5x past the 3-client free threshold. Four different screens give four different answers about its billing state:

- Platform Admin → Tenants list: Plan = "Free", Status = "Free"
- Owner Dashboard (`/dashboard`): badge reads "Paid tier"
- Tenant Billing page (`/billing`): "Current plan: Pro"
- Platform Admin → Revenue (`/platform/revenue`): "Paying orgs: 1 / 1 (plan_status = active)"

None of "Paid tier," "Pro," or the Revenue page's implicit "active" match any real plan name in the actual Plans catalog (Free, Puppy, Fetch, Scoop, Haul, Pack Leader, Kennel — visible at `/platform/plans`). Zero SaaS invoices exist anywhere (`/platform/invoices` shows "No invoices yet, $0.00 total billed"), and $0 MRR is shown on Overview, despite this org clearly owing a paid-tier subscription by the band rules.

**Fix required:**

1. Add one server-computed `billing_status` + `plan_name` per organization (derived from active-client count against the real band table at `/platform/plans`, plus actual Stripe subscription state once wired).
2. Point every one of the four screens above at this single value. Delete whatever local/derived logic currently produces "Paid tier" on the dashboard and "Pro" on the billing page — those are clearly two more independent guesses, not reads of a real field.
3. Make the tier engine actually execute: when active-client count crosses a band boundary, transition state (respecting the previously-specified grace-period rule) and create the real Stripe subscription + invoice.
4. On `/platform/plans`, there are two separate rows ("Free" and "Puppy") both covering 0–3 clients at $0/mo. Confirm whether this is intentional (rename one to clarify the difference) or leftover seed duplication (delete one).

**Separately — public pricing page is wrong, fix regardless of the above:** 5. `/pricing` currently shows: Free ($0, ≤3 clients, **"1 technician"**), Starter ($49/mo, ≤25 clients, unlimited techs), Growth ($129/mo, ≤150 clients). None of these names, prices, or band cutoffs match the real catalog at `/platform/plans` (Fetch $59/4–25, Scoop $99/26–75, Haul $149/76–125, Pack Leader $2/client/126–200, Kennel $1.50/client/201+). Rewrite the public page to mirror the real catalog exactly. 6. Remove "1 technician" from the Free tier's public copy — it contradicts locked decision #2, and the real Plans table already correctly says "Unlimited staff" for Free. This is a copy bug only.

**Fix, tenant-side dead click:** 7. `/billing` → "Open customer portal" button does nothing on click: no navigation, no new tab, no toast, no console error. Wire it to actually open the Stripe customer portal.

**Fix, Platform Admin AR/revenue confusion:** 8. `/platform/revenue` and `/platform/health` both show "$5,270" as AR/outstanding. This figure is provably the *tenant's own* client AR — it's the exact sum of the 12 open invoices visible at the tenant's own `/invoices` page ($1,400+175+130+175+125+2,200+175+140+175+140+300+135 = $5,270.00 exactly). It is being surfaced on the *platform* Revenue/Health screens as if it were platform-level SaaS revenue owed to Scoop CRM, which is misleading since actual SaaS invoices = 0. Either (a) relabel these platform widgets to clearly show they're a tenant-AR rollup, not platform revenue, or (b) build the real platform-level AR calc from actual SaaS invoices and stop reusing tenant data here. 9. `/platform/health`'s "Pending signups" counter shows 0 even immediately after a real signup request is submitted and correctly appears as "Pending (1)" on `/platform/signup-requests`. Point Health's counter at the same query as the Signup Requests page.

**Verification for this batch:** log in as `owner@demo.test`, confirm Dashboard/Billing both show the same plan name and it matches `/platform/plans`. Log in as platform admin, confirm Tenants list and Revenue/Health agree with each other and with the tenant's own view. Submit a fresh signup request via `/request-access` and confirm Health's pending count updates. Click "Open customer portal" and confirm it actually navigates to Stripe.

---

## Batch 2 — Platform Admin core repair

**The problem:** `/platform/tenants/:id` (clicking into any tenant from the Tenants list, the global Users directory, or the Overview "conversion pipeline" link) updates the URL and browser tab title to "Tenant · Platform admin" but the rendered content does not change — it's still showing the parent Tenants list (same heading, same search bar, same table). No console error. Reproduced consistently, including after a delay to rule out a slow load.

**Fix required:** 10. Fix the route so `/platform/tenants/:id` actually renders the tenant detail workspace (Overview/Users/Billing/Invoices/Feature flags/Notes/Audit subtabs), not the list view.

**The problem:** `platform_admin` is confirmed (three separate ways) to be stored as a value in the tenant-facing role system rather than a separate table:

- New Invite dialog's Role dropdown lists "Platform admin" alongside Owner/Office manager/Dispatcher/Tech.
- Global Users directory (`/platform/users`) shows [brendan@thenorth.consulting](mailto:brendan@thenorth.consulting)'s row literally as "Demo Pet Waste Co platform_admin."
- The tenant's own Settings → Users & roles page (`/settings/users`) lists [brendan@thenorth.consulting](mailto:brendan@thenorth.consulting) in its Team table.

**Fix required:** 11. Migrate `platform_admin` fully out of the tenant role enum into its own `platform_admins` table per locked decision #1. Remove "Platform admin" as a selectable role in the New Invite dialog. Remove platform admins from any tenant-scoped Team/Users listing (a tenant's Settings → Users & roles should never query or display platform admins at all).

**Verification for this batch:** click into a tenant from all three entry points (Tenants list, Users directory, Overview) and confirm the actual detail workspace renders each time. Open New Invite and confirm "Platform admin" is not an option. Check a tenant's own Users & roles page and confirm platform admins don't appear there.

---

## Batch 3 — Map crash + data wiring

**The problem, exact repro:** go to `/zones` as owner, click "Set on map" on any zone. This throws immediately:

```
TypeError: Cannot read properties of undefined (reading 'layerPointToLatLng')
  at t.getBounds (leaflet-CqPc79kp.js)
  at zones-DyIQHsei.js
```

and crashes to a full error boundary ("Something went wrong").

This is the same error signature as a previously-reported and reportedly-fixed crash (stale closure over `mode` + `clearLayers()` mid-drag detaching the marker's `_map`). It's still fully broken here. Separately, the **Property boundary** tool (`/properties/:id/boundary`) — a visually near-identical Leaflet draw/view/undo tool — was tested with the same draw-points → switch-mode → drag → switch-back sequence and threw zero errors. That confirms the fix was applied to the Property boundary component only; Zones' map-coverage tool is a separate, duplicated implementation that never got the patch.

**Fix required:** 12. Apply the same fix to the Zones "Set on map" component, OR (strongly preferred, per locked decision #4) refactor both Zones and Properties to share one boundary-editor component so this class of bug can only need fixing once.

**Verification:** on `/zones`, click "Set on map," draw at least 3 points, switch to View, drag the map, switch back to Draw. Zero console errors, no crash.

**The problem:** Clients list (`/clients`) shows "0" in the Dogs column for all 15 clients, even ones with active multi-dog subscriptions (e.g., "Tom Anderson" has subscriptions reading "4 dog(s)" and "5 dog(s)"). Real, individually-named dog records with breed absolutely exist in the system — confirmed via `/dna` → "Registered dogs" tab, which correctly lists 20 named dogs (Bailey/Cocker Spaniel, Rex/German Shepherd, etc.) tied to the correct owners/addresses.

**Fix required:** 13. Point the Clients list's Dogs column at the same dogs data the DNA compliance feature already reads correctly, instead of whatever empty/unlinked source it's currently querying.

**The problem:** Weather integration returns "forecast unavailable" / "No forecast available" for every zone, on both `/routes` (Check weather) and the dedicated `/weather` page. Zero console errors — it's failing silently, not crashing.

**Fix required:** 14. Wire up the actual weather data source (or confirm to us directly if this integration is intentionally still pending, so we're not chasing a phantom bug — but right now nothing in the UI tells the user that, it just silently shows no data).

**Verification:** Clients list shows correct per-client dog counts matching what's in DNA Compliance. Weather page shows real forecast data for at least one zone, or an honest "not connected yet" state if the integration genuinely isn't live.

---

## Batch 4 — AI tools: fix or honestly disable

**The problem, exact repro:** on `/ai-tools`, four of the six sub-tools produce zero output after being triggered and waiting 5–8+ seconds, with no loading indicator, no error toast, and no console error at all:

- **Marketing content**: filled Content type/Tone/Topic, clicked "Generate" → "Output appears here." never changes.
- **Churn risk**: clicked "Re-score all active clients" → table still says "No scores yet."
- **Zone pricing**: clicked "Suggest zone prices" → table still says "No suggestions yet."
- **AI dispatch**: clicked "Suggest reassignments" → table still says "No suggestions yet. Choose a day and click Suggest."

Only **Weekly digest**'s "Preview this week" actually works — it generates a real computed summary with live numbers.

**Fix required:** 15. For each of the four non-functional sub-tools: get the underlying AI/backend call working end-to-end (this is core spec-differentiator functionality, not decoration). As an interim minimum if any of these can't be finished this batch, add a visible loading state while the call is in flight and a clear error toast on failure — a silent no-op is worse for trust than an honest "this isn't ready yet" or "something went wrong, try again." 16. Confirm and tell us: is Weekly Digest's "Suggested next steps" text genuinely generated per-org by the model, or templated fallback copy? If templated, label it as guidance rather than implying it's personalized.

**Verification:** trigger each of the 6 AI sub-tools with real data and confirm either real output or a clear, honest loading/error state — never silence.

---

## Batch 5 — Mobile pass

**The problem:** the public marketing site (`/`, `/services`, `/pricing`, `/about`, `/contact`) drops its entire header nav at phone width (~390px) — Services, Pricing, About, Contact, Sign in are all just gone, with no hamburger icon or drawer replacing them. The only way to reach those pages from a phone is scrolling all the way to the footer.

**Fix required:** 17. Add a real mobile nav (hamburger → drawer, matching the pattern already used correctly in the authenticated app's sidebar) to the public site's header.

**The problem, with root cause:** `/clients` on a 390px viewport needs 783px of table width, but its immediate wrapper `<div>` is only 341px wide **and set to** `overflow-hidden` rather than `overflow-x-auto`. That means roughly 440px of the table — the Balance, Contact, and Status columns — isn't just scrolled off-screen, it's completely clipped with no scrollbar able to reach it. There is currently no way on a phone to see whether a client has an outstanding balance or is active/inactive.

**Fix required:** 18. Change that wrapper's overflow behavior to `overflow-x-auto` at minimum. Better: since this is a tool techs/managers will genuinely use on phones, build a responsive stacked-card layout for narrow viewports instead of a sideways-scrolling table.

**The problem:** `/analytics` causes the entire page (not just its wide cohort-retention table) to scroll horizontally on mobile — document scrollWidth reaches 685px against a 390px viewport, even though the table's own immediate wrapper does correctly have `overflow-auto`. Something further up the DOM tree isn't constrained to the viewport width.

**Fix required:** 19. Constrain page width (`max-width: 100vw` / `overflow-x: hidden` at the layout-shell level) specifically for pages with wide tables like this one, so the whole page can't be dragged sideways.

**Also needed:** 20. Complete mobile-viewport testing for the Dispatcher and Tech roles specifically — this wasn't finished in the last audit pass due to a tooling failure on our end, not a known product bug. These are the two roles most likely to actually be used on a phone in the field, so they need explicit verification, not an assumption that they're fine because other roles were.

**Verification:** at 390px width — public site nav opens via hamburger and all links work; `/clients` table either scrolls internally or renders as cards, with every column reachable; `/analytics` doesn't allow the page itself to drag sideways; Dispatcher and Tech roles walked through on a real 390px viewport with no unexpected clipping.

---

## Batch 6 — Polish (do last)

21. **Reseed demo data** so `tech@demo.test` ("Taylor Tech") has at least one visit assigned today. Right now all of today's demo visits are assigned to "Morgan Manager" (the office_manager persona), so a fresh tech login shows "Nothing scheduled for you on this day" and the single most important workflow in the product — start/complete/skip a visit, photo capture — can't be demoed out of the box.
22. Fix inconsistent browser tab titles: "ScoopCRM" (no space) appears on at least `/neighbors`, `/dna`, and `/reports`, while "Scoop CRM" (with space) is used everywhere else. Standardize on "Scoop CRM."
23. Add a visible "Assign" action to Inventory's "Assigned to techs" tab (`/inventory`), or confirm assignment happens elsewhere and this tab is intentionally read-only.
24. Check for a one-day date mismatch: on the same date, `/my-day`'s default date textbox showed "2026-07-05" while `/routes`' default date showed "2026-07-06" in the same session. Possible timezone-boundary bug worth a quick look.
25. Add `aria-describedby`/Description to the New Invite dialog (Radix Dialog a11y console warning, minor).
26. Clarify the relationship between `/contact` (public "book a demo" form) and `/request-access` (public "request platform access" form) — they currently serve overlapping purposes with no clear differentiation for a visitor deciding which to use.

**Verification:** each item above gets its own quick confirm — this batch is small enough that each fix should be a one-line screenshot/before-after, not a full walkthrough.

---

## Also flag to us (not a Lovable fix — business/content decision needed)

The public marketing site doesn't mention several things that are actually built and working: the AI receptionist (Settings → AI receptionist is real and well-architected), DNA compliance (fully built, unique in the category), and neighbor canvassing (fully built, unique in the category). Once Batch 1–5 land, we should talk about adding marketing content for these — that's a copy/content task for us, not something to fold into this build plan.)  
  
Say **go** and I'll start Batch 1.