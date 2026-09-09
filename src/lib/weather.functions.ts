import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

// ── UNITS ─────────────────────────────────────────────────────────────────
//
// Open-Meteo's defaults are Celsius, km/h and millimetres, and this request
// never asked it for anything else. The person reading the resulting board
// runs a pet-waste business in the United States. They saw "36°" on a 97°F
// day, a bare "23" next to a wind icon with no unit at all, and a "hard
// freeze" warning wired to `temp_max <= -5` — a number no US forecast prints.
//
// The request now asks for fahrenheit / mph / inch, so the numbers are right
// at the source instead of being converted on the way to each screen. One
// place to be wrong rather than five, and the field names below say which
// unit they are in so the next reader does not have to find this comment.
//
// `precip_prob` is a percentage and is the same in any unit system.
export type DayForecast = {
  date: string;
  precip_in: number;
  precip_prob: number;
  /** Miles per hour. */
  wind_max: number;
  /** Degrees Fahrenheit. */
  temp_max: number;
  /** Degrees Fahrenheit. */
  temp_min: number;
  weathercode: number;
  risky: boolean;
  reasons: string[];
};

/** What makes a day risky to run a route in.
 *
 *  These are the SAME thresholds as before, restated in the units the reader
 *  uses: -5°C is 23°F, 40 km/h is 25 mph, 5mm is 0.2in. Changing units must
 *  not quietly change policy — if any of these lines is wrong for the work,
 *  that is a separate decision, made deliberately, by someone who knows what
 *  a crew will and will not go out in. */
function assessRisk(day: Omit<DayForecast, "risky" | "reasons">): {
  risky: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (day.precip_in >= 0.2) reasons.push(`${day.precip_in.toFixed(2)}" rain`);
  if (day.precip_prob >= 70) reasons.push(`${day.precip_prob}% chance`);
  if (day.wind_max >= 25) reasons.push(`wind ${Math.round(day.wind_max)} mph`);
  if (day.weathercode >= 95) reasons.push("thunderstorm");
  if (day.temp_max <= 23) reasons.push("hard freeze");
  return { risky: reasons.length > 0, reasons };
}

/** The unit system this build asks Open-Meteo for.
 *
 *  Written into `weather_forecast_cache.units` and part of that table's key.
 *  A cached payload is bare numbers — nothing about it says which system it
 *  came from — so without this, flipping the request would have served every
 *  existing Celsius row as Fahrenheit, immediately for three hours and then
 *  indefinitely through the stale-on-error fallback. */
const FORECAST_UNITS = "imperial";

async function fetchForecast(
  lat: number,
  lon: number,
  from: string,
  to: string,
): Promise<DayForecast[]> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  // Open-Meteo's current daily variable names are snake_case with underscores
  // (weather_code, wind_speed_10m_max). The legacy names (weathercode,
  // windspeed_10m_max) return HTTP 400 "invalid variable", which was being
  // swallowed and shown as an empty "No forecast available" (finding #15).
  url.searchParams.set(
    "daily",
    "precipitation_sum,precipitation_probability_max,wind_speed_10m_max,temperature_2m_max,temperature_2m_min,weather_code",
  );
  // See the units note above. Open-Meteo converts server-side, so nothing
  // downstream has to know a conversion happened.
  //
  // These three lines are duplicated in supabase/functions/weather-forecast,
  // which relays this exact request and is the path that actually runs in
  // production. If only one of the two is changed, the units of the forecast
  // depend on which network route succeeded — the same board showing °F or °C
  // depending on the day. The old "keep in sync with the server" comment was
  // not a mechanism; tests/a-forecast-in-degrees-nobody-here-uses.test.ts is.
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", from);
  url.searchParams.set("end_date", to);

  // The app server's egress cannot always reach open-meteo directly (the
  // forecast cache had NEVER been populated in production — every zone card
  // errored). Try direct first, then fall through to the weather-forecast
  // Supabase Edge Function, which has unrestricted egress and mirrors this
  // exact request.
  let resp: Response | null = null;
  try {
    resp = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) });
  } catch {
    resp = null;
  }
  if (!resp || !resp.ok) {
    const supabaseUrl = process.env.SUPABASE_URL;
    // Same precedence as client.server.ts (SUPABASE_* prefix is reserved in
    // Lovable secrets, so the user-managed name comes first).
    const serviceKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl && serviceKey) {
      try {
        const relay = await fetch(`${supabaseUrl}/functions/v1/weather-forecast`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ latitude: lat, longitude: lon, fromDate: from, toDate: to }),
          signal: AbortSignal.timeout(15_000),
        });
        if (relay.ok) resp = relay;
        else if (!resp) resp = relay;
      } catch {
        // keep the direct-fetch failure below
      }
    }
  }
  if (!resp) throw new Error("Weather API unreachable");
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Weather API ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const j: any = await resp.json();
  const d = j.daily;
  const out: DayForecast[] = [];
  for (let i = 0; i < (d?.time?.length ?? 0); i++) {
    const base = {
      date: d.time[i],
      precip_in: Number(d.precipitation_sum?.[i] ?? 0),
      precip_prob: Number(d.precipitation_probability_max?.[i] ?? 0),
      wind_max: Number(d.wind_speed_10m_max?.[i] ?? 0),
      temp_max: Number(d.temperature_2m_max?.[i] ?? 0),
      temp_min: Number(d.temperature_2m_min?.[i] ?? 0),
      weathercode: Number(d.weather_code?.[i] ?? 0),
    };
    out.push({ ...base, ...assessRisk(base) });
  }
  return out;
}

