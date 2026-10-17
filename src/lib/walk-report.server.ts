/** The walk report a completion email carries, read for one visit (#410).
 *
 *  Null for anything that is not a dog walk, which is how the completion email
 *  and push stay exactly as they were for every other visit. Never throws: the
 *  completion has already happened, and a report that cannot be read leaves
 *  the email as the plain "Visit complete" rather than losing it. */

import { DEFAULT_TIMEZONE } from "@/lib/route-window";
import {
  WALK_PUSH_BODY,
  WALK_PUSH_TITLE,
  walkReportEmail,
  type WalkReportEmail,
} from "@/lib/walk-report";

export type WalkCompletion = {
  email: WalkReportEmail;
  push: { title: string; body: string };
};

type Row = {
  started_at: string | null;
  completed_at: string | null;
  pee: boolean | null;
  poo: boolean | null;
  report_note: string | null;
  assigned_staff_id: string | null;
  services: { service_line: string | null } | { service_line: string | null }[] | null;
  organizations: { timezone: string | null } | { timezone: string | null }[] | null;
  properties:
    | { dogs: { name: string | null; active: boolean | null }[] | null }
    | { dogs: { name: string | null; active: boolean | null }[] | null }[]
    | null;
};

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export async function walkCompletionFor(visitId: string): Promise<WalkCompletion | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("visits")
      .select(
        "started_at, completed_at, pee, poo, report_note, assigned_staff_id, services(service_line), organizations(timezone), properties(dogs(name, active))",
      )
      .eq("id", visitId)
      .maybeSingle();
    if (error || !data) return null;
    const v = data as Row;
    if (one(v.services)?.service_line !== "dog_walking") return null;

    let walkerName: string | null = null;
    if (v.assigned_staff_id) {
      const { data: staff } = await (supabaseAdmin as any)
        .from("staff")
        .select("display_name")
        .eq("id", v.assigned_staff_id)
        .maybeSingle();
      walkerName = (staff?.display_name as string | null) ?? null;
    }
    const dogs = (one(v.properties)?.dogs ?? []).filter((d) => d.active !== false);
    return {
      email: walkReportEmail({
        startedAt: v.started_at,
        completedAt: v.completed_at,
        timezone: one(v.organizations)?.timezone || DEFAULT_TIMEZONE,
        pee: v.pee,
        poo: v.poo,
        reportNote: v.report_note,
        dogNames: dogs.map((d) => d.name),
        walkerName,
      }),
      push: { title: WALK_PUSH_TITLE, body: WALK_PUSH_BODY },
    };
  } catch (e) {
    console.warn("walk report could not be read; sending the plain completion email", visitId, e);
    return null;
  }
}
