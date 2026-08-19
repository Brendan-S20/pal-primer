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

---

## 6. Measured, 2026-08-19 — what a browser found behind the login

The audit above was read, not measured. On 2026-08-19 the real-browser sweep was
extended past the login screen (`tests/viewports/every-signed-in-page-at-every-width.spec.ts`),
so these are computed geometry at 360 / 768 / 1280 / 1920, not a reading of the JSX.

**22 surface/width combinations failed. All are now cleared — 18 fixed, 4 false positives — and the sweep is a blocking gate.** Two things about that number before the list:

- **It confirms §1.1 rather than replacing it.** The header controls this document
  predicted at "~32px total, below the 44px floor" measure **32.0px**, and the ⌘K
  search field measures **34.0px**. The reading was right; it just could not say
  how far off, or that those two appear on *every tenant page* and are therefore
  the highest-leverage fix in the list.
- **Nothing tripped the silent-clipping rule.** The 78-character signup URL on
  `/settings/online-signup` — the exact fault CLAUDE.md added that rule for — is
  handled correctly at all four widths.

The sweep ran `continue-on-error` in `sandboxes.yml` for exactly one day. The
list below is worked down to zero and the step is now a hard gate.

### 6.1 The page itself scrolls sideways

The rule stated first in the working agreement, and the most user-visible break.

| Route | Viewport | Content width |
|---|---|---|
| ~~`/clients/:id`~~ | ~~360~~ | ~~**585px**~~ **FIXED — now 360px** |
| ~~`/clients/new`~~ | ~~360~~ | ~~**565px**~~ **FIXED — now 360px** |
| ~~`/dashboard`~~ | ~~360~~ | ~~**503px**~~ **FIXED — now 360px** |
| `/platform/tenants/:id` (audit diff) | 360 | **465px** |
| ~~`/my-day`~~ | ~~360~~ | ~~**407px**~~ **FIXED — now 360px, and the whole surface is clean** |
| `/clients` | 768 **and** 1280 | **1431px** |
| `/invoices` | 768 | **1054px** |
| ~~`/clients/:id`~~ | ~~768~~ | ~~**849px**~~ **FIXED — now 768px** |
| ~~`/clients/new`~~ | ~~768~~ | ~~**829px**~~ **FIXED — now 768px** |

`/clients` at 1280 is worth singling out: this is not a phone problem. It is the
tablet-and-split-screen band the agreement calls out as "every tablet and every
split-screen window", and it is broken on a laptop.

### 6.2 Controls off the side, with no scroller to reach them

Not merely cramped — unreachable.

> **`/clients/:id` and `/dashboard` are FIXED, 2026-08-19 — and the cause was
> not where this list pointed.** A grid item's `min-width` computes to `auto`,
> so a column is never laid out narrower than its content. Both columns of
> SummaryTab's `grid gap-6 lg:grid-cols-[3fr_2fr]` measured **569px** inside a
> 360px viewport; `/dashboard`'s map row carried the identical fault. `min-w-0`
> on the four columns fixed all of it, with the desktop layouts untouched.
>
> **Everything below for those two routes was a symptom.** The header's
> five-button action row genuinely could not wrap and was genuinely fixed —
> and the page stayed 585px afterwards, because that row was overflowing a
> container that was already too wide. The textarea "at x=37..564", the note
> tabs and Add note were never faults of their own: they are `w-full` children
> of a card filling an over-wide column, reported at the width they were given.
>
> For the next reader working this list: **find the outermost element wider
> than the viewport — the one whose parent still fits — and fix that.**
> Everything under it is downstream. `tests/a-flex-row-as-wide-as-its-longest-word.test.ts`
> is deliberately silent on grids, so this class had no static coverage at all;
> `tests/a-grid-column-as-wide-as-its-widest-child.test.ts` now pins it.

- **`/clients/:id` @360** — `Edit Client` (x 358–474), an icon button (482–522),
  `Review` (388–438), `Office` (363–418), `Technician` (422–505), `Client`
  (509–564), the note `<textarea>` (37–564), `Add note` (486–564), `Message`
  (485–564).
  **Root cause is visible in the DOM:** `div.flex items-center gap-2` is laid out
  **485px wide inside a 286px parent** — the header action row cannot shrink.
  That is precisely the fault `tests/a-flex-row-as-wide-as-its-longest-word.test.ts`
  describes, on a row the parser does not reach.