// Open-Meteo's free tier rate-limits daily; in production every zone card
// surfaced a raw "Weather API 429: {...}" and auto-rebalance silently no-oped
// (P1.14). Forecasts change slowly, so cache per rounded coordinate + range:
// fresh rows (<3h) skip the API; on an API failure a stale row of any age is
// served instead of an error; only a cold cache surfaces a (humanized) error.
const CACHE_FRESH_MS = 3 * 60 * 60 * 1000;

function humanizeWeatherError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/429|rate|limit/i.test(msg)) {
    return "The weather service is temporarily rate-limited. The forecast will refresh automatically. Try again in a little while.";
  }
  return "Couldn't load the forecast (weather service error). Try again shortly.";
}

// The payload column is jsonb; never trust its shape blindly (a malformed row
// would crash .map() for every org sharing the coordinates).
function validForecast(payload: unknown): DayForecast[] | null {
  if (!Array.isArray(payload)) return null;
  return payload.every((d) => d && typeof d === "object" && typeof (d as any).date === "string")
    ? (payload as DayForecast[])
    : null;
}

// Exported for reuse by analyzeDayWeather (weather-day.functions.ts): the
// single-day analysis used to fetch Open-Meteo directly with no cache and no
// edge-function relay, so it silently reported "forecast unavailable" in
// exactly the environments the cache/relay were added for. Server-only —
// always reach it via a dynamic import inside a server-fn handler.
export async function cachedForecast(
  supabase: any,
  lat: number,
  lon: number,
  from: string,
  to: string,
): Promise<{ forecast: DayForecast[]; stale: boolean }> {
  const latKey = lat.toFixed(2);
  const lonKey = lon.toFixed(2);
  const { data: row } = await supabase
    .from("weather_forecast_cache")
    .select("payload, fetched_at")
    .eq("lat_key", latKey)
    .eq("lon_key", lonKey)
    .eq("from_date", from)
    .eq("to_date", to)
    // Without this the stale-on-error branch below would happily serve a
    // Celsius row from before the unit change, at any age, as Fahrenheit.
    .eq("units", FORECAST_UNITS)
    .maybeSingle();

  const cached = row ? validForecast(row.payload) : null;
  if (cached && Date.now() - new Date(row.fetched_at).getTime() < CACHE_FRESH_MS) {
    return { forecast: cached, stale: false };
  }

  try {
    const forecast = await fetchForecast(lat, lon, from, to);
    // Cache writes are service-role only (browser-facing roles can read the
    // shared cache but never write it — QA: cross-tenant poisoning vector).
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: writeErr } = await (supabaseAdmin as any).from("weather_forecast_cache").upsert(
      {
        lat_key: latKey,
        lon_key: lonKey,
        from_date: from,
        to_date: to,
        units: FORECAST_UNITS,
        payload: forecast,
        fetched_at: new Date().toISOString(),
      },
      // Must match the table's unique constraint exactly. Omitting `units`
      // here would target a constraint that no longer exists and turn every
      // cache write into an error.
      { onConflict: "lat_key,lon_key,from_date,to_date,units" },
    );
    if (writeErr) {
      // A silently dead cache would quietly reintroduce the 429s.
      console.error("weather cache write failed", writeErr.message);
    } else {
      // Opportunistic eviction: date-ranged keys accrete forever otherwise.
      void (supabaseAdmin as any)
        .from("weather_forecast_cache")
        .delete()
        .lt("fetched_at", new Date(Date.now() - 14 * 86400_000).toISOString())
        .then(() => {});
    }
    return { forecast, stale: false };
  } catch (e) {
    if (cached) {
      // Serve yesterday's forecast over no forecast at all.
      return { forecast: cached, stale: true };
    }
    throw new Error(humanizeWeatherError(e));
  }
}

