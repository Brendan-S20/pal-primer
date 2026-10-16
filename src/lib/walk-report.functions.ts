import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { REPORT_NOTE_MAX, cleanReportNote } from "@/lib/walk-report";

/** Records a walk's pee, poo and note for the client (#410). The app calls it
 *  just before completeVisit, live or from the offline queue, so the
 *  completion email is written from it. record_walk_report decides who may:
 *  the assigned walker or the office. */
export const recordWalkReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        pee: z.boolean().nullable(),
        poo: z.boolean().nullable(),
        reportNote: z.string().max(REPORT_NOTE_MAX * 2).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("record_walk_report", {
      _visit_id: data.visitId,
      _pee: data.pee,
      _poo: data.poo,
      _report_note: cleanReportNote(data.reportNote),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
