# HoundStack QA Punch List — Lovable Track

**Generated:** July 8, 2026 &nbsp;|&nbsp; **Items in this file:** 15 of 53 total findings &nbsp;|&nbsp; **Source:** Consolidated Master QA Report (HoundStack_QA_Findings_Consolidated_Master.docx)

## How to use this file

This is one of two execution-track files split from the 53-finding consolidated QA punch list. This file contains every finding assigned to the **Lovable track** — UI copy, visual/styling consistency, and cosmetic fixes with no backend logic, financial calculation, or sensitive-data handling involved. The companion file, `HoundStack_ClaudeCode_Tasks.md`, contains the remaining findings: security, data-integrity, and feature-build work assigned to Claude Code (Opus 4.8 or Fable 5, named per item).

Each item below is self-contained: severity, affected role(s), the area of the app, what QA found, and the specific fix to make. Paste each item's "What to build/fix" text directly into Lovable as the prompt — it already has full context baked in.

## Sequencing — read before starting

**Run the Claude Code track first, merge it, and let Lovable sync from GitHub before starting any of these items.** Lovable's own documented best practice is to avoid editing the same project simultaneously through the Lovable editor and through GitHub-based (Claude Code) commits — doing so risks one side's changes silently overwriting the other's. Lovable does support two-way GitHub sync and full codebase export, so this isn't a lock-in concern, just a sequencing one.

**Two specific file-overlap risks to watch for**, since both tracks touch these areas:
- **Sign-in page** — Claude Code track item #17 (OAuth, actually an ops action item, not code) and #44 (error/success alert styling) both touch `/auth`. Confirm #17's credential swap in Lovable's Cloud → Users → Auth → Google panel is done before restyling this page — it's a config change, not a code change, and won't itself conflict, but don't restyle the alert component while someone else is mid-edit on the same file.
- **Billing/Invoices and Plans catalog** — Claude Code track items #6, #23, and #51 touch pricing/plan display logic. Hold off on any Lovable-side cosmetic pass over Billing or the Plans catalog until those land, so you're styling the final layout rather than one that's about to be restructured.

---

## Medium Findings

### #20 — Map tile style is visually inconsistent across the app, confirmed in three separate locations

**Severity:** Medium  
**Role(s) affected:** Owner, Dispatcher  
**Area:** Visual design — Maps  

**What we found:**  Three different map tile styles were found rendering across the app's map surfaces, despite presumably sharing the same underlying map library: street-style vector tiles in one location and photographic satellite imagery in another (both found during the Owner-role visual-design pass), and a third, additional distinct tile style found on the Routes Planning-tools map during the Dispatcher-role styling pass. Moving between map-containing pages therefore feels visually inconsistent and unpolished, as if each surface configured its own map independently rather than sharing one design decision.

**What to build/fix:**  Standardize on a single map tile provider and style, and centralize the tile-layer configuration into one shared map component or config value used by every map instance in the app, rather than letting each surface configure its own tile layer independently. Reconcile all three confirmed inconsistent instances (the two found on Owner-accessible map surfaces, plus the Routes Planning-tools map found via Dispatcher) against whichever single style is chosen as the standard, and audit any remaining map surfaces (client portal, Zones) not yet explicitly checked.

---

### #24 — Property boundary sketching lives on a disconnected full-page route with no context

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Property — Yard boundary  

**What we found:**  Boundary sketching exists in two disconnected places that don’t share a flow. In the New Client wizard, sketching happens inline as step 3 of 5 (Sketch the yard), with wizard context (progress steps, client name) visible. But editing a boundary later — the far more common case, since real-world yards get fences, additions, or the initial sketch gets corrected — requires leaving the client entirely: from the client’s Service tab there is a small ‘Edit boundary’ action that navigates to a standalone page at /properties/{id}/boundary, a bare map with no header, no breadcrumb back to the client, and no visible client/property name on the page itself. Confirmed live: after saving a boundary edit on this page, the only way back to the client is the browser back button — there is no ‘Done’ or ‘Back to client’ affordance in the UI.

