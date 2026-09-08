// Server side of the zone-coverage check. Reads only.
//
// It recomputes the matcher over every property rather than reading
// `auto_zone_id`, because `auto_zone_id` is the value that goes stale and the
// question is what the rules say NOW. See the note at the top of
// zone-coverage.ts.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import {
  computeZoneCoverage,
  describeCoverageProblem,
  type CoverageProperty,
  type CoverageZone,
} from "@/lib/zone-coverage";

export const getZoneCoverage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { orgId } = await resolveCaller(supabase, userId);

    const { data: zones, error: zErr } = await (supabase as any)
      .from("zones")
      .select(
        "id, name, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes",
      )
      .eq("organization_id", orgId);
    if (zErr) throw new Error(zErr.message);

    // Every property, not only the ones with an active service. A property
    // parked outside every zone is a pricing problem the moment somebody
    // starts service on it, and the zones page is where that gets noticed.
    const { data: props, error: pErr } = await (supabase as any)
      .from("properties")
      .select("id, postal_code, latitude, longitude, account_type, zone_id")
      .eq("organization_id", orgId);
    if (pErr) throw new Error(pErr.message);

    const shapedProps: CoverageProperty[] = (props ?? []).map((p: any) => ({
      id: p.id as string,
      postalCode: p.postal_code ?? null,
      point:
        p.latitude != null && p.longitude != null
          ? { lat: Number(p.latitude), lng: Number(p.longitude) }
          : null,
      accountType: (p.account_type ?? null) as "residential" | "commercial" | null,
      storedZoneId: p.zone_id ?? null,
    }));

    const coverage = computeZoneCoverage((zones ?? []) as CoverageZone[], shapedProps);

    // The per-property rows are not sent: the page needs the counts and the
    // sentence, and an org with thousands of properties should not ship
    // thousands of rows to render one banner.
    const { rows: _rows, ...summary } = coverage;
    return { summary, problem: describeCoverageProblem(coverage) };
  });
