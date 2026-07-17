import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertValidDogName, dogNeedsUnitReview } from "@/lib/dna-linkage";

/** True when a property has at least one unit (dog must key to one, else review). */
async function propertyHasUnits(supabase: any, propertyId: string): Promise<boolean> {
  const { count } = await supabase
    .from("property_units")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId);
  return (count ?? 0) > 0;
}

const temperament = z.enum(["friendly", "nervous", "aggressive", "unknown"]);
// PooPrints-style registration state for commercial units.
const dnaStatus = z.enum(["not_registered", "pending", "registered"]);

const addDogSchema = z.object({
  propertyId: z.string().uuid(),
  name: z.string().min(1).max(80),
  breed: z.string().max(80).optional().nullable(),
  weightClass: z.string().max(40).optional().nullable(),
  temperament: temperament.optional(),
  notes: z.string().max(1000).optional().nullable(),
  /** Commercial: scope the dog to a unit on the property. */
  unitId: z.string().uuid().optional().nullable(),
  dnaStatus: dnaStatus.optional(),
});

export const addDog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addDogSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Server-enforced name validation (I11, B8): reject "1"/"Ew"-class junk.
    const dogName = assertValidDogName(data.name);
    const { data: prop, error: pErr } = await supabase
      .from("properties")
      .select("organization_id")
      .eq("id", data.propertyId)
      .single();
    if (pErr) throw new Error(pErr.message);
    // A supplied unit must belong to this property (Units tab scoping).
    if (data.unitId) {
      const { data: unit, error: uErr } = await (supabase as any)
        .from("property_units")
        .select("id, property_id")
        .eq("id", data.unitId)
        .maybeSingle();
      if (uErr) throw new Error(uErr.message);
      if (!unit || unit.property_id !== data.propertyId)
        throw new Error("Unit not found on this property");
    }
    // A dog on a unit-bearing property but with no unit goes to management
    // review, never a silent guess (I5, I9).
    const reviewNeeded = data.unitId
      ? false
      : dogNeedsUnitReview({
          unitId: null,
          propertyHasUnits: await propertyHasUnits(supabase, data.propertyId),
        });
    const { data: row, error } = await supabase
      .from("dogs")
      .insert({
        property_id: data.propertyId,
        organization_id: prop.organization_id,
        name: dogName,
        breed: data.breed || null,
        weight_class: data.weightClass || null,
        temperament: data.temperament ?? "unknown",
        notes: data.notes || null,
        unit_id: data.unitId ?? null,
        dna_status: data.dnaStatus ?? "not_registered",
        unit_review_needed: reviewNeeded,
      } as any)
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
  unitId: z.string().uuid().optional().nullable(),
  dnaStatus: dnaStatus.optional(),
});

export const updateDog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => editDogSchema.parse(d))
  .handler(async ({ data, context }) => {
    // Fetch the current row once when we need the name or the property (for the
    // name-change check and/or the unit-belongs-to-property check).
    let dogPropertyId: string | null = null;
    let currentName: string | null = null;
    if (data.name !== undefined || data.unitId !== undefined) {
      const { data: dog, error: dogErr } = await context.supabase
        .from("dogs")
        .select("name, property_id")
        .eq("id", data.id)
        .maybeSingle();
      if (dogErr) throw new Error(dogErr.message);
      if (!dog) throw new Error("Dog not found");
      dogPropertyId = dog.property_id;
      currentName = (dog as { name: string | null }).name;
    }
    // Only validate the name when it actually CHANGES — matches the DB trigger,
    // so a legacy dog with a placeholder name (I6) can still be edited for other
    // fields, and the two validation layers agree. A rename to junk is rejected.
    if (data.name !== undefined && data.name.trim() !== (currentName ?? "").trim()) {
      assertValidDogName(data.name);
    }
    // A supplied unit must belong to the dog's property (mirrors the addDog
    // check; wave-2 QA finding 4 — otherwise unit_id could be re-pointed at
    // a unit on a different property).
    if (data.unitId !== undefined) {
      if (data.unitId) {
        const { data: unit, error: uErr } = await (context.supabase as any)
          .from("property_units")
          .select("id, property_id")
          .eq("id", data.unitId)
          .maybeSingle();
        if (uErr) throw new Error(uErr.message);
        if (!unit || unit.property_id !== dogPropertyId)
          throw new Error("Unit not found on this dog's property");
      }
    }

    const patch: Record<string, string | boolean | null> = {};
    if (data.name !== undefined) patch.name = data.name.trim();
    // Reassigning a unit clears/sets the management-review flag (I5): assigning
    // resolves review; unassigning on a unit-bearing property re-flags it.
    if (data.unitId !== undefined && dogPropertyId) {
      patch.unit_review_needed = data.unitId
        ? false
        : dogNeedsUnitReview({
            unitId: null,
            propertyHasUnits: await propertyHasUnits(context.supabase, dogPropertyId),
          });
    }
    if (data.breed !== undefined) patch.breed = data.breed || null;
    if (data.weightClass !== undefined) patch.weight_class = data.weightClass || null;
    if (data.temperament !== undefined) patch.temperament = data.temperament;
    if (data.notes !== undefined) patch.notes = data.notes || null;
    if (data.active !== undefined) patch.active = data.active;
    if (data.unitId !== undefined) patch.unit_id = data.unitId;
    if (data.dnaStatus !== undefined) patch.dna_status = data.dnaStatus;
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
  // Registration chain (Dog → Registration → Kit → Provider). Provider
  // references only — never raw genetic markers (I9).
  provider: z.string().max(120).optional().nullable(),
  kitReference: z.string().max(120).optional().nullable(),
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
        // Keep the DNA status enum used by the Units tab in sync so both
        // surfaces read the same record (I3).
        dna_status: data.registered ? "registered" : "not_registered",
        dna_provider: data.registered ? (data.provider || null) : null,
        dna_kit_reference: data.registered ? (data.kitReference || null) : null,
      } as any)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
