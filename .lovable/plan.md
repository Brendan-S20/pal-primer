# Session J — Audit & Polish Pass

Cross-referenced against `CLAUDE.md` and `pooper-scooper-crm-spec.md`. Groups the fixes you called out plus the spec gaps still visible in code.

---

## 1. Field tech language — move to Settings

- Remove `<LanguageToggle />` from the My Day sticky header.
- Add a new tab **Settings → Preferences** (`/settings/preferences`) that owns:
  - Language (English / Spanish, per-user, persisted to the same storage the toggle already uses so techs keep their selection across devices via profile row later).
  - Haptics on/off, "keep screen awake on route" toggle (already partly wired), default map app for directions (Google / Apple / Waze).
- Insert "Preferences" as the first tab in `settings.tsx` so techs land there quickly.

## 2. Client Service Portal — finish the surface

The portal today handles visits, plan, add-ons, top-ups, cards, autopay, invoices. Spec §6.7 and §7 want more. Add:

1. **Service history with photos** — new "Service history" section listing last 20 completed visits with before/after photo thumbnails from `visit_photos` (already stored). Tap to open lightbox. Directly supports "photo-verified proof of service, client-facing."
2. **Report a concern** — button on any completed visit → modal (missed spot / gate left open / other + free text + optional photo upload) → creates an internal QC ticket (new lightweight `qc_tickets` table) and surfaces on staff dashboard alerts strip.
3. **Dogs & property panel** — read-only list of dogs on file (name, breed, temperament badge, photo) plus property access notes (gate code masked behind reveal, hazard flags). Lets the client verify what the tech sees.
4. **Refer a neighbor** — pulls the client's existing referral code, shows share card ("$X off for you and your neighbor"), copy-link + native share button. Sets up the §7 growth loop without the map canvassing (that's staff-side).
5. **Approve a quote / initial cleanup** — if the account has a pending `invoices.kind = 'quote'` or an unapproved initial cleanup, surface it at the top with Accept / Decline (Accept flips status to open + optional autopay charge). Matches Jobber's "Client Hub" best feature.
6. **Header polish** — next visit countdown ("Next visit: Tue Jul 7, arriving ~10–12"), current plan summary chip.
7. **Sign in link for the client** — small footer link so returning clients can bookmark & re-authenticate without hunting for the emailed link (uses portal token + email verify, no full auth account required).

## 3. Platform Admin login

Today `/platform` is gated by the `platform_admin` role but shares the regular `/auth` form and reuses the customer app shell. Add:

- **Dedicated login route** `/admin` (public) with its own branded form, separate copy ("Platform operator sign-in"), and a distinct redirect to `/platform` on success. Refuses non-`platform_admin` users with a clear message and signs them out.
- **Platform shell** — wrap `/platform` in a minimal own layout (no client sidebar, "Platform admin" header, sign-out) so operators never see tenant navigation.
- **Impersonation audit stub** — add `platform_admin_audit` table and log every plan change (already the only mutation) with actor, org, before/after. Foundation for the spec's audit-logged impersonation feature later.
- Sidebar link removed from tenant app to avoid tenant users even seeing "Platform admin" in the sidebar chrome.

## 4. Loose ends visible in the current build

- **Auth page**: no forgot-password link, no `/reset-password` route, no Google sign-in. Add the reset flow (required by rules) and a Google button (behind `configure_social_auth`).
- **Settings index redirect** currently sends to `/settings/skip-rules`. After adding Preferences, redirect there instead — more useful landing.
- **Franchise page**: shows "not a franchise parent" but no CTA. Add "Mark this org as a franchise parent" button (owner-only) that flips `is_franchise_parent`.
- **Dashboard**: "Techs today" list has no completion progress bar per tech — trivial add, uses the numbers we already fetch.
- **Weather × Routes**: batch reschedule works, but no toast summary of what moved. Add "Moved N visits to Jul 8" summary + undo (7-day soft window).
- **Visit detail drawer**: no direct link to property boundary sketch. Add "View yard boundary" if a boundary polygon exists.
- **Imports**: only generic CSV path exists — spec calls out **named importers** (Sweep&Go, Jobber, TTP, Housecall Pro, GorillaDesk). Add a picker screen listing the 5 named sources with per-source column presets; even shipping the picker + Sweep&Go/Jobber presets is a big marketing/UX win.
- **AR / dunning**: no failed-payment retry ladder. Add configurable dunning rules (retry Day 1/3/7, pause on 3rd failure) under Settings → Automation.

## 5. Spec gaps we haven't shipped yet (call out, don't build in this pass)

Flag these so the roadmap stays honest — decide later which to prioritize:

- Neighbor-canvassing map tool (§7 #8) — staff-side map, "invite 5 neighbors on this street" flow.
- Predictive churn score + auto win-back automation (§6.1 P2, §8).
- Seasonal deep-clean campaign trigger (§7 #9).
- AI-drafted marketing copy generation and review responses (§8).
- Weekly AI business digest (§8, "Analyst AI"-style).
- Value-aware AI dispatch (§8, ServiceTitan pattern).
- Commercial DNA-testing compliance integration (§7 #5).
- Native React Native tech + client apps (locked decision in CLAUDE.md #4; web is a stopgap).

---

## Suggested build order this session

1. Move language toggle → Settings → Preferences.
2. Portal completion (service history + concerns + dogs + referral + quote approval).
3. Platform admin login split + audit log.
4. Auth polish (forgot password + Google) and the small loose-end fixes.
5. Named-importer picker scaffold with Sweep&Go + Jobber presets.

Reply "go" to build all five, or name which subset to tackle first.
