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

type DayForecast = {
  date: string;
  precip_mm: number;
  precip_prob: number;
  wind_max: number;
  temp_max: number;
  temp_min: number;
  weathercode: number;
  risky: boolean;
  reasons: string[];
};

function assessRisk(day: Omit<DayForecast, "risky" | "reasons">): {
  risky: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (day.precip_mm >= 5) reasons.push(`${day.precip_mm.toFixed(1)}mm rain`);
  if (day.precip_prob >= 70) reasons.push(`${day.precip_prob}% chance`);
  if (day.wind_max >= 40) reasons.push(`wind ${Math.round(day.wind_max)}km/h`);
  if (day.weathercode >= 95) reasons.push("thunderstorm");
  if (day.temp_max <= -5) reasons.push("hard freeze");
  return { risky: reasons.length > 0, reasons };
}

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
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", from);
  url.searchParams.set("end_date", to);
  const resp = await fetch(url.toString());
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
      precip_mm: Number(d.precipitation_sum?.[i] ?? 0),
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

async function cachedForecast(
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
        payload: forecast,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: "lat_key,lon_key,from_date,to_date" },
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
    const { data: zones, error } = await supabase
      .from("zones")
      .select("id, name, postal_prefix, latitude, longitude")
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);

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

export const getZoneVisitsOnDay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ zoneId: z.string().uuid(), date: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("id")
      .eq("organization_id", orgId)
      .eq("zone_id", data.zoneId);
    const subIds = (subs ?? []).map((s: any) => s.id);
    if (subIds.length === 0) return { visits: [] };
    const { data: visits, error } = await supabase
      .from("visits")
      .select(
        "id, scheduled_on, status, subscription_id, subscriptions(client_id, clients(display_name))",
      )
      .in("subscription_id", subIds)
      .eq("scheduled_on", data.date)
      .in("status", ["scheduled", "in_progress"])
      .order("sequence", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);
    return {
      visits: (visits ?? []).map((v: any) => ({
        id: v.id,
        scheduled_on: v.scheduled_on,
        status: v.status,
        client_name: v.subscriptions?.clients?.display_name ?? "-",
      })),
    };
  });

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

    // Snapshot pre-move dates + client refs for email
    const { data: preRows } = await supabase
      .from("visits")
      .select("id, scheduled_on, client_id, properties(visit_contact_email)")
      .in("id", data.visitIds);
    const preMap = new Map<
      string,
      { scheduled_on: string; client_id: string; contact_email: string | null }
    >();
    (preRows ?? []).forEach((r: any) => {
      const prop = Array.isArray(r.properties) ? r.properties[0] : r.properties;
      preMap.set(r.id, {
        scheduled_on: r.scheduled_on,
        client_id: r.client_id,
        contact_email: prop?.visit_contact_email ?? null,
      });
    });

    for (const id of data.visitIds) {
      const { error } = await supabase.rpc("reschedule_visit", {
        _visit_id: id,
        _new_date: data.newDate,
        _note: data.note ?? undefined,
      });
      if (error) errors.push(error.message);
      else {
        moved++;
        const pre = preMap.get(id);
        if (pre) moves.push({ visitId: id, from: pre.scheduled_on, to: data.newDate });
      }
    }

    // Fire weather-reschedule emails (best-effort)
    try {
      const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
      const seen = new Set<string>();
      for (const id of data.visitIds) {
        const pre = preMap.get(id);
        if (!pre) continue;
        // Dedupe per destination+newDate — a property contact (P3.5) and the
        // account contact are distinct recipients.
        const key = `${pre.contact_email ?? pre.client_id}|${data.newDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await enqueueAppEmail({
          organizationId: orgId,
          clientId: pre.client_id,
          templateName: "weather-reschedule",
          notifyKey: "notify_email_weather_reschedule",
          idempotencyKey: `weather-${id}-${data.newDate}`,
          toOverride: pre.contact_email || undefined,
          templateData: {
            originalDate: pre.scheduled_on,
            newDate: data.newDate,
            reason: data.note,
          },
        });
      }
    } catch (e) {
      console.error("weather reschedule emails failed", e);
    }

    return { moved, errors, moves };
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

export const updateZoneCoords = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { error } = await supabase
      .from("zones")
      .update({ latitude: data.latitude, longitude: data.longitude })
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ---------- Session 13a: dispatch intelligence ----------

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Auto-rebalance: for each zone with coords, find risky days in the window
 * that have scheduled visits, and move them to the next non-risky day within
 * a 14-day lookahead. Skips days that already exceed dailyCap. Returns a
 * per-zone summary.
 */
export const autoRebalanceForecast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        fromDate: z.string(),
        toDate: z.string(),
        dailyCap: z.number().int().min(1).max(500).default(60),
        dryRun: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const { data: zones } = await supabase
      .from("zones")
      .select("id, name, latitude, longitude")
      .eq("organization_id", orgId);

    // Load subscriptions -> zone map (org-scoped)
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("id, zone_id")
      .eq("organization_id", orgId);
    const subZone = new Map<string, string | null>();
    (subs ?? []).forEach((s: any) => subZone.set(s.id, s.zone_id));

    // Load visits in a wider window (window + 14 days lookahead)
    const searchTo = addDays(data.toDate, 14);
    const { data: visits } = await supabase
      .from("visits")
      .select("id, scheduled_on, subscription_id, status")
      .eq("organization_id", orgId)
      .gte("scheduled_on", data.fromDate)
      .lte("scheduled_on", searchTo)
      .in("status", ["scheduled"]);

    // Zone|date -> count (for cap enforcement)
    const dayCounts = new Map<string, number>();
    (visits ?? []).forEach((v: any) => {
      const zid = subZone.get(v.subscription_id) ?? null;
      if (!zid) return;
      const k = `${zid}|${v.scheduled_on}`;
      dayCounts.set(k, (dayCounts.get(k) ?? 0) + 1);
    });

    const summary: Array<{
      zone_id: string;
      zone_name: string;
      moved: number;
      skipped_no_slot: number;
      details: Array<{ visit_id: string; from: string; to: string }>;
    }> = [];

    // Failures used to vanish into an empty summary, which the UI reads as
    // "nothing risky" — count them so the caller can tell "all clear" apart
    // from "couldn't check" / "not allowed" (P1.6).
    let forecastFailures = 0;
    let zonesChecked = 0;
    let rescheduleErrors = 0;
    let firstRescheduleError: string | null = null;

    for (const z of zones ?? []) {
      if (z.latitude == null || z.longitude == null) continue;
      zonesChecked++;
      let forecast: DayForecast[] = [];
      try {
        forecast = (
          await cachedForecast(supabase, z.latitude, z.longitude, data.fromDate, searchTo)
        ).forecast;
      } catch {
        forecastFailures++;
        continue;
      }
      const riskyByDate = new Map(forecast.map((f) => [f.date, f.risky] as const));

      // Zone visits sorted by date
      const zoneVisits = (visits ?? [])
        .filter((v: any) => subZone.get(v.subscription_id) === z.id)
        .filter((v: any) => v.scheduled_on >= data.fromDate && v.scheduled_on <= data.toDate)
        .filter((v: any) => riskyByDate.get(v.scheduled_on) === true)
        .sort((a: any, b: any) => a.scheduled_on.localeCompare(b.scheduled_on));

      let moved = 0;
      let skipped = 0;
      const details: Array<{ visit_id: string; from: string; to: string }> = [];

      for (const v of zoneVisits) {
        // Find nearest safe day within 14 days after original
        let target: string | null = null;
        for (let i = 1; i <= 14; i++) {
          const cand = addDays(v.scheduled_on, i);
          if (riskyByDate.get(cand) === true) continue; // still risky
          if (riskyByDate.get(cand) === undefined) continue; // outside forecast
          const cnt = dayCounts.get(`${z.id}|${cand}`) ?? 0;
          if (cnt >= data.dailyCap) continue;
          target = cand;
          break;
        }
        if (!target) {
          skipped++;
          continue;
        }
        if (!data.dryRun) {
          const { error } = await supabase.rpc("reschedule_visit", {
            _visit_id: v.id,
            _new_date: target,
            _note: "Auto-rebalanced (weather)",
          });
          if (error) {
            rescheduleErrors++;
            if (!firstRescheduleError) firstRescheduleError = error.message;
            skipped++;
            continue;
          }
        }
        // Update counts to inform subsequent moves
        dayCounts.set(
          `${z.id}|${v.scheduled_on}`,
          Math.max(0, (dayCounts.get(`${z.id}|${v.scheduled_on}`) ?? 1) - 1),
        );
        dayCounts.set(`${z.id}|${target}`, (dayCounts.get(`${z.id}|${target}`) ?? 0) + 1);
        moved++;
        details.push({ visit_id: v.id, from: v.scheduled_on, to: target });
      }

      if (moved || skipped) {
        summary.push({
          zone_id: z.id,
          zone_name: z.name,
          moved,
          skipped_no_slot: skipped,
          details,
        });
      }
    }

    return {
      summary,
      dryRun: data.dryRun,
      zonesChecked,
      forecastFailures,
      rescheduleErrors,
      firstRescheduleError,
    };
  });

/**
 * Workload smoothing: per-staff visit counts for a given date, plus a simple
 * balance metric. UI can flag any staff whose count is > 1.5x the median.
 */
export const getStaffWorkload = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ date: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const { data: staff } = await supabase
      .from("staff")
      .select("id, display_name, active")
      .eq("organization_id", orgId)
      .eq("active", true)
      .order("display_name");

    const { data: visits } = await supabase
      .from("visits")
      .select("id, assigned_staff_id, status")
      .eq("organization_id", orgId)
      .eq("scheduled_on", data.date)
      .in("status", ["scheduled", "in_progress"]);

    const counts = new Map<string, number>();
    let unassigned = 0;
    (visits ?? []).forEach((v: any) => {
      if (!v.assigned_staff_id) unassigned++;
      else counts.set(v.assigned_staff_id, (counts.get(v.assigned_staff_id) ?? 0) + 1);
    });

    const rows = (staff ?? []).map((s: any) => ({
      staff_id: s.id,
      name: s.display_name,
      visit_count: counts.get(s.id) ?? 0,
    }));

    const sorted = [...rows].map((r) => r.visit_count).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const threshold = Math.max(median * 1.5, median + 2);
    const overloaded = rows.filter((r) => r.visit_count > threshold).map((r) => r.staff_id);

    return {
      date: data.date,
      staff: rows,
      unassigned,
      median,
      overloaded_staff_ids: overloaded,
      total: (visits ?? []).length,
    };
  });
