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

function assessRisk(day: Omit<DayForecast, "risky" | "reasons">): { risky: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (day.precip_mm >= 5) reasons.push(`${day.precip_mm.toFixed(1)}mm rain`);
  if (day.precip_prob >= 70) reasons.push(`${day.precip_prob}% chance`);
  if (day.wind_max >= 40) reasons.push(`wind ${Math.round(day.wind_max)}km/h`);
  if (day.weathercode >= 95) reasons.push("thunderstorm");
  if (day.temp_max <= -5) reasons.push("hard freeze");
  return { risky: reasons.length > 0, reasons };
}

async function fetchForecast(lat: number, lon: number, from: string, to: string): Promise<DayForecast[]> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "daily",
    "precipitation_sum,precipitation_probability_max,windspeed_10m_max,temperature_2m_max,temperature_2m_min,weathercode",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", from);
  url.searchParams.set("end_date", to);
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`Weather API ${resp.status}`);
  const j: any = await resp.json();
  const d = j.daily;
  const out: DayForecast[] = [];
  for (let i = 0; i < (d?.time?.length ?? 0); i++) {
    const base = {
      date: d.time[i],
      precip_mm: Number(d.precipitation_sum?.[i] ?? 0),
      precip_prob: Number(d.precipitation_probability_max?.[i] ?? 0),
      wind_max: Number(d.windspeed_10m_max?.[i] ?? 0),
      temp_max: Number(d.temperature_2m_max?.[i] ?? 0),
      temp_min: Number(d.temperature_2m_min?.[i] ?? 0),
      weathercode: Number(d.weathercode?.[i] ?? 0),
    };
    out.push({ ...base, ...assessRisk(base) });
  }
  return out;
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
        if (z.latitude != null && z.longitude != null) {
          try {
            forecast = await fetchForecast(z.latitude, z.longitude, data.fromDate, data.toDate);
          } catch (e) {
            forecast = [];
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
      .select("id, scheduled_on, status, subscription_id, subscriptions(client_id, clients(display_name))")
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
        client_name: v.subscriptions?.clients?.display_name ?? "—",
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

    // Snapshot pre-move dates + client refs for email
    const { data: preRows } = await supabase
      .from("visits")
      .select("id, scheduled_on, client_id")
      .in("id", data.visitIds);
    const preMap = new Map<string, { scheduled_on: string; client_id: string }>();
    (preRows ?? []).forEach((r: any) => preMap.set(r.id, { scheduled_on: r.scheduled_on, client_id: r.client_id }));

    for (const id of data.visitIds) {
      const { error } = await supabase.rpc("reschedule_visit", {
        _visit_id: id,
        _new_date: data.newDate,
        _note: data.note ?? undefined,
      });
      if (error) errors.push(error.message);
      else moved++;
    }

    // Fire weather-reschedule emails (best-effort)
    try {
      const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
      const seen = new Set<string>();
      for (const id of data.visitIds) {
        const pre = preMap.get(id);
        if (!pre) continue;
        // Dedupe per client+newDate
        const key = `${pre.client_id}|${data.newDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await enqueueAppEmail({
          organizationId: orgId,
          clientId: pre.client_id,
          templateName: "weather-reschedule",
          notifyKey: "notify_email_weather_reschedule",
          idempotencyKey: `weather-${id}-${data.newDate}`,
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

    return { moved, errors };
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
