/** The office hears when a sitter logs a medication as missed (#411).
 *
 *  Called by recordCareEntry after record_care_entry returns, live or from
 *  the offline queue, through notifyRoles like every other field event
 *  (field-notify.server.ts): a row written from SQL would never reach a phone.
 *  The event key is the entry, so a replayed entry tells nobody twice. Never
 *  throws: the entry is already logged. */

import { missedMedNotice } from "@/lib/sit-report";
import { myDayLink, routeThreadId, visitThreadId } from "@/lib/field-notify";

/** Who hears it: the people who run the day, as for a skipped stop. */
const OFFICE = ["owner", "office_manager", "dispatcher"] as const;

/** The notification type, mutable in Notifications settings. */
export const MISSED_MED_TYPE = "missed_meds";

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

type EntryRow = {
  id: string;
  organization_id: string;
  kind: string;
  status: string;
  med_name: string | null;
  missed_reason: string | null;
  dogs: { name: string | null } | { name: string | null }[] | null;
  staff: { display_name: string | null } | { display_name: string | null }[] | null;
  visits:
    | {
        id: string;
        scheduled_on: string;
        assigned_staff_id: string | null;
        clients: { display_name: string | null } | { display_name: string | null }[] | null;
      }
    | null;
};

export async function notifyMissedMed(input: {
  entryId: string;
  actorUserId: string | null;
}): Promise<{ told: number }> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("care_log")
      .select(
        "id, organization_id, kind, status, med_name, missed_reason, dogs(name), staff(display_name), visits(id, scheduled_on, assigned_staff_id, clients(display_name))",
      )
      .eq("id", input.entryId)
      .maybeSingle();
    if (error || !data) return { told: 0 };
    const e = data as EntryRow;
    if (e.kind !== "meds" || e.status !== "missed" || !e.visits) return { told: 0 };
    const v = e.visits;
    const notice = missedMedNotice({
      sitter: one(e.staff)?.display_name ?? null,
      pet: one(e.dogs)?.name ?? null,
      med: (e.med_name ?? "").trim() || "a medication",
      reason: e.missed_reason ?? "",
      client: one(v.clients)?.display_name ?? null,
    });
    const { notifyRoles } = await import("@/lib/notify-center.server");
    const r = await notifyRoles([...OFFICE], {
      orgId: e.organization_id,
      type: MISSED_MED_TYPE,
      title: notice.title,
      body: notice.body,
      link: myDayLink({ day: v.scheduled_on, staffId: v.assigned_staff_id, visitId: v.id }),
      threadId: v.assigned_staff_id
        ? routeThreadId(v.assigned_staff_id, v.scheduled_on)
        : visitThreadId(v.id),
      collapseId: `missed_med:${e.id}`,
      eventKey: `missed_med:${e.id}`,
      exceptUserId: input.actorUserId,
    });
    return { told: r.inserted.length };
  } catch (err) {
    console.warn("[sit-notify] missed medication not told", input.entryId, err);
    return { told: 0 };
  }
}
