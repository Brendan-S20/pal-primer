# Google Maps Platform spend: the $25/month alert

**Status: NOT SET UP.** As of 2026-11-09, nothing in this repository can create
a Google Cloud budget, and no budget has been confirmed to exist. Until someone
creates it in the Google Cloud console and ticks the box at the bottom of this
page, **there is no spend alert**. The app-side counting described below is a
trail for investigating spend, not an alert.

## Why

Decision from Brendan, 2026-11-09 (issue #529):

- Geocoding and routing run on **Google Maps Platform** for now, not on
  Geocodio plus a self-hosted OSRM server. No self-hosted router and no new
  paid vendor.
- **If monthly Google Maps spend goes over $25, we need to know.**
- The provider stays behind one interface (`src/lib/providers/config.ts`), so
  routing can move to OSRM later when volume grows: `ROUTING_PROVIDER=osrm`
  plus `OSRM_URL`.
- Weather was dropped from #529.

## What the app calls, and how it is billed

| Feature | Google API (SKU) | Unit billed | Where in the code |
| --- | --- | --- | --- |
| Every map | Maps JavaScript API (Dynamic Maps) | one map load | browser, `src/lib/maps/google-loader.ts` |
| Address search box | Places API (New) Autocomplete | one request | `src/lib/address/google-places.server.ts` |
| Picking a suggestion | Places API (New) Place Details | one request | same file |
| Pin for an address (signup, client edit, import, backfill) | Geocoding API | one request | `src/lib/geocode.server.ts` (`google` adapter) |
| Real drive times for the planner | Routes API, Compute Route Matrix | one **element** = one origin x destination pair | `src/lib/road-legs.server.ts` (`google` adapter) |

The route matrix is the one to watch. It is billed per element, so a day with
24 points (stops plus start points) is 24 x 24 = 576 elements in one request.
The app limits it as follows:

- Requests are `TRAFFIC_UNAWARE` with a field mask, which keeps them on the
  cheapest (Essentials) tier.
- A day with more than 25 points is never sent to Google (625 elements is the
  per-request ceiling). It stays on the planner's estimate.
- A day whose legs were all measured in the last 90 days is not sent at all
  (`everyLegIsFresh`).

Google's prices and free monthly allowances change. Read the current ones at
<https://mapsplatform.google.com/pricing/> rather than trusting a number copied
here.

## The budget alert (Needs Brendan, in the Google Cloud console)

This has to be done by a billing account administrator. It cannot be done from
this repository.

1. Open **Google Cloud console → Billing →** the billing account that pays for
   the Maps project **→ Budgets & alerts → Create budget**.
2. **Scope:**
   - **Projects:** the project that owns the Maps keys.
   - **Services:** select the Maps Platform services the app uses: Maps
     JavaScript API, Places API (New), Geocoding API, Routes API.
   - Leaving services at "All" is also fine, and catches anything added later.
   - Leave **"Include credits in cost"** unticked for "Discounts" and
     "Promotions". Otherwise the free monthly allowance hides real usage until
     it runs out.
3. **Amount:** type **Specified amount**, **$25** per month.
4. **Thresholds:** 50% ($12.50), 90% ($22.50) and 100% ($25) of **actual**
   spend. Add 100% of **forecasted** spend, which warns before the money is
   spent.
5. **Notifications:** email billing admins and users. Add Brendan's address via
   a Cloud Monitoring email channel if he is not a billing admin.
6. Save, and tick the box at the bottom of this page with the date.

What a budget does **not** do: it does not stop spending. It only sends email.

**Optional hard caps (quotas).** If a runaway loop must never cost more than a
known amount, set per-API quotas: **APIs & Services → (API) → Quotas**. For
example:

- Routes API: elements per day
- Geocoding API: requests per day

When a quota is hit, Google refuses further requests. The planner then falls
back to estimates. Geocoding falls back to Nominatim unless
`GEOCODING_FALLBACK=none` is set. No user-facing feature breaks outright, but
pins and drive times get worse. That is a product decision, so it is listed
here rather than made.

## The app-side trail (in this repository)

`src/lib/providers/google-usage.server.ts` counts every billable call the
**server** makes: geocoding requests, route-matrix elements, Places
autocomplete and details. It logs a line on the first call of each UTC month
for each API, and every 500 units after that:

```
[google-maps-usage] month=2026-11 api=route-matrix-elements units_this_process=1152 (per-process count; Google's billing report is authoritative)
```

When the budget email arrives, search the server logs for
`[google-maps-usage]` to see which feature is spending.

Limits of these counts:

- They are **per process and in memory**. Each server instance keeps its own,
  and a restart resets them.
- Map loads in the browser are not counted, because the server never sees
  them.

Google's billing report (**Billing → Reports**, grouped by SKU) is the real
number.

## Keys (Needs Brendan, no secret goes in this repository)

- **`GOOGLE_MAPS_API_KEY`**: the server key for the Geocoding API and the Routes
  API. **The key alone turns nothing on.** Google is used only once
  `ROUTING_PROVIDER=google` and `GEOCODING_PROVIDER=google` are set (see
  "Turning Google on" below). Until then the app keeps its previous behavior:
  OSRM, and Geocodio or Nominatim.
  - Restrict it by API to the **Geocoding API** and **Routes API** only.
  - It has no referrer restriction, because it is used server-side. Never put
    it in a `VITE_` variable.
  - `scripts/routing-trials` already reads this same name.
- **`GOOGLE_PLACES_API_KEY`** (address search) and the browser key
  `GOOGLE_MAPS_BROWSER_KEY` / `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`
  (maps) are unchanged.
- `GOOGLE_MAPS_SERVER_KEY` is not read by anything in this repository.

## Turning Google on (Needs Brendan, after the budget exists)

Merging the code changes nothing in production. Google is enabled by two
hosting secrets, in this order:

1. Create the $25/month budget above, and tick its box in the checklist below.
2. Set `GEOCODING_PROVIDER=google` and `ROUTING_PROVIDER=google`, alongside
   `GOOGLE_MAPS_API_KEY`.
3. Within a day, look for `[google-maps-usage]` lines in the server logs, and
   for Geocoding and Routes rows in Google's billing report.

To turn Google off again, remove both variables, or set them to `osrm` and
`geocodio`/`nominatim`. Nothing else changes.

## Google-derived data is kept 30 days

Decision (Brendan, 2026-11-09): Google-derived data is refreshed or dropped
after 30 days, to comply with Google Maps Platform's caching terms.

**What the app now does:**

- **Every pin records its source.** Each property pin records who produced it
  (`properties.geocode_source`) and when (`properties.geocoded_at`), from
  migration `20261109200000_a-pin-knows-who-placed-it.sql`.
  - The Google sources are `google` (Geocoding API) and `google_places` (a
    pick from the address search box).
  - The other sources are `geocodio`, `nominatim`, `manual`, and NULL for
    unknown.
- **A daily job does the refresh and the purge.** It is
  `/api/public/hooks/google-cache-expiry`, scheduled by pg_cron at 07:23 UTC
  in `20261109200100_google-derived-data-is-kept-thirty-days.sql`. It:
  - deletes `road_legs` rows with `source = 'google'` that are older than 29
    days. Other sources keep the existing weekly 90-day prune.
  - re-geocodes Google-sourced pins from 22 days old, and clears a pin if a
    provider answers that there is no match.
  - if no provider answers (an outage, a refused key, or a mistyped
    `GEOCODING_PROVIDER`), keeps the pin and retries it daily while it is
    under 29 days old. At 29 days the pin is cleared whatever the geocoder
    says. The week of retries sits inside the limit, at the cost of
    refreshing each Google pin about every 22 days instead of every 30, which
    is roughly 35% more geocode calls on those pins.
  - **Why 29 and not 30:** the job runs once a day. With the limit at 30,
    something written one second after a run would first be removed at the
    run 31 days later. Removing at 29 means the run on day 30 always removes
    it, so nothing Google-derived reaches 30 days. If the schedule becomes
    less frequent than daily, the margin in `src/lib/geocode-source.ts` has
    to grow to match.
  - never touches any other source, or a pin of unknown source.
- **The rule lives in one file**, `src/lib/geocode-source.ts`. The tests are in
  `tests/google-derived-data-is-kept-thirty-days.test.ts`.

**What it does not cover (Needs Brendan):**

- **Pins saved before this change** have no source recorded, so they are never
  expired. Pins picked from the Google address box before then are therefore
  kept. Labelling them after the fact would be a guess, and a wrong guess
  deletes a coordinate.
- **Other tables:**
  - `neighbor_leads` (filled from Google Places details) and `organizations` /
    `waste_disposal_facilities` (geocoded) also hold coordinates. These are not
    covered yet.
  - `road_legs` is the only drive-time store.
- **Whether 30 days matches the current terms.** That is still yours to
  confirm against Google's current Service Specific Terms.
- **Cost of the refresh.** Each re-geocode is a billed Geocoding call, so
  about 1/30 of the Google-sourced pins are re-billed each day.

## Checklist

- [ ] Budget created at $25/month with the thresholds above. Date: ______, by: ______
- [ ] `GOOGLE_MAPS_API_KEY` set in the hosting secrets, restricted to the
      Geocoding API and Routes API
- [ ] Only after the budget: `ROUTING_PROVIDER=google` and
      `GEOCODING_PROVIDER=google` set
- [ ] Geocoding API and Routes API enabled on that project
- [x] Caching decision recorded (2026-11-09): refresh or drop after 30 days
- [ ] Confirm the 30-day limit against Google's current Service Specific Terms
