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

## Terms to check before relying on stored results (Needs Brendan)

The app stores coordinates and drive times:

- `clients` / `properties` latitude and longitude
- the `road_legs` cache, for 90 days

Google Maps Platform's service-specific terms limit how long content from the
Geocoding API and Routes API may be cached; at the time of writing,
coordinates may be kept only temporarily. Read the current
**Google Maps Platform Service Specific Terms** for both APIs and decide
whether the stored values need an expiry. Nothing in this change adds one.

## Checklist

- [ ] Budget created at $25/month with the thresholds above. Date: ______, by: ______
- [ ] `GOOGLE_MAPS_API_KEY` set in the hosting secrets, restricted to the
      Geocoding API and Routes API
- [ ] Only after the budget: `ROUTING_PROVIDER=google` and
      `GEOCODING_PROVIDER=google` set
- [ ] Geocoding API and Routes API enabled on that project
- [ ] Caching terms read, and a decision recorded on #529
