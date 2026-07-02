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

type DayRisk = {
  risky: boolean;
  reasons: string[];
  precip_mm: number;
  precip_prob: number;
  wind_max: number;
  temp_max: number;
  temp_min: number;
  weathercode: number;
};

async function fetchDayRisk(lat: number, lon: number, date: string): Promise<DayRisk | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set(
    "daily",
    "precipitation_sum,precipitation_probability_max,windspeed_10m_max,temperature_2m_max,temperature_2m_min,weathercode",
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  try {
    const r = await fetch(url.toString());
    if (!r.ok) return null;
    const j: any = await r.json();
    const d = j.daily;
    if (!d?.time?.length) return null;
    const base = {
      precip_mm: Number(d.precipitation_sum?.[0] ?? 0),
      precip_prob: Number(d.precipitation_probability_max?.[0] ?? 0),
      wind_max: Number(d.windspeed_10m_max?.[0] ?? 0),
      temp_max: Number(d.temperature_2m_max?.[0] ?? 0),
      temp_min: Number(d.temperature_2m_min?.[0] ?? 0),
      weathercode: Number(d.weathercode?.[0] ?? 0),
    };
    const reasons: string[] = [];
    if (base.precip_mm >= 5) reasons.push(`${base.precip_mm.toFixed(1)}mm rain`);
    if (base.precip_prob >= 70) reasons.push(`${base.precip_prob}% chance`);
    if (base.wind_max >= 40) reasons.push(`wind ${Math.round(base.wind_max)}km/h`);
    if (base.weathercode >= 95) reasons.push("thunderstorm");
    if (base.temp_max <= -5) reasons.push("hard freeze");
    return { ...base, risky: reasons.length > 0, reasons };
  } catch {
    return null;
  }
}

export const analyzeDayWeather = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const [zonesRes, subsRes, visitsRes] = await Promise.all([
      supabase
        .from("zones")
        .select("id, name, latitude, longitude")
        .eq("organization_id", orgId),
      supabase.from("subscriptions").select("id, zone_id").eq("organization_id", orgId),
      supabase
        .from("visits")
        .select("id, subscription_id, status, assigned_staff_id")
        .eq("organization_id", orgId)
        .eq("scheduled_on", data.day)
        .in("status", ["scheduled", "in_progress"]),
    ]);
    if (zonesRes.error) throw new Error(zonesRes.error.message);

    const subZone = new Map<string, string | null>();
    (subsRes.data ?? []).forEach((s: any) => subZone.set(s.id, s.zone_id));

    const visits = visitsRes.data ?? [];
    const visitsByZone = new Map<string | null, string[]>();
    for (const v of visits) {
      const zid = (subZone.get(v.subscription_id) ?? null) as string | null;
      if (!visitsByZone.has(zid)) visitsByZone.set(zid, []);
      visitsByZone.get(zid)!.push(v.id);
    }

    const zoneReports: Array<{
      zone_id: string;
      name: string;
      risky: boolean;
      reasons: string[];
      visit_count: number;
      flagged_visit_ids: string[];
      precip_prob?: number;
      wind_max?: number;
      temp_max?: number;
    }> = [];
    const flaggedIds = new Set<string>();

    await Promise.all(
      (zonesRes.data ?? []).map(async (z: any) => {
        const ids = visitsByZone.get(z.id) ?? [];
        if (ids.length === 0) return;
        if (z.latitude == null || z.longitude == null) {
          zoneReports.push({
            zone_id: z.id,
            name: z.name,
            risky: false,
            reasons: ["no coordinates"],
            visit_count: ids.length,
            flagged_visit_ids: [],
          });
          return;
        }
        const risk = await fetchDayRisk(z.latitude, z.longitude, data.day);
        if (!risk) {
          zoneReports.push({
            zone_id: z.id,
            name: z.name,
            risky: false,
            reasons: ["forecast unavailable"],
            visit_count: ids.length,
            flagged_visit_ids: [],
          });
          return;
        }
        if (risk.risky) ids.forEach((id) => flaggedIds.add(id));
        zoneReports.push({
          zone_id: z.id,
          name: z.name,
          risky: risk.risky,
          reasons: risk.reasons,
          visit_count: ids.length,
          flagged_visit_ids: risk.risky ? ids : [],
          precip_prob: risk.precip_prob,
          wind_max: risk.wind_max,
          temp_max: risk.temp_max,
        });
      }),
    );

    // Persist flags on visits table
    const noteByVisit = new Map<string, string>();
    for (const zr of zoneReports) {
      if (!zr.risky) continue;
      const note = zr.reasons.join(", ");
      for (const id of zr.flagged_visit_ids) noteByVisit.set(id, note);
    }
    const allIds = visits.map((v: any) => v.id);
    const flaggedArr = Array.from(flaggedIds);
    const unflaggedArr = allIds.filter((id: string) => !flaggedIds.has(id));

    if (unflaggedArr.length > 0) {
      await supabase
        .from("visits")
        .update({ weather_flagged: false, weather_note: null })
        .in("id", unflaggedArr);
    }
    // Update flagged one by one to include per-visit note (short list)
    for (const id of flaggedArr) {
      await supabase
        .from("visits")
        .update({ weather_flagged: true, weather_note: noteByVisit.get(id) ?? "weather risk" })
        .eq("id", id);
    }

    return {
      day: data.day,
      total_visits: visits.length,
      flagged_count: flaggedArr.length,
      flagged_visit_ids: flaggedArr,
      zones: zoneReports.sort((a, b) => Number(b.risky) - Number(a.risky) || a.name.localeCompare(b.name)),
      analyzed_at: new Date().toISOString(),
    };
  });
