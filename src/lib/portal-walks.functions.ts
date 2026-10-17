import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// The portal's walk reports (#410): what the walker recorded, for the client
// who owns the walk. A file of its own so portal.functions.ts, which other
// open work edits, stays as it is.
//
// Same rules as every portal read: the session check first, then the service
// role, filtered by the session's own client and organization. The select
// below names every column it reads, and none of them is an office note or a
// way into the home (tech_note, gate_code, lock_box_code, key_tag): a test
// holds that.

async function portalAuth() {
  return import("@/lib/portal-auth.server");
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const tokenSchema = z.object({ token: z.string().uuid() });

export type PortalWalkReport = {
  visitId: string;
  day: string;
  serviceName: string | null;
  walkerFirstName?: string;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  peeLine?: string;
  pooLine?: string;
  reportNote?: string;
  photos: Array<{ url: string; kind: string }>;
};

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

/** Recent completed walks with their reports, and the arrival window of each
 *  upcoming walk that has one. Empty for a client with no walks, which is
 *  every pet-waste client. */
export const portalListWalks = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const sb = (await admin()) as any;
    const empty = { reports: [] as PortalWalkReport[], upcomingWindows: {} as Record<string, string> };

    const { data: org } = await sb
      .from("organizations")
      .select("timezone, service_lines")
      .eq("id", session.organizationId)
      .maybeSingle();
    const { serviceLinesOrDefault } = await import("@/lib/service-lines");
    if (!serviceLinesOrDefault(org?.service_lines).includes("dog_walking")) return empty;

    const [{ data: done }, { data: upcoming }] = await Promise.all([
      sb
        .from("visits")
        .select(
          "id, scheduled_on, started_at, completed_at, pee, poo, report_note, assigned_staff_id, services!inner(name, service_line), properties(dogs(name, active))",
        )
        .eq("client_id", session.clientId)
        .eq("organization_id", session.organizationId)
        .eq("status", "completed")
        .eq("services.service_line", "dog_walking")
        .order("scheduled_on", { ascending: false })
        .limit(20),
      sb
        .from("visits")
        .select("id, services!inner(service_line), subscriptions(earliest_time, latest_time)")
        .eq("client_id", session.clientId)
        .eq("organization_id", session.organizationId)
        .in("status", ["scheduled", "in_progress"])
        .eq("services.service_line", "dog_walking")
        .limit(60),
    ]);

    const { windowLabel } = await import("@/lib/walk-windows");
    const upcomingWindows: Record<string, string> = {};
    for (const v of (upcoming ?? []) as any[]) {
      const s = one(v.subscriptions) as { earliest_time: string | null; latest_time: string | null } | null;
      const label = windowLabel(s?.earliest_time, s?.latest_time);
      if (label) upcomingWindows[v.id] = label;
    }

    const rows = (done ?? []) as any[];
    if (rows.length === 0) return { reports: [], upcomingWindows };

    const staffIds = [...new Set(rows.map((r) => r.assigned_staff_id).filter(Boolean))];
    const { data: staff } = staffIds.length
      ? await sb.from("staff").select("id, display_name").in("id", staffIds)
      : { data: [] };
    const staffName = new Map(
      ((staff ?? []) as Array<{ id: string; display_name: string | null }>).map((s) => [s.id, s.display_name]),
    );

    const { portalVisitPhotos } = await import("@/lib/portal-visit-photos.server");
    const photosByVisit = await portalVisitPhotos(sb, rows.map((r) => r.id));

    const { walkReportEmail } = await import("@/lib/walk-report");
    const tz = (org?.timezone as string | null) || "America/Chicago";
    const reports: PortalWalkReport[] = rows.map((r) => {
      const dogs = ((one(r.properties) as any)?.dogs ?? []) as Array<{ name: string | null; active: boolean | null }>;
      const report = walkReportEmail({
        startedAt: r.started_at,
        completedAt: r.completed_at,
        timezone: tz,
        pee: r.pee,
        poo: r.poo,
        reportNote: r.report_note,
        dogNames: dogs.filter((d) => d.active !== false).map((d) => d.name),
        walkerName: r.assigned_staff_id ? (staffName.get(r.assigned_staff_id) ?? null) : null,
      });
      const { dogs: dogPhrase, ...fields } = report;
      void dogPhrase;
      return {
        visitId: r.id,
        day: r.scheduled_on,
        serviceName: (one(r.services) as any)?.name ?? null,
        ...fields,
        photos: photosByVisit.get(r.id) ?? [],
      };
    });
    return { reports, upcomingWindows };
  });
