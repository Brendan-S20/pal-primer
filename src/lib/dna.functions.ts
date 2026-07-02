import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

export type DnaMatch = {
  id: string;
  sample_kind: "cheek_swab" | "pile_sample";
  collected_at: string;
  location_note: string | null;
  lab_reference: string | null;
  status: "new" | "sent_to_lab" | "matched" | "unmatched" | "billed" | "closed";
  matched_dog_id: string | null;
  matched_dog_name: string | null;
  matched_client_name: string | null;
  matched_at: string | null;
  fine_cents: number;
  notes: string | null;
  property_id: string | null;
  property_street: string | null;
  client_id: string | null;
  client_name: string | null;
  created_at: string;
};

export const listDnaMatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("dna_matches")
      .select(
        "id, sample_kind, collected_at, location_note, lab_reference, status, matched_dog_id, matched_at, fine_cents, notes, property_id, client_id, " +
          "matched_dog:matched_dog_id(name, properties:property_id(clients:client_id(display_name))), " +
          "properties:property_id(street), clients:client_id(display_name)",
      )
      .eq("organization_id", orgId)
      .order("collected_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows: DnaMatch[] = (data ?? []).map((r: any) => ({
      id: r.id,
      sample_kind: r.sample_kind,
      collected_at: r.collected_at,
      location_note: r.location_note,
      lab_reference: r.lab_reference,
      status: r.status,
      matched_dog_id: r.matched_dog_id,
      matched_dog_name: r.matched_dog?.name ?? null,
      matched_client_name: r.matched_dog?.properties?.clients?.display_name ?? null,
      matched_at: r.matched_at,
      fine_cents: r.fine_cents,
      notes: r.notes,
      property_id: r.property_id,
      property_street: r.properties?.street ?? null,
      client_id: r.client_id,
      client_name: r.clients?.display_name ?? null,
      created_at: r.collected_at,
    }));
    const summary = rows.reduce(
      (acc, r) => {
        acc.total++;
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        acc.fine_cents += r.fine_cents ?? 0;
        return acc;
      },
      { total: 0, fine_cents: 0 } as Record<string, number>,
    );
    return { rows, summary };
  });

const createSchema = z.object({
  sampleKind: z.enum(["cheek_swab", "pile_sample"]),
  locationNote: z.string().max(400).optional().nullable(),
  labReference: z.string().max(120).optional().nullable(),
  propertyId: z.string().uuid().optional().nullable(),
  clientId: z.string().uuid().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export const createDnaMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: row, error } = await context.supabase
      .from("dna_matches")
      .insert({
        organization_id: orgId,
        sample_kind: data.sampleKind,
        location_note: data.locationNote ?? null,
        lab_reference: data.labReference ?? null,
        property_id: data.propertyId ?? null,
        client_id: data.clientId ?? null,
        notes: data.notes ?? null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

const updateSchema = z.object({
  id: z.string().uuid(),
  status: z
    .enum(["new", "sent_to_lab", "matched", "unmatched", "billed", "closed"])
    .optional(),
  matchedDogId: z.string().uuid().optional().nullable(),
  labReference: z.string().max(120).optional().nullable(),
  fineCents: z.number().int().min(0).max(1_000_000).optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export const updateDnaMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const patch: any = {};
    if (data.status) {
      patch.status = data.status;
      if (data.status === "matched") patch.matched_at = new Date().toISOString();
    }
    if (data.matchedDogId !== undefined) patch.matched_dog_id = data.matchedDogId;
    if (data.labReference !== undefined) patch.lab_reference = data.labReference;
    if (data.fineCents !== undefined) patch.fine_cents = data.fineCents;
    if (data.notes !== undefined) patch.notes = data.notes;
    const { error } = await context.supabase.from("dna_matches").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteDnaMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("dna_matches").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listRegisteredDogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("dogs")
      .select("id, name, breed, dna_registry_id, properties:property_id(street, clients:client_id(display_name))")
      .eq("organization_id", orgId)
      .eq("dna_registered", true)
      .order("name");
    if (error) throw new Error(error.message);
    return (data ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      breed: d.breed,
      registry_id: d.dna_registry_id,
      client_name: d.properties?.clients?.display_name ?? null,
      street: d.properties?.street ?? null,
    }));
  });
