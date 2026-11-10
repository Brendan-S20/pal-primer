import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PortalGroomReport } from "@/lib/groom-report";

// The portal's groom reports (#412): the client's recent finished grooms with
// the before and after photos, the add-ons that were billed and the groomer's
// note, and the next groom on the schedule. A file of its own so
// portal-groom.server.ts and portal.functions.ts, which other work edits,
// stay as they are.
//
// Same rules as every portal read: the session check first, then the service
// role, filtered by the session's own client and organization. The visit
// select names every column it reads, and none of them is an office note or
// a way into the home (tech_note, gate_code, lock_box_code, key_tag).

async function portalAuth() {
  return import("@/lib/portal-auth.server");
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export type PortalGroomReports = {
  reports: PortalGroomReport[];
  /** The next groom still to come, if one is on the schedule. */
  next: { day: string; startTime: string | null; serviceName: string | null } | null;
};

export const portalListGroomReports = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }): Promise<PortalGroomReports> => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const sb = await admin();
    const empty: PortalGroomReports = { reports: [], next: null };

    const { data: org, error: orgErr } = await sb
      .from("organizations")
      .select("timezone, service_lines")
      .eq("id", session.organizationId)
      .maybeSingle();
    if (orgErr) throw new Error(orgErr.message);
    const { serviceLinesOrDefault } = await import("@/lib/service-lines");
    if (!org || !serviceLinesOrDefault(org.service_lines).includes("mobile_grooming")) return empty;
    const { orgToday } = await import("@/lib/org-day");
    const today = orgToday(org.timezone ?? undefined);

    const [done, upcoming] = await Promise.all([
      sb
        .from("visits")
        .select(
          "id, scheduled_on, groom_summary, report_note, assigned_staff_id, services!inner(name, service_line)",
        )
        .eq("client_id", session.clientId)
        .eq("organization_id", session.organizationId)
        .eq("status", "completed")
        .eq("services.service_line", "mobile_grooming")
        .order("scheduled_on", { ascending: false })
        .limit(12),
      sb
        .from("visits")
        .select("scheduled_on, start_time, services!inner(name, service_line)")
        .eq("client_id", session.clientId)
        .eq("organization_id", session.organizationId)
        .in("status", ["scheduled", "in_progress"])
        .eq("services.service_line", "mobile_grooming")
        .gte("scheduled_on", today)
        .order("scheduled_on", { ascending: true })
        .order("start_time", { ascending: true, nullsFirst: false })
        .limit(1),
    ]);
    if (done.error) throw new Error(done.error.message);
    if (upcoming.error) throw new Error(upcoming.error.message);

    const nextRow = (upcoming.data ?? [])[0];
    const next = nextRow
      ? {
          day: nextRow.scheduled_on as string,
          startTime: (nextRow.start_time as string | null) ?? null,
          serviceName: one(nextRow.services as { name: string | null } | null)?.name ?? null,
        }
      : null;

    const rows = done.data ?? [];
    if (rows.length === 0) return { reports: [], next };
    const visitIds = rows.map((r) => r.id);

    const staffIds = [
      ...new Set(rows.map((r) => r.assigned_staff_id).filter((v): v is string => !!v)),
    ];
    const [staff, charges] = await Promise.all([
      staffIds.length
        ? sb
            .from("staff")
            .select("id, display_name")
            .eq("organization_id", session.organizationId)
            .in("id", staffIds)
        : Promise.resolve({ data: [], error: null }),
      sb
        .from("addon_charges")
        .select("visit_id, description, quantity, status")
        .eq("organization_id", session.organizationId)
        .eq("client_id", session.clientId)
        .in("visit_id", visitIds)
        .order("created_at"),
    ]);
    if (staff.error) throw new Error(staff.error.message);
    if (charges.error) throw new Error(charges.error.message);
    const staffName = new Map(
      ((staff.data ?? []) as Array<{ id: string; display_name: string | null }>).map((s) => [
        s.id,
        s.display_name,
      ]),
    );
    const chargesByVisit = new Map<
      string,
      Array<{ description: string | null; quantity: number | null; status: string | null }>
    >();
    for (const c of charges.data ?? []) {
      if (!c.visit_id) continue;
      const list = chargesByVisit.get(c.visit_id) ?? [];
      list.push({ description: c.description, quantity: c.quantity, status: c.status });
      chargesByVisit.set(c.visit_id, list);
    }

    const { portalVisitPhotos } = await import("@/lib/portal-visit-photos.server");
    const photosByVisit = await portalVisitPhotos(sb, visitIds);

    const { groomReport } = await import("@/lib/groom-report");
    const reports = rows.map((r) =>
      groomReport({
        visitId: r.id,
        day: r.scheduled_on,
        serviceName: one(r.services as { name: string | null } | null)?.name ?? null,
        groomerName: r.assigned_staff_id ? (staffName.get(r.assigned_staff_id) ?? null) : null,
        summary: r.groom_summary,
        reportNote: r.report_note,
        charges: chargesByVisit.get(r.id) ?? [],
        photos: photosByVisit.get(r.id) ?? [],
      }),
    );
    return { reports, next };
  });
