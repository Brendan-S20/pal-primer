# HoundStack Mobile UX/IA Audit & Rework Plan

Prepared 2026-07-23. Goal per owner: bring the mobile experience toward Jobber's field-service flow.
Scope: the authenticated staff app (owner/office/dispatcher/tech). The client portal is already
bottom-tabbed and is treated as the in-house proof of the pattern, not a rework target.

---

## 1. Current state audit

### 1.1 App shell & navigation — `src/routes/_authenticated/route.tsx` + `src/components/AppSidebar.tsx`
**Works on a phone:** the shadcn sidebar (`src/components/ui/sidebar.tsx`) swaps to an off-canvas
`Sheet` drawer below the mobile breakpoint, so nav is reachable. Header is sticky with backdrop blur.
Native bootstrap (status bar, push token registration) already lives in the shell.

**Breaks / hurts:**
- Primary nav is a hamburger drawer holding **20+ items in 7 groups** (`GROUPS` in `AppSidebar.tsx`).
  Every navigation is 2 taps + a scroll hunt. Nothing is "one thumb-tap away" — the core Jobber gap.
- The header packs 5 controls into 56px: drawer trigger, a ⌘K search field (keyboard-palette-first —
  wrong primitive for touch), Help icon, `NotificationBell`, and a persistent "Sign out" **text button**
  — the most dangerous action in the app is permanently in the phone header.
- Tap targets: bell and help are `p-2` around 16px icons (~32px total, below the 44px floor).
- `NotificationBell` popover is `w-80` absolute-positioned (overflows ≤360px viewports), and the
  per-notification **delete button is `hidden group-hover:block`** — unreachable on touch, where
  hover doesn't exist (`NotificationBell.tsx:115`).

### 1.2 My Day (tech field app) — `src/routes/_authenticated/my-day.tsx`
**Already the most mobile-ready surface in the app** — keep, don't rewrite:
- Sticky blurred header with `env(safe-area-inset-top)`, progress bar, offline/pending banner.
- Sticky bottom **NEXT UP** bar (`fixed inset-x-0 bottom-0 z-40`) with safe-area padding.
- Field-sized controls (`h-11` on touch, `sm:h-8` desktop), haptics, native Capacitor camera path,
  hazard banners, dog temperament chips, gate/lockbox codes, per-card ETA/window labels.
- Full offline lifecycle: Start/Complete/Skip/photo queue to IndexedDB with per-card "queued" chips.
- On-my-way + reminder + completed SMS, add-on billing with confirm dialog, station logs.

**Breaks / hurts:**
- **Double header**: My Day renders inside the AppShell, so its own sticky bar (`sticky top-0 z-30`)
  fights the shell header (also `sticky z-30`, `h-14`) — it escapes the main padding with `-mx-4 -my-6`
  negative margins, a workaround that signals the shell was never designed to host a full-bleed
  mobile screen. Two headers burn ~110px of a 780px viewport.
- The fixed NEXT UP bar and any future bottom tab bar will collide — must be composed deliberately.
- Date navigation is a bare `<input type="date">`; no swipe/day-strip for "tomorrow / yesterday".

### 1.3 Dashboard — `src/routes/_authenticated/dashboard.tsx`
Responsive grids exist (`sm:grid-cols-2 lg:grid-cols-4`), but the page is desktop-first: KPI money
tiles first, a 380px map, Techs-today, overdue invoices, then two open AI panels. On a phone the
"what's happening today" content (alerts, visits progress, techs) is below the fold; AI panels pad
the scroll. Header quick actions are two small `size="sm"` outline buttons. Not a Today-first home.

### 1.4 Schedule / dispatch — `src/routes/_authenticated/routes.tsx` (1,147 lines)
Deeply desktop-first: dnd-kit **PointerSensor drag-and-drop** board (columns/rows), map/board toggle,
today/week/month ranges, week grid with weekend toggles, a Tools popover, and summary `<table>`s
(~line 892). Drag-and-drop with a `GripVertical` handle is hostile on touch; the board's multi-column
layout can't fit a phone. There is **no phone-usable day-list schedule view for office roles** — the
closest thing is the My Day staff-preview picker (`?staff=` + `listMyDayFieldStaff`), which is
read-only and framed as a tech tool.