const rangeSchema = z.object({
  fromDate: z.string(),
  toDate: z.string(),
});

export const getWeatherForZones = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => rangeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: zonesRaw, error } = await supabase
      .from("zones")
      .select("id, name, postal_prefix, latitude, longitude, center_latitude, center_longitude")
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    // Zone pin first, else the coverage center — a radius zone drawn on the
    // map has a center but often no pin, and was wrongly reported as
    // "missing coordinates".
    const zones = (zonesRaw ?? []).map((z: any) => ({
      ...z,
      latitude: z.latitude ?? (z.center_latitude != null ? Number(z.center_latitude) : null),
      longitude: z.longitude ?? (z.center_longitude != null ? Number(z.center_longitude) : null),
    }));

    // visit counts per zone per day
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("id, zone_id")
      .eq("organization_id", orgId);
    const subZone = new Map<string, string | null>();
    (subs ?? []).forEach((s: any) => subZone.set(s.id, s.zone_id));

    const { data: visits } = await supabase
      .from("visits")
      .select("id, scheduled_on, subscription_id, status")
      .eq("organization_id", orgId)
      .gte("scheduled_on", data.fromDate)
      .lte("scheduled_on", data.toDate)
      .in("status", ["scheduled", "in_progress"]);

    const counts = new Map<string, number>(); // key: zoneId|date
    (visits ?? []).forEach((v: any) => {
      const zid = subZone.get(v.subscription_id) ?? "unassigned";
      const key = `${zid}|${v.scheduled_on}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });

    const results = await Promise.all(
      (zones ?? []).map(async (z: any) => {
        let forecast: DayForecast[] = [];
        // Distinguish three states for the UI (finding #15): no coordinates,
        // a real fetch error, and a genuinely empty/clear forecast.
        let status: "ok" | "no_coords" | "error" = "ok";
        let error: string | null = null;
        let stale = false;
        if (z.latitude == null || z.longitude == null) {
          status = "no_coords";
        } else {
          try {
            const cached = await cachedForecast(
              supabase,
              z.latitude,
              z.longitude,
              data.fromDate,
              data.toDate,
            );
            forecast = cached.forecast;
            stale = cached.stale;
          } catch (e) {
            status = "error";
            error = e instanceof Error ? e.message : "Weather service unavailable";
            console.error(`weather fetch failed for zone ${z.id}`, error);
          }
        }
        const withCounts = forecast.map((f) => ({
          ...f,
          visit_count: counts.get(`${z.id}|${f.date}`) ?? 0,
        }));
        return {
          id: z.id,
          name: z.name,
          postal_prefix: z.postal_prefix,
          latitude: z.latitude,
          longitude: z.longitude,
          status,
          error,
          stale,
          days: withCounts,
        };
      }),
    );
    return { zones: results };
  });

// ── Org work-days awareness for reschedule targets ──────────────────────────
// Mirrors generate_visits_core (20260719110000_org-work-days.sql): a target
// date on a blackout always shifts forward; a target off an org working day
// shifts forward too, UNLESS the visit's subscription carries explicit
// preferred_weekdays (a client-agreed Saturday stays a Saturday).

function isoDow(iso: string): number {
  return new Date(iso + "T00:00:00Z").getUTCDay();
}

async function loadWorkDays(supabase: any, orgId: string): Promise<number[]> {
  const { data } = await (supabase.from("organizations") as any)
    .select("work_days")
    .eq("id", orgId)
    .maybeSingle();
  const wd = data?.work_days as number[] | null | undefined;
  return Array.isArray(wd) && wd.length > 0 ? wd : [0, 1, 2, 3, 4, 5, 6];
}

async function loadBlackouts(
  supabase: any,
  orgId: string,
  from: string,
  to: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("blackout_dates")
    .select("blackout_on")
    .eq("organization_id", orgId)
    .gte("blackout_on", from)
    .lte("blackout_on", to);
  return new Set((data ?? []).map((b: any) => b.blackout_on as string));
}

/** Shift `date` forward off blackouts and (when the subscription has no
 * explicit preferred weekdays) off non-working days. Same 14-day guard as the
 * SQL shift loop. */
function shiftToAllowedDay(
  date: string,
  opts: { workDays: number[]; blackouts: Set<string>; hasPrefs: boolean },
): string {
  let cand = date;
  let guard = 0;
  while (
    (opts.blackouts.has(cand) ||
      (!opts.hasPrefs && !opts.workDays.includes(isoDow(cand)))) &&
    guard < 14
  ) {
    cand = addDays(cand, 1);
    guard += 1;
  }
  return cand;
}

export const rescheduleVisits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitIds: z.array(z.string().uuid()).min(1),
        newDate: z.string(),
        note: z.string().max(240).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    let moved = 0;
    const errors: string[] = [];
    const moves: { visitId: string; from: string; to: string }[] = [];

    // Snapshot pre-move dates + client refs for email, plus each visit's
    // subscription weekday preferences (those exempt the visit from the org
    // work-day shift, mirroring generate_visits_core).
    const { data: preRows } = await supabase
      .from("visits")
      .select(
        "id, scheduled_on, client_id, properties(visit_contact_email), subscriptions(preferred_weekdays)",
      )
      .in("id", data.visitIds);
    const preMap = new Map<
      string,
      { scheduled_on: string; client_id: string; contact_email: string | null; hasPrefs: boolean }
    >();
    (preRows ?? []).forEach((r: any) => {
      const prop = Array.isArray(r.properties) ? r.properties[0] : r.properties;
      const sub = Array.isArray(r.subscriptions) ? r.subscriptions[0] : r.subscriptions;
      preMap.set(r.id, {
        scheduled_on: r.scheduled_on,
        client_id: r.client_id,
        contact_email: prop?.visit_contact_email ?? null,
        hasPrefs: Array.isArray(sub?.preferred_weekdays) && sub.preferred_weekdays.length > 0,
      });
    });

    // Respect org work days when picking the actual target date: the same
    // shift rule visit generation uses, so a weather reschedule can't dump a
    // route onto a day the business doesn't operate. preferred_weekdays win.
    const workDays = await loadWorkDays(supabase, orgId);
    const blackouts = await loadBlackouts(supabase, orgId, data.newDate, addDays(data.newDate, 14));

    for (const id of data.visitIds) {
      const pre = preMap.get(id);
      const target = shiftToAllowedDay(data.newDate, {
        workDays,
        blackouts,
        hasPrefs: pre?.hasPrefs ?? false,
      });
      const { error } = await supabase.rpc("reschedule_visit", {
        _visit_id: id,
        _new_date: target,
        _note: data.note ?? undefined,
      });
      if (error) errors.push(error.message);
      else {
        moved++;
        if (pre) moves.push({ visitId: id, from: pre.scheduled_on, to: target });
      }
    }

    // Fire weather-reschedule emails (best-effort) — only for visits that
    // actually moved, and with each visit's REAL target date (which may have
    // been shifted off a non-working day).
    // How many customers were NOT told their visit moved.
    //
    // This used to be one try around the whole loop, which had two faults and
    // the second is the one that mattered. It was silent -- the caller got
    // `moved` and nothing else, so the strip said "Moved 14 visits" whether or
    // not a single email went out. And because the await was inside the try
    // rather than the loop body, a throw on the SECOND customer skipped every
    // remaining one: fourteen moved visits, one notified customer, no signal.
    //
    // In this trade an unsent reschedule is a locked gate and a dog in the yard
    // on a day nobody is coming. It is not a nicety to be logged.
    let notifyFailed = 0;
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    const seen = new Set<string>();
    for (const m of moves) {
      const pre = preMap.get(m.visitId);
      if (!pre) continue;
      // Dedupe per destination+target date — a property contact (P3.5) and
      // the account contact are distinct recipients.
      const key = `${pre.contact_email ?? pre.client_id}|${m.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Per customer, so one bad address cannot silence the rest of the round.
      try {
        await enqueueAppEmail({
          organizationId: orgId,
          clientId: pre.client_id,
          templateName: "weather-reschedule",
          notifyKey: "notify_email_weather_reschedule",
          idempotencyKey: `weather-${m.visitId}-${m.to}`,
          toOverride: pre.contact_email || undefined,
          templateData: {
            originalDate: pre.scheduled_on,
            newDate: m.to,
            reason: data.note,
          },
        });
      } catch (e) {
        notifyFailed++;
        console.error("weather reschedule email failed for visit", m.visitId, e);
      }
    }

    return { moved, errors, moves, notifyFailed };
  });

export const undoReschedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        moves: z
          .array(z.object({ visitId: z.string().uuid(), from: z.string(), to: z.string() }))
          .min(1),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let restored = 0;
    const errors: string[] = [];
    for (const m of data.moves) {
      const { error } = await supabase.rpc("reschedule_visit", {
        _visit_id: m.visitId,
        _new_date: m.from,
        _note: "Undo weather reschedule",
      });
      if (error) errors.push(error.message);
      else restored++;
    }
    return { restored, errors };
  });

// Used by shiftToAllowedDay and the blackout window above. It sat under a
// "Session 13a: dispatch intelligence" header along with four server functions
// that no screen ever called; they are gone and this is the one survivor.
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