- **`/clients/:id` @768** — icon button (746–786), `Client` (773–828),
  `<textarea>` (301–828), `Add note` (750–828), `Message` (749–828).
- **`/dashboard` @360** — `Show map` (324–387), `Open routes →` (399–486),
  `All →` (458–486).
- **`/clients/new` @360** — wizard steps `4` (387–415) and `5` (499–527); @768 step
  `5` (763–791).
- **`/my-day` @360** — the staff-preview `<select>` (75–407).

### 6.3 Under the 44px touch floor at 360px

~~Highest leverage first, because it is on every page:~~

- ~~**App shell, every tenant page** — `Search or jump to…` **34.0px**; header
  icon button **32.0px**. (§1.1 predicted both.)~~ **FIXED 2026-08-19.** Three
  controls, not two: the search button (34.0px, `py-1.5` around a 20px line),
  the weather trigger (32.0px, `p-2` around a 16px glyph) and the sidebar
  trigger (28.0px, `h-7 w-7` from `ui/sidebar.tsx`). All now 44px, with the
  glyphs untouched so the header looks the same.

  The sidebar trigger is worth recording: **`src/routes/platform.tsx` already
  passed `min-h-11 min-w-11`, and the tenant shell did not** — so the fix
  existed in this repo, on the console only we log into, and had never been
  carried across to the shell every customer's staff use all day. The failure
  mode was not "nobody knew", it was "one of two places drifted", which is why
  `tests/the-header-on-every-page-was-under-the-touch-floor.test.ts` pins both
  call sites in identical words.

  Sweep went **22 → 21** failing combinations: one surface/width had no other
  fault.

Then, by surface — **these are still open**:

| Surface | Controls |
|---|---|
| ~~`/routes` week view~~ | ~~`Map`/`Board`/`Today`/`Week`/`Month` **36.0px**; three filter selects **26.0px**; **49 lane-count buttons at 32.0px**~~ **FIXED 2026-08-19** |
| ~~`/routes` day board~~ | ~~as above, plus `Show tech load` **29.0px**~~ **FIXED 2026-08-19** |
| ~~`/routes` auto-routing card~~ | ~~one control at **16.0px**~~ **NOT A BUG — see §6.8** |
| ~~`/clients/:id`~~ | ~~`Review` **20.0px** ×2; `View all visits` / `Manage services` / `View properties` **16.0px**; `Office`/`Technician`/`Client` **24.0px**~~ **ALL FIXED 2026-08-19.** The three jump links and the note tabs took a minimum height. `Review` could not: it sits inside a sentence, where a min-height pushes the line apart — it uses `py-3 -my-3` instead, so the hit area grows and the prose renders unchanged. |
| `/clients/new` | step dots 1–5 **28.0px**; two buttons at **16.0px** |
| ~~`/invoices`~~ | ~~row icon buttons **16.0px** ×9~~ **NOT A BUG — see §6.8** |
| ~~`/platform/users`~~ | ~~a row icon button **16.0px**, ×51~~ **NOT A BUG — row-selection checkboxes, see §6.8** |
| `/settings/users` | row buttons **16.0px** ×7; role `<select>` **40.0px** |
| `/settings/scheduling` | weekday toggles Sun–Sat **26.0px**; traffic `<select>` **40.0px** |
| `/settings/online-signup` | `Copy link` **16.0px**; one button **20.0px** |
| `/my-day` | staff `<select>` **36.0px**; photo-kind `<select>` **40.0px**; one button **40.0px** |
| ~~`/zones`~~ | ~~**16.0px** ×2~~ **NOT A BUG — see §6.8** |
| `/notifications` | `All` and `Unread (2)` **32.0px** |
| `/platform/tenants` | status `<select>` **36.0px** |

### 6.4 What passes clean at all four widths

`/platform/overview`, `/platform/plans`, `/platform/tenants/:id` (overview tab),
and everything at 1920 except `/clients`.

### 6.5 Three exemptions were added to the shared rules

Each removed false positives only; the public sweep is green either way.

- **`sr-only` is exempt from the clipping rule** — a 1×1 box is a screen-reader
  label, not clipped text. Written as `clientWidth ≤ 1 && clientHeight ≤ 1`
  rather than a class match, so it cannot be defeated by renaming the utility.
  Without it, every page reported "Toggle Sidebar is cut off by 102px".