### 1.5 Clients — `clients.index.tsx` + `clients.$clientId.tsx`
**Works:** the list already implements the exact pattern to generalize — stacked tap-through cards
under `sm:hidden`, table on desktop (`clients.index.tsx:196-338`). Cards show balance/credit labeled
distinctly. Client detail has header Call/Navigate/Message actions (Section A protected).

**Breaks / hurts:**
- Detail page has **9 tab triggers in a `flex-wrap` TabsList** — on 390px this wraps into 3 rows of
  pill soup with `py-1.5` (~32px) targets; "Reviews & referrals" alone nearly fills a row.
- Editing happens in right-side drawers (fine), but list-page chrome (4 stat cards, CSV export,
  fixed-width `w-44`/`w-40` Selects, AI churn panel) pushes the actual list far down on phones.
- Other object lists (invoices, messages, concerns, leads) did **not** get the card-list treatment
  and fall back to dense tables/rows on mobile.

### 1.6 Portal (client-facing) — `portal.$slug.$token.tsx`
Already Jobber-shaped: fixed bottom tab bar (6 tabs, `grid-cols-6`, safe-area padding, active-state
tint, `preload="render"` to kill the G3 dead-click). This is the internal reference implementation
for the staff tab bar.

### 1.7 Native/PWA posture — `capacitor.config.ts`, `src/pwa/register.ts`, `src/lib/native.ts`
Capacitor apps exist (iOS/Android) but currently run **remote-URL** (`server.url` →
pal-primer.lovable.app) rather than bundled assets; push (APNs/FCM), splash, status bar configured.
PWA service worker is registered guarded (prod-only, non-iframe, non-preview) via workbox. Offline
libs (`src/lib/offline/queue.ts`, `sync.ts`, `useOfflineVisitActions.ts`, `compressImage.ts`) are
solid but scoped **only** to My Day visit actions + photos; sync stops on first failure (deliberate).

---

## 2. Jobber's mobile IA distilled — what to adopt, what to skip

### Adopt
| Jobber pattern | Why it fits HoundStack |
|---|---|
| **Bottom tab bar** (4–5 tabs, thumb-reachable) | Kills the 20-item drawer hunt; portal already proves it in this codebase |
| **Today-first Home** — today's appointments, progress, alerts, quick actions | Dashboard data already exists (`getDashboardSummary`); it's an ordering problem |
| **Prominent global + Create** | "New client / new visit / record payment / send message" are all ≥3 taps deep today |
| **Schedule: day list ⇄ map** | `RouteMap` + `listVisitsForDay` exist; only the phone-sized day-list view is missing |
| **Object-centric detail: identity header → action row → sections** | Client detail already has the header/action row; tabs need mobile form |
| **Consistent list→detail→actions** | Clients cards prove it; replicate for invoices/messages/concerns |
| **Field flow: on-my-way, timers, photos, forms** | All exist in My Day — polish, don't build |
| **Notifications center** | Bell + `/notifications` page exist; needs touch-sized presentation |

### Skip — poor product fit
- **Requests → Quotes → Jobs pipeline.** HoundStack is recurring-subscription service:
  lead → client → subscription → auto-generated visits → auto-invoices. There is no per-job quoting;
  a "Quotes" tab would be dead weight. (Portal "Requests" already covers inbound asks.)
- **Signature capture on completion.** Proof-of-service here is the required completion photo —
  clients aren't home for a weekly scoop; a signature flow would be theater.
- **Per-job line-item invoicing UI in the field.** Billing is cadence-driven (Section A protected);
  the field-side money surface is the existing capped Add-on charge, not invoice authoring.
- **Timesheets/expenses/mileage.** Out of scope for this product today.
- **Jobber's 5th "Insights" tab.** Reports/Analytics stay desktop; a phone tab isn't warranted.

---

## 3. Proposed HoundStack mobile IA

Bottom tabs render **only below `md`**; the sidebar shell is untouched at desktop widths.
One shared `MobileTabBar` component, role-aware via the existing `ROUTE_ROLES`/`useMyRole`.

