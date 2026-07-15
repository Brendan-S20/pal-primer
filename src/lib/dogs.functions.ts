import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const temperament = z.enum(["friendly", "nervous", "aggressive", "unknown"]);

const addDogSchema = z.object({
  propertyId: z.string().uuid(),
  name: z.string().min(1).max(80),
  breed: z.string().max(80).optional().nullable(),
  weightClass: z.string().max(40).optional().nullable(),
  temperament: temperament.optional(),
  notes: z.string().max(1000).optional().nullable(),
});

export const addDog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addDogSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: prop, error: pErr } = await supabase
      .from("properties")
      .select("organization_id")
      .eq("id", data.propertyId)
      .single();
    if (pErr) throw new Error(pErr.message);
    const { data: row, error } = await supabase
      .from("dogs")
      .insert({
        property_id: data.propertyId,
        organization_id: prop.organization_id,
        name: data.name,
        breed: data.breed || null,
        weight_class: data.weightClass || null,
        temperament: data.temperament ?? "unknown",
        notes: data.notes || null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    // Dog count feeds the auto-calculated service time.
    const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
    await recomputePropertyEstimate(supabase, data.propertyId);
    try {
      const { data: propRow } = await supabase
        .from("properties")
        .select("client_id, street")
        .eq("id", data.propertyId)
        .single();
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId: prop.organization_id,
        clientId: propRow?.client_id ?? null,
        propertyId: data.propertyId,
        actorUserId: context.userId,
        kind: "dog.added",
        summary: `Added dog ${data.name}${propRow?.street ? ` at ${propRow.street}` : ""}`,
      });
    } catch {}
    return { id: row.id as string };
  });

const editDogSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80).optional(),
  breed: z.string().max(80).optional().nullable(),
  weightClass: z.string().max(40).optional().nullable(),
  temperament: temperament.optional(),
  notes: z.string().max(1000).optional().nullable(),
  active: z.boolean().optional(),
});

export const updateDog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => editDogSchema.parse(d))
  .handler(async ({ data, context }) => {
    const patch: Record<string, string | boolean | null> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.breed !== undefined) patch.breed = data.breed || null;
    if (data.weightClass !== undefined) patch.weight_class = data.weightClass || null;
    if (data.temperament !== undefined) patch.temperament = data.temperament;
    if (data.notes !== undefined) patch.notes = data.notes || null;
    if (data.active !== undefined) patch.active = data.active;
    if (Object.keys(patch).length === 0) return { ok: true };

    const { data: rows, error } = await context.supabase
      .from("dogs")
      .update(patch as never)
      .eq("id", data.id)
      .select("property_id");
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) throw new Error("Dog not found");

    if (data.active !== undefined && row.property_id) {
      const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
      await recomputePropertyEstimate(context.supabase, row.property_id);
    }
    try {
      const { data: propRow } = await context.supabase
        .from("properties")
        .select("organization_id, client_id, street")
        .eq("id", row.property_id)
        .single();
      if (propRow) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: propRow.organization_id,
          clientId: propRow.client_id,
          propertyId: row.property_id,
          actorUserId: context.userId,
          kind:
            data.active === false
              ? "dog.deactivated"
              : data.active === true
                ? "dog.reactivated"
                : "dog.updated",
          summary:
            data.active === false
              ? "Marked a dog inactive"
              : data.active === true
                ? "Reactivated a dog"
                : "Updated a dog's details",
        });
      }
    } catch {}
    return { ok: true };
  });

// Kept for legacy call sites; the refactored UI deactivates dogs instead.
export const deleteDog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("dogs")
      .delete()
      .eq("id", data.id)
      .select("property_id");
    if (error) throw new Error(error.message);
    const propertyId = rows?.[0]?.property_id;
    if (propertyId) {
      const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
      await recomputePropertyEstimate(context.supabase, propertyId);
    }
    return { ok: true };
  });

const dnaSchema = z.object({
  id: z.string().uuid(),
  registered: z.boolean(),
  registryId: z.string().max(120).optional().nullable(),
});

export const setDogDna = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => dnaSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("dogs")
      .update({
        dna_registered: data.registered,
        dna_registry_id: data.registered ? (data.registryId || null) : null,
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
