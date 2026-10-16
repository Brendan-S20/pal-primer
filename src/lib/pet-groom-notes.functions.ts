// A groomer's notes for one pet at one groom: the blade, the style and what
// went wrong. One row per visit and pet, so the next groomer reads each pet's
// history rather than one note for the whole household.
//
// The caller's own client writes, so RLS and pet_groom_notes_before_write
// decide: the office, or the groomer the visit is assigned to.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const clean = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s ? s : null;
};

export const petGroomNoteSchema = z
  .object({
    visitId: z.string().uuid(),
    dogId: z.string().uuid(),
    blade: z.string().max(120).nullable(),
    style: z.string().max(240).nullable(),
    problems: z.string().max(1000).nullable(),
  })
  .refine((d) => clean(d.blade) || clean(d.style) || clean(d.problems), {
    message: "Write a blade, a style or a problem first.",
  });

export const savePetGroomNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => petGroomNoteSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("pet_groom_notes").upsert(
      {
        visit_id: data.visitId,
        dog_id: data.dogId,
        blade: clean(data.blade),
        style: clean(data.style),
        problems: clean(data.problems),
      },
      { onConflict: "visit_id,dog_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