**What to build/fix:**  Property boundary editing (/properties/{id}/boundary) is a bare standalone page with no header, breadcrumb, or client/property name displayed, and no in-page way to navigate back to the client after saving — the only way back is the browser back button. This is inconsistent with the New Client wizard, where the same boundary-sketching UI appears inline as step 3 of 5 with full context. Add a header to the standalone boundary page showing the client name and property address, a persistent ‘Back to client’ / ‘Done’ button that returns to the client’s Service tab after saving, and consider embedding the boundary editor directly in the Service tab (e.g. as a modal or inline expandable panel) rather than a full navigation to a separate route, so editing an existing boundary feels like part of the client record instead of a detour to an unrelated page.

---

### #30 — Internal app has no brand color anywhere, even though a brand color is already configured and correctly applied to the client portal

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Visual design — Brand identity  

**What we found:**  Settings > Preferences > “Client portal branding & policy” has a configured Brand color (#1686a2, a dark teal) and a Logo URL, and both are correctly applied to the client portal — the portal’s header card renders in that teal color and shows the configured logo. The internal, logged-in app (Dashboard, Clients, Routes, Zones, every Settings page, etc.) never uses this color anywhere: every screen checked across four rounds of testing is pure black/white/gray, with color reserved only for semantic status (green “Active” badges, red/orange warnings, blue links). The sidebar’s own logo mark is plain black-and-white. For a product staff spend an entire workday in, this reads as an unfinished or unbranded internal tool, and it’s a low-cost fix since the color value already exists in the database and is already proven to render correctly elsewhere in the product.

**What to build/fix:**  The Brand color set in Settings > Preferences (Client portal branding & policy) is only applied to the client-facing portal — the internal app has zero brand color usage anywhere and is entirely grayscale apart from semantic status colors. Reuse this same configured value as a lightweight internal accent/theme color: the active nav-item highlight in the sidebar, primary button backgrounds (currently plain black), the sidebar logo mark, chart accent colors on Reports/Analytics, and focus/selection states are all natural, low-risk places to apply it. This doesn’t require building new theming infrastructure — the color already exists per-tenant and is already proven to work; it just needs to be read in the internal app’s theme/CSS variables the same way it’s read on the portal. This would give each tenant’s internal app a sense of identity instead of looking identical to every other tenant.

---

### #33 — “Complete” is disabled with no visible explanation until a completion photo is taken — the reason is only exposed in the accessible name, not on screen

**Severity:** Medium  
**Role(s) affected:** Technician  
**Area:** My day — Visit completion  

**What we found:**  Before a completion photo is taken, the “Complete” button renders as visibly grayed out but gives no on-screen indication of why: no inline text, no tooltip on hover (tested), and clicking it produces no toast, error, or any feedback at all. Inspecting the page's accessibility tree shows the button's actual accessible name is “Add a completion photo first” — so the requirement is communicated to screen readers but not to a sighted technician looking at the screen. In the field, especially on a small phone screen in bright sunlight, a technician tapping a grayed-out button that does nothing and explains nothing is a real friction point, and could plausibly be mistaken for the app being broken.

**What to build/fix:**  The “Complete” button on My day is disabled until a completion photo is taken, but this requirement is currently invisible to sighted users — the button just looks grayed out with no explanation, even though its accessible name (“Add a completion photo first”) shows the app already has the right copy internally. Surface that same message visibly: either a small caption under the button row (“Take a photo to complete this visit”), a tooltip on hover/tap, or a toast when the disabled button is tapped. This is a small change since the explanatory text already exists in the codebase (as the button's aria-label) — it just needs to also render as visible UI.

---

## Low Findings

### #37 — "My day" is a permanently empty page for every non-Technician staff role it's shown to

**Severity:** Low  
**Role(s) affected:** Office Manager, Dispatcher  
**Area:** Navigation — My day  

**What we found:**  Confirmed independently in two separate role-QA passes: Office Manager's My day and Dispatcher's My day both render permanently empty, since the page only ever shows a Technician's own assigned visits, and neither Office Manager nor Dispatcher has an assigned-technician identity. My day nonetheless remains visible in the sidebar for both roles regardless. Being caught independently in two different roles' passes confirms this is a systemic navigation issue rather than a one-off oversight specific to a single role.

**What to build/fix:**  Either hide "My day" from the sidebar entirely for roles that can never have assigned visits (Office Manager, Dispatcher, Platform Admin, and any future non-field role), or — if the intent is to let office/dispatch staff preview a technician's day from this page — repurpose it for those roles into a technician-picker view rather than shipping a page that is guaranteed to always be empty for them.

---

### #41 — Weekly digest renders raw markdown instead of formatted text

**Severity:** Low  
**Role(s) affected:** Owner  
**Area:** AI Tools — Weekly digest  

**What we found:**  Generating the Weekly digest works and produces genuinely useful, accurate content, but the output shows literal markdown syntax (“**This week**”, “**Money**”, etc.) instead of rendering it as bold headings.

**What to build/fix:**  AI Tools > Weekly digest correctly generates content, but the output is displayed with raw markdown syntax visible (e.g. ‘**This week**’, ‘**Money**’ shown literally with asterisks instead of being rendered as bold text/headings). Add markdown rendering to the digest output component (e.g. react-markdown or an existing markdown utility already used elsewhere in the app) so bold text, headers, and bullet lists render properly instead of showing raw syntax characters.

---

### #42 — Grammar/pluralization bug on the New Client wizard’s suggested-price caption

**Severity:** Low  
**Role(s) affected:** Owner  
**Area:** New client wizard — Plan step  

**What we found:**  The Plan step’s suggested-price caption reads “Based on 1 dogs” when a client has exactly one dog — missing singular/plural handling.

**What to build/fix:**  On the New Client wizard’s Plan step, the suggested-price caption uses incorrect pluralization, e.g. showing ‘Based on 1 dogs’ instead of ‘Based on 1 dog’ when dog_count is 1. Fix the caption to use proper singular/plural handling (e.g. \`Based on ${count} ${count === 1 ? 'dog' : 'dogs'}\`) — small but visible on every single-dog client created, which per the demo tenant’s own client mix is a common case.

---

### #43 — Sidebar wordmark is illegibly small next to the logo mark when the nav is expanded

**Severity:** Low  
**Role(s) affected:** Owner  
**Area:** Visual design — Navigation  

**What we found:**  In the expanded sidebar, the “HoundStack” wordmark sits beside the “H” icon mark at roughly 7-8px — small enough that it reads as a blur rather than legible text at normal viewing distance, even though the icon mark itself is a reasonable size. In the collapsed sidebar state the wordmark is correctly hidden and only the icon shows, which reads fine.

**What to build/fix:**  The “HoundStack” text next to the sidebar’s icon logo (expanded state only) renders far too small (approximately 7-8px) to be legible — increase it to a normal wordmark size (14-16px is typical for a sidebar lockup) or, if horizontal space next to the icon is the constraint, consider dropping the wordmark entirely in favor of the icon alone (as the collapsed state already does) rather than shipping an illegible one.

---

### #44 — Success and informational messages on the sign-in page reuse the same red "error" alert styling as actual failures, with no visual distinction

**Severity:** Low  
**Role(s) affected:** Owner  
**Area:** Authentication — Sign-in page  

**What we found:**  Three different messages were reproduced on /auth, all rendered in the identical red-bordered, red-text alert box: (1) an actual failure — submitting the wrong password shows "Invalid login credentials"; (2) a successful password-reset request — clicking "Forgot password?" with a valid-looking email shows "Check your email for a reset link"; and (3) a successful sign-up submission — creating an account shows "Check your email to confirm your account, then sign in." Cases 2 and 3 are confirmations that the system did what the user asked, not errors, but nothing about their presentation (color, icon, wording) distinguishes them from case 1 — a user could reasonably read "Check your email..." in a red box and assume their request failed. Separately, this same message box does not clear when switching between the "Sign in" and "Create account" tabs — a leftover "Check your email for a reset link" message from the Sign in tab remained visible after switching to Create account, where it no longer has any relevant context.

**What to build/fix:**  Give the sign-in page's alert component a neutral/positive variant (e.g. blue or green, with a checkmark icon) for confirmation messages like "Check your email for a reset link" and "Check your email to confirm your account," reserving the red/error variant for actual failures like "Invalid login credentials." Also clear any active alert message when the user switches between the Sign in and Create account tabs, since a message shown under one tab's context (e.g. a password-reset confirmation) is not relevant once the user has navigated to a different form.

---

### #45 — Advanced analytics — LTV tab has a missing space between two column headers, rendering as one run-together word

**Severity:** Low  
**Role(s) affected:** Office Manager  
**Area:** Analytics — LTV  

**What we found:**  On Analytics > LTV, the table's last two column headers render with no gap between them: “Monthly avgStatus” reads as a single run-on word instead of two separate headers (“Monthly avg” and “Status”). Zoomed-in inspection confirms this isn't a rendering artifact — the header cells are genuinely missing their normal spacing/padding, unlike every other multi-word header on the same table (“Client,” “Tenure,” “Revenue” all have normal spacing).

**What to build/fix:**  The Analytics > LTV table (/analytics, LTV tab) renders its last two column headers without a gap: “Monthly avgStatus” instead of “Monthly avg” and “Status” as separate header cells. Add the missing spacing/padding between these two header cells to match every other column header on the same table — likely a missing margin-right or gap value on the second-to-last <th>, or a template string concatenation bug that joins the two header labels without a separator.

---

### #46 — Cohort retention table uses a bare period for empty cells instead of the em-dash used everywhere else in the app

**Severity:** Low  
**Role(s) affected:** Office Manager  
**Area:** Analytics — Cohort retention  

**What we found:**  The Cohort retention table (Analytics > Cohort retention) fills every month column beyond the current one (M1–M12, since the only cohort is one month old) with a plain “.” character. Everywhere else in the app that shows a placeholder for missing/not-applicable data — the Clients list “Balance” column, Zones' optional fields, and others — uses an em-dash “—”. A single stray period reads like a rendering glitch or a truncated value rather than an intentional “no data yet” indicator, and is inconsistent with the app's own established convention.

**What to build/fix:**  The Cohort retention table (/analytics, Cohort retention tab) renders empty/not-yet-applicable month cells (M1–M12) as a bare “.” character, while every other empty-state value in the app (e.g. the Clients list Balance column) uses an em-dash “—”. Change the Cohort retention table's empty-cell placeholder to match — use the same shared formatting helper/constant the rest of the app uses for “no value” cells rather than a hardcoded period, so future tables don't reintroduce the same inconsistency.

---

### #48 — Board view visit card shows a malformed, unreadable time-window fragment when a visit has no end time

**Severity:** Low  
**Role(s) affected:** Dispatcher  
**Area:** Routes — Board view  

**What we found:**  On Routes' Board view (Dispatcher's default landing page), a visit card for Kevin O'Brien reads “Window 11:01-—” directly beneath the ETA line — a hyphen immediately followed by an em-dash with nothing after it. This is what the time-window range display falls back to when only a start time is set and the end time is empty: instead of hiding the range, showing just the start time, or substituting a clear placeholder, it concatenates the range separator twice, producing a stray, confusing “-—” fragment that reads like a rendering error rather than a real value.

**What to build/fix:**  The Board view visit card time-window line (Routes, Board tab) renders “Window {start}-—” when a visit's window end time is empty, instead of a clean fallback. Reproduce by finding/creating a visit with a start time set and no end time, then fix the range-formatting logic: if the end time is missing, show just “Window {start}” (or “Window {start} onward”) rather than concatenating the range separator with an empty value. Audit the same formatting helper for other places visit time windows are rendered (Split view, Map view popups, client portal) in case the same bug appears there too.

---

### #49 — “Stations” and “Skip” both reference configuration screens (“the client page”, “Settings → Skip rules”) that Technician cannot reach

**Severity:** Low  
**Role(s) affected:** Technician  
**Area:** My day — Visit actions  

**What we found:**  Clicking “Stations” on a visit with no waste stations configured shows “No waste stations configured for this property. Add them from the client page” — but the client page (/clients/{id}) is blocked for Technician. Separately, the “Skip” panel's billing-rules caption reads “Billing rules for each reason are set in Settings → Skip rules” — Technician's Settings has only a Preferences tab, so Skip rules is equally unreachable. Neither of these is a security issue (unlike the client-roster leak above, no data is exposed) — they're dead-end instructional copy that assumes the reader has Owner/Office Manager-level access, which a technician using this page never will.

**What to build/fix:**  Two in-context messages on My day (the “no waste stations configured” empty state on Stations, and the skip-billing-rules caption on Skip) instruct the technician to go configure something in a place they cannot access (“the client page”, “Settings → Skip rules”). Since these messages are shown specifically to a role that can never act on the instruction, reword them for a technician audience — e.g. “No waste stations configured for this property — ask the office to add them” — rather than pointing to a page/settings tab this role will always be denied.

---

### #52 — Revenue chart renders a second, unlabeled Y-axis with no associated data series

**Severity:** Low  
**Role(s) affected:** Platform Admin  
**Area:** Revenue  

**What we found:**  The "Revenue · trailing 12 months" chart on the Revenue page shows a left Y-axis scaled in dollars (currently all $0, since the demo tenant is on the Free plan) and a second, right-side Y-axis scaled 0–4 with no legend, label, or visible line/bar tied to it. It's a minor polish gap rather than a functional bug — the chart still renders and the dollar axis is correct — but an unlabeled, unused axis reads as an unfinished chart config (likely a second series, e.g. paying-tenant count, that was wired into the chart's scale but never given a visible dataset or legend entry).

**What to build/fix:**  The Revenue-page chart (/platform/revenue, "Revenue · trailing 12 months") renders a second Y-axis (right side, scaled 0–4) with no corresponding data series, label, or legend entry — only the left dollar axis has a plotted line. Either remove the unused axis config, or, if it was meant to show a second series like paying-tenant count over the same 12 months, wire up that dataset and give the axis a visible label and legend entry so it isn't a dead, unexplained scale sitting next to the real chart.

---

### #53 — The same tenant's plan/status badge renders differently — different casing and different visual style — one click apart

**Severity:** Low  
**Role(s) affected:** Platform Admin  
**Area:** Tenants list vs. tenant detail  

**What we found:**  The Tenants list (/platform/tenants) shows Demo Pet Waste Co's status as a capitalized, solid dark pill: "Free". Clicking into that exact same tenant's detail page shows the identical status as a lowercase, plain-outline pill immediately next to the org name: "free". Same underlying value, same tenant, one click apart — but different capitalization and a completely different badge style (filled vs. outline). It's a small thing, but in an admin console this kind of inconsistency undermines confidence that the two views are really showing the same data.

**What to build/fix:**  The tenant status badge renders as a capitalized, filled pill ("Free") on the Tenants list (/platform/tenants) and as a lowercase, outline-only pill ("free") on that same tenant's detail page (/platform/tenants/:id) — same value, two different components/styles. Consolidate to a single shared status-badge component (consistent casing, e.g. always title-case, and one visual style) used in both places, so a status badge always looks and reads the same no matter which page it appears on.

---
