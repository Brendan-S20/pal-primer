import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { DayForecast } from "@/lib/weather.functions";
import { resolveCaller } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  // Through the shared gate, so a person whose access is turned off is
  // refused here as everywhere else (20261009180000).
  return (await resolveCaller(supabase, userId)).orgId;
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
        .select("id, name, latitude, longitude, center_latitude, center_longitude")
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

    // Zone pin first, else the coverage center — same fallback as
    // getWeatherForZones, so a radius zone drawn on the map (center, no pin)
    // isn't wrongly reported as "no coordinates" here while the weather
    // popover happily forecasts it.
    const zones = (zonesRes.data ?? []).map((z: any) => ({
      ...z,
      latitude: z.latitude ?? (z.center_latitude != null ? Number(z.center_latitude) : null),
      longitude: z.longitude ?? (z.center_longitude != null ? Number(z.center_longitude) : null),
    }));

    const subZone = new Map<string, string | null>();
    (subsRes.data ?? []).forEach((s: any) => subZone.set(s.id, s.zone_id));

    const visits = visitsRes.data ?? [];
    const visitsByZone = new Map<string | null, string[]>();
    for (const v of visits) {
      const zid = (subZone.get(v.subscription_id) ?? null) as string | null;
      if (!visitsByZone.has(zid)) visitsByZone.set(zid, []);
      visitsByZone.get(zid)!.push(v.id);
    }

    // Shared cached forecast (dynamic import: server-only helper). The old
    // direct Open-Meteo fetch here bypassed both the shared cache (429s) and
    // the edge-function egress relay, so this analysis reported "forecast
    // unavailable" in exactly the environments those were added for.
    const { cachedForecast } = await import("@/lib/weather.functions");

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
      zones.map(async (z: any) => {
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
        let risk: DayForecast | null = null;
        try {
          const { forecast } = await cachedForecast(
            supabase,
            z.latitude,
            z.longitude,
            data.day,
            data.day,
          );
          risk = forecast.find((f) => f.date === data.day) ?? forecast[0] ?? null;
        } catch {
          risk = null;
        }
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
