import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CARE_KINDS, CARE_NOTE_MAX, MISSED_REASON_MAX } from "@/lib/sit-day";
import { MED_NAME_MAX } from "@/lib/pets";

/** Logs one thing a sitter did for a pet (#411): live from My Day, or from the
 *  offline queue in the order it was tapped. record_care_entry decides who may
 *  (the assigned sitter or the office) and on which visits. A medication
 *  logged as missed tells the office (sit-notify.server.ts). */
export const recordCareEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        /** Minted on the device before the first attempt, so a replay of a
         *  request that landed is the same row. */
        id: z.string().uuid(),
        visitId: z.string().uuid(),
        petId: z.string().uuid().nullable(),
        kind: z.enum(CARE_KINDS),
        medName: z.string().trim().max(MED_NAME_MAX).nullable(),
        status: z.enum(["done", "missed"]),
        missedReason: z.string().trim().max(MISSED_REASON_MAX).nullable(),
        note: z.string().trim().max(CARE_NOTE_MAX).nullable(),
        /** When it was done, for a REPLAYED entry. The SQL bounds it. */
        at: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("record_care_entry", {
      _visit_id: data.visitId,
      // The SQL function takes NULL for these: all pets, or nothing to say.
      _pet_id: data.petId as string,
      _kind: data.kind,
      _med_name: (data.medName || null) as string,
      _status: data.status,
      _missed_reason: (data.missedReason || null) as string,
      _note: (data.note || null) as string,
      _at: data.at ?? undefined,
      _id: data.id,
    });
    if (error) throw new Error(error.message);
    if (data.kind === "meds" && data.status === "missed") {
      const { notifyMissedMed } = await import("@/lib/sit-notify.server");
      await notifyMissedMed({ entryId: (id as string) ?? data.id, actorUserId: context.userId });
    }
    return { id: (id as string) ?? data.id };
  });

/** Undoes a mis-tap: the same people, within 12 hours (delete_care_entry). An
 *  entry already gone is not an error, so a replayed undo is harmless. */
export const deleteCareEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("delete_care_entry", { _id: data.id });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