- **Controls inside a horizontal scroller are exempt from the off-screen rule**,
  provided the scroller's own edge is on the page. CLAUDE.md prescribes that
  pattern; without the exemption all 50 rows of the platform directory were
  findings.
- **A label's height counts for `select`/`input`/`textarea`**, taking the max of
  the two, because label activation is browser behaviour. The Routes filter bar
  is a bare 16px `<select>` inside a padded `<label>`: reported height moved
  16 → 26px. Still a finding — just an honest one.

### 6.6 One thing the sweep found that is not a layout bug

`src/integrations/supabase/client.ts` passes
`storageKey: impersonating ? '…' : undefined`. An explicit `undefined` overwrites
supabase-js's derived default in the options spread, so the session is stored
under the literal key `"undefined"` and every read is
`localStorage.getItem(undefined)`. Measured while building the session fixture,
not inferred. It works today because it is wrong consistently — but it means the
impersonation switch changes the storage key out from under a live session, and
any future code reading the documented `sb-<ref>-auth-token` key finds nothing.
Not fixed here; it is app source and this was a test-only change.


### 6.7 The one finding the rule cannot express — RESOLVED 2026-08-19

`/clients/new` still fails at 360px, and the only thing left on it is **two
shadcn radio dots at 16.0px** — the residential/commercial account-type choice.

They are `aspect-square h-4 w-4` from `ui/radio-group.tsx`, and that is what a
radio button looks like. Growing the element grows the visible circle, because
the border is on the element being measured; padding cannot help for the same
reason. So the control cannot be made 44px without redesigning what a radio
looks like across the whole app.

**They are not unreachable.** Each has a real `<Label htmlFor>` beside it, so
tapping the word "Residential" selects it — which is how anyone actually uses a
radio. The sweep measures the control it can see and has no way to know that.

Three ways out, none of them free, and this needs an owner call:

1. **Teach the rule about labels** — exempt a control whose associated
   `<label>` has a box of at least 44px, and give these rows `min-h-11` so that
   is true. Correct in principle and the only option that makes the *behaviour*
   better rather than the *number* better. It is also a change to a shared rule
   in `tests/viewports/rules.ts`, which is exactly where a relaxation could
   quietly excuse real faults later.
2. **Replace the radios with segmented buttons** on this step. Two mutually
   exclusive options with short labels are a segmented control anyway, and a
   segmented control is 44px without argument.
3. **Record it as a permanent known exception** and stop counting it.

Deliberately not chosen unilaterally: option 1 relaxes a rule to clear a
finding, which is the shape of change that should never be made by whoever is
trying to clear the finding.

**Owner chose option 2, and it is done.** `RadioGroupSegment` in
`ui/radio-group.tsx` is built on the same Radix primitive rather than on plain
buttons, so the group keeps its `role="radiogroup"`, each option keeps
`role="radio"` with `aria-checked`, and the roving tabindex keeps the whole
group behind one tab stop — all three measured in Chromium after the swap.
Hand-rolling segmented `<button>`s would have looked identical and told a
screen reader nothing.

`/clients/new` now has **zero** findings at every width. The rule in
`tests/viewports/rules.ts` was not touched, which was the point: the control
changed to meet the rule rather than the rule bending to admit the control.


### 6.8 Four of the twenty-two were never real, 2026-08-19

The `/routes` cluster's last finding was the auto-routing panel's reassign
checkbox at 16.0px. Before changing it, `ui/checkbox.tsx` turned out to already
carry the fix — and a better one than the change about to be made:

> "So an absolutely positioned `::before` extends the tappable area to 44x44
> centred on the square, on touch widths only. It is out of flow, so nothing
> moves: the row is the same height, the tick is the same size, and the only
> change is where a thumb has to land."

**`tests/viewports/rules.ts` promised to credit exactly that and never did.**
Its comment has named "an out-of-flow pseudo-element — which is exactly the
pattern `ui/checkbox.tsx` uses" since the rule was written, while the code only
ever measured an ancestor `<label>`. It also tested `type === "checkbox"`,
which never matches, because Radix renders a checkbox as
`<button role="checkbox">` with no `type` at all.

So the sweep was reporting a control that had been deliberately fixed, and the
fix came within one commit of being replaced by something worse.