### 3.1 Owner / office manager / dispatcher

```
┌──────────────────────────────────────────┐
│  HoundStack        🔍   🔔(3)            │  ← slim header: search, notifications
│                                          │    (Sign out moves into More)
│  ── HOME (Today-first) ──                │
│  ⚠ 3 unassigned · 2 weather-flagged     │  ← alert chips (existing)
│  Visits today            9 / 14  64% ▓▓▓ │
│  Techs: Alex ▓▓▓░ 5/7 · Sam ▓▓░░ 4/7    │
│  [ Today's map (collapsed → tap) ]       │
│  AR open $4,805 · MTD $12,3k  (KPI row)  │  ← money below the fold, not above
│  AI digest (collapsed accordion)         │
├──────────────────────────────────────────┤
│  🏠 Home  📅 Schedule  ➕  👥 Clients ⋯More │
└──────────────────────────────────────────┘
```

- **Home** = reordered `/dashboard` (mobile ordering only; desktop layout unchanged).
- **Schedule** = `/routes` gains a mobile **day-list view**: date strip (‹ Today ›), visits grouped
  by tech with status chips, tap → existing `VisitDetailDrawer` (Mark completed / Reschedule /
  Reassign / Cancel — Section A protected). Map toggle reuses `RouteMap`. Board/drag stays `md:`+ only.
- **➕ Create** (center, raised): bottom sheet — *New client · New visit · Record payment ·
  Send message · Add lead*. Role-filtered (dispatcher loses money actions per H4).
- **Clients** = existing card list, chrome demoted (stats collapse to one row, CSV/AI desktop-only).
- **More** = grouped sheet/page reusing `GROUPS` from `AppSidebar.tsx`: Invoices, Messages, Concerns,
  Leads, Waste log, Zones, Weather, Inventory, Imports, Reports, Settings, Help, **Sign out**.

### 3.2 Tech

```
│  ☀ Today  📅 Schedule  ⋯ More            │
```
- **Today** = My Day exactly as-is (its sticky header becomes *the* header — shell header hides on
  this tab below `md`, resolving the double-header). NEXT UP bar sits above the tab bar
  (`bottom` offset = tab-bar height + safe area).
- **Schedule** = My Day's own day view for other dates: replace the raw date input with a 7-day
  strip driving the existing `?date=` search param. No new data plumbing.
- **More** = Waste log, Neighbor canvassing, DNA sample logging (scoped per H1), Notifications,
  Settings→Preferences (language), Help, Sign out.
- No global ➕ for techs — their creation verbs (photo, add-on, station log, skip) live on the
  visit card where the context is. Techs remain redirected off office routes (existing RoleGuard).

### 3.3 Stays desktop-only
Drag-and-drop dispatch board, week/month grids, route optimization tools (`routes.tsx`), Reports,
Analytics, Imports, Zones map editing, boundary editor, platform admin console, CSV exports,
AI panels (churn/dispatch/marketing), CommandPalette/KeyboardShortcuts (already keyboard-gated).