The rule now measures a pseudo-element's height when it is out of flow, has
content, and takes pointer events. **`pointer-events` is the load-bearing
condition** — a decorative overlay is commonly a large absolute pseudo-element
with `pointer-events: none`, and crediting one would make the rule a rubber
stamp.

Verified by measurement and by mutation, with the wrapping label removed so
only the pseudo-element could supply the hit area:

| | result |
|---|---|
| `::before` 44×44, `pointer-events: auto` | **passes** — and a synthetic click 14px above the visible square really does toggle the control |
| `::before` shrunk to 24×24 | **fails** |
| `::before` 44×44 but `pointer-events: none` | **fails** |

Label credit was also extended to `role="checkbox"` / `role="radio"`, and that
one needed checking rather than assuming: browsers do not forward a label click
to a `<button>`, which is why the original rule scoped label credit by tag. But
Radix keeps a hidden native input for form submission and the label activates
*that* — clicking the second line of the reassign label's text toggles the
control, measured.

**Consequence: four of the original twenty-two findings were false positives**
— the reassign checkbox, and the row-selection checkboxes on `/platform/users`
(×51), `/invoices` (×9) and `/zones` (×2). They are struck through above rather
than deleted, because "we fixed it" and "it was never broken" are different
facts and the count should not quietly absorb the difference.


### 6.9 Cleared to zero, 2026-08-19

The last four, and one method note worth more than any of them.

| | was | fix |
|---|---|---|
| the settings tab rail | **28.0px x21**, on *every* settings page | the highest-count finding in the sweep; height only, the rail already scrolled |
| `/settings/users` role select | 40.0px | four short |
| `/settings/scheduling` weekday pills | **26.0px x7** | a pill is round, so the minimum goes on both axes or Sunday becomes an oval |
| `/settings/online-signup` switch | 20.0px | `ui/switch.tsx` had no hit area at all, unlike `ui/checkbox.tsx`; it now borrows the same `::before` |
| `/platform/tenants` status filter | 36.0px | `sm:py-1` shrank it above the phone breakpoint, and the phone value was never large enough either |
| `/notifications` All / Unread | 32.0px x2 | |
| audit diff overflow | **465px in 360px** | the wrapper had `min-w-0` and the SPAN did not |

**`break-words` does not do what the audit-diff fix needed.** It is
`overflow-wrap: break-word`, which breaks a long word once the box is already
narrower than it — it does **not** reduce the element's min-content width. So a
flex item carrying `break-words` still refuses to shrink below the longest
unbroken token, and 325px of
`platform.operations.oncall@houndstack.com` set the width of the page. The box
has to be allowed to get narrow at *every* level, not just the outermost.

### 6.10 The `sr-only` span that scrolled `/clients` 663px

Worth its own entry because nothing about it looks like a layout bug.

`/clients` at 768px measured **1431px** of horizontal scroll. The table was
already inside `<div className="overflow-x-auto">` — exactly what CLAUDE.md
prescribes, and `wide-things-that-set-the-width-of-the-page.test.ts` was green.
The wrapper measured 464px with `overflow-x: auto`, correctly clipping. Every
ancestor fitted.

The cause was one element: `<span class="sr-only">Actions</span>` — the screen
reader label on the Actions column header, 1x1px, at x=1430. Tailwind's
`sr-only` is `position: absolute`, and **overflow clipping does not apply to an
absolutely-positioned descendant whose containing block is outside the
scroller**. The wrapper was `position: static`, so it was not that containing
block, and the span escaped.

`ui/table.tsx` wraps its table in `relative w-full overflow-auto`. Twenty-two
hand-rolled wrappers copied the `overflow-x-auto` and not the `relative`. All
twenty-two now have it, and
`tests/a-screen-reader-label-that-dragged-the-page-sideways.test.ts` keeps them
that way — the browser found this once because that page happened to have an
`sr-only` in a table, and the other twenty-one were one tooltip or one badge
away from the same fault.

**Method note, which cost a cycle to learn:** a clipped element still reports a
wide `getBoundingClientRect()`. A scan that ranks by rect will confidently name
something inside a scroll container that cannot possibly affect the page. Skip
anything with a clipping ancestor, and then look for what is left — which for
this fault meant looking specifically at absolutely-positioned elements,
because those are the ones that escape.