### 3.4 Cross-cutting mobile patterns
- Detail-page tab strips (client detail's 9 tabs) become a **horizontally scrollable segmented bar**
  with edge-fade — no wrapping. `?tab=` URL behavior unchanged (Section A).
- All header/tab targets ≥44px; NotificationBell becomes a full-height sheet below `md` with
  always-visible (not hover-only) row actions.
- Invoices/messages/concerns lists adopt the clients card-list pattern (`sm:hidden` cards + table).

---

## 4. Phased implementation plan

### Phase 1 — Nav shell + Home (the IA switch)
**Touchpoints**
- `src/components/MobileTabBar.tsx` (new) — modeled on portal `BottomTabs` incl. `preload="render"`.
- `src/components/CreateSheet.tsx` (new) — role-filtered quick-create bottom sheet.
- `src/routes/_authenticated/route.tsx` — mount tab bar below `md`; slim mobile header (move Sign
  out to More; enlarge bell/help targets); suppress shell header on My Day below `md`; add
  bottom padding (`pb-[calc(3.5rem+env(safe-area-inset-bottom))]`) to `<main>` on mobile.
- `src/routes/_authenticated/my-day.tsx` — raise NEXT UP bar above the tab bar; remove the
  negative-margin escape once the shell provides full-bleed on mobile.
- `src/routes/_authenticated/dashboard.tsx` — mobile-first section order (alerts → visits/techs →
  map (collapsed) → KPIs → AI collapsed); CSS order/conditional only, no data changes.
- `src/components/NotificationBell.tsx` — sheet presentation below `md`; touch-visible delete.
- More sheet: reuse `GROUPS` + `canAccess` from `AppSidebar.tsx` (single source of nav truth).

**Regression risks:** Desktop shell must be pixel-unchanged ≥`md`. My Day sticky NEXT UP + required
completion-photo + Start/Complete/Skip (Section A / H1 "visit cards strong") — verify offline queue
still syncs with the shell header hidden. Portal tab bar untouched (separate route tree).

### Phase 2 — Schedule + object-list patterns
**Touchpoints**
- `src/routes/_authenticated/routes.tsx` — add `list` view mode rendered by default below `md`
  (date strip + per-tech visit rows → `VisitDetailDrawer`); gate board/dnd behind `md`. Consider
  extracting the mobile day list to `src/components/schedule/MobileDayList.tsx` rather than growing
  the 1,147-line file.
- `src/routes/_authenticated/my-day.tsx` — 7-day strip driving existing `?date=`.
- `src/routes/_authenticated/invoices.index.tsx`, `messages.index.tsx`, `concerns.tsx`, `leads.tsx`
  — mobile card lists per the clients pattern.
- `src/routes/_authenticated/clients.$clientId.tsx` — scrollable non-wrapping tab strip.
- `src/routes/_authenticated/clients.index.tsx` — demote stat cards/CSV/AI on mobile.

**Regression risks (Section A, explicitly protected):** invoice preview popup + its 6 actions;
URL-addressable client `?tab=`; Visits tab List/Calendar toggle + Upcoming/Past grouping; visit
detail popup actions; client header Call/Navigate/Message. Also B4's mandate: invoice rows must stay
**one** shared implementation — the mobile card variant must live in the shared component, not fork it.

### Phase 3 — Field-flow polish + offline hardening
**Touchpoints**
- `src/lib/offline/queue.ts` + `sync.ts` — extend queue coverage to station logs
  (`logStationService`) so commercial stops work in dead zones; add visible per-action retry state.
- `src/routes/_authenticated/my-day.tsx` — swipe/long-press affordances if desired; photo
  compression already handled (`compressImage.ts`).
- `capacitor.config.ts` — decide bundled-assets build (comment out `server.url`) for store binaries;
  verify safe-area + push deep links (`?date=` handling already exists) inside the native shell.
- `src/routes/_authenticated/waste-log.tsx`, `neighbors.tsx` — field-sized forms (collapse
  always-open form per QA D).

**Regression risks:** offline replay ordering (photos before complete — the queued-completion-photo
gate in `my-day.tsx:706-708`); sync stop-on-failure semantics; native camera path; push token
registration in `route.tsx`. Money actions (add-on billing) stay **online-only** unless Q5 says otherwise.

---

## 5. Open questions for the owner

1. **Native posture:** Capacitor currently loads the remote URL. Do we ship store binaries with
   bundled assets as part of this rework (Phase 3), or stay PWA/remote-shell until the tab IA settles?
2. **Create (+) contents:** Which 3–5 actions earn a slot in the office quick-create sheet?
   Proposed: New client, New visit, Record payment, Send message — confirm/edit.
3. **Mobile dispatch depth:** On a phone, is Schedule read + reassign/reschedule (via the existing
   visit drawer) enough, or do dispatchers genuinely need drag-to-reorder on tablets (keeps dnd in
   scope for touch)?
4. **Tech "More" scope:** Should techs reach Inventory or Messages from the phone, or is the H1
   scoping (My Day, Waste log, Neighbors, DNA sample logging, Settings) the intended ceiling?
5. **Offline money:** Should add-on charges queue offline like visit actions (risk: double-billing
   on flaky sync), or stay online-only with a clear "no connection" state?
