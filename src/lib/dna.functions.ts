import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";

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
    const { orgId, role } = await resolveCaller(context.supabase, context.userId);
    const canSeeDirectory = hasPermission(role, "view_client_directory");
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
      matched_client_name: canSeeDirectory
        ? (r.matched_dog?.properties?.clients?.display_name ?? null)
        : null,
      matched_at: r.matched_at,
      fine_cents: r.fine_cents,
      notes: r.notes,
      property_id: r.property_id,
      property_street: canSeeDirectory ? (r.properties?.street ?? null) : null,
      client_id: r.client_id,
      client_name: canSeeDirectory ? (r.clients?.display_name ?? null) : null,
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
    const { orgId } = await resolveCaller(context.supabase, context.userId);
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
    // Setting a fine amount or marking a sample billed is a billing action,
    // not a field-collection update — gate it separately from status moves
    // like sent_to_lab/matched that techs legitimately perform.
    if (data.fineCents !== undefined || data.status === "billed") {
      await requirePermission(context.supabase, context.userId, "manage_dna_billing");
    }
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
    // Deleting a matched/fined/billed sample erases a billing record — only
    // unprocessed field samples can be removed without the billing capability.
    const { data: existing, error: rErr } = await context.supabase
      .from("dna_matches")
      .select("status, fine_cents")
      .eq("id", data.id)
      .maybeSingle();
    if (rErr) throw new Error(rErr.message);
    if (!existing) throw new Error("Sample not found");
    if (existing.status !== "new" && existing.status !== "sent_to_lab") {
      await requirePermission(context.supabase, context.userId, "manage_dna_billing");
    }
    const { error } = await context.supabase.from("dna_matches").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listRegisteredDogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId, role } = await resolveCaller(context.supabase, context.userId);
    const canSeeDirectory = hasPermission(role, "view_client_directory");
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
      client_name: canSeeDirectory ? (d.properties?.clients?.display_name ?? null) : null,
      street: canSeeDirectory ? (d.properties?.street ?? null) : null,
    }));
  });

export const listAllDogsForDna = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId, role } = await resolveCaller(context.supabase, context.userId);
    const canSeeDirectory = hasPermission(role, "view_client_directory");
    const { data, error } = await context.supabase
      .from("dogs")
      .select("id, name, breed, dna_registered, dna_registry_id, property_id, properties:property_id(street, clients:client_id(display_name))")
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    return (data ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      breed: d.breed,
      dna_registered: !!d.dna_registered,
      registry_id: d.dna_registry_id,
      client_name: canSeeDirectory ? (d.properties?.clients?.display_name ?? null) : null,
      street: canSeeDirectory ? (d.properties?.street ?? null) : null,
    }));
  });

export const billDnaViolation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ matchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_dna_billing");
    const { data: m, error: mErr } = await supabase
      .from("dna_matches")
      .select("id, status, matched_dog_id, client_id, property_id, fine_cents, lab_reference, location_note, matched_at, collected_at")
      .eq("id", data.matchId)
      .single();
    if (mErr) throw new Error(mErr.message);
    if (m.status !== "matched") throw new Error("Sample must be matched before billing");
    if (!m.fine_cents || m.fine_cents <= 0) throw new Error("Set a fine amount first");

    // Resolve client_id — prefer explicit, else via matched dog → property → client
    let clientId = m.client_id as string | null;
    if (!clientId && m.matched_dog_id) {
      const { data: dog } = await supabase
        .from("dogs")
        .select("properties:property_id(client_id)")
        .eq("id", m.matched_dog_id)
        .single();
      clientId = (dog as any)?.properties?.client_id ?? null;
    }
    if (!clientId) throw new Error("No client associated with match");

    const nowIso = new Date().toISOString();
    const today = nowIso.slice(0, 10);
    const { data: inv, error: iErr } = await supabase
      .from("invoices")
      .insert({
        organization_id: orgId,
        client_id: clientId,
        kind: "postpaid",
        status: "open",
        subtotal_cents: m.fine_cents,
        total_cents: m.fine_cents,
        period_start: today,
        period_end: today,
        issued_at: nowIso,
        notes: `DNA violation fine: sample ${m.lab_reference ?? m.id.slice(0, 8)}${m.location_note ? ` (${m.location_note})` : ""}`,
      })
      .select("id")
      .single();
    if (iErr) throw new Error(iErr.message);

    const { error: lErr } = await supabase.from("invoice_line_items").insert({
      invoice_id: inv.id,
      amount_cents: m.fine_cents,
      description: `DNA pile-sample violation fine · collected ${new Date(m.collected_at).toLocaleDateString()}${m.location_note ? ` · ${m.location_note}` : ""}`,
    });
    if (lErr) throw new Error(lErr.message);

    const { error: uErr } = await supabase
      .from("dna_matches")
      .update({ status: "billed" })
      .eq("id", m.id);
    if (uErr) throw new Error(uErr.message);

    return { ok: true, invoiceId: inv.id as string };
  });

export type ViolationNotice = {
  matchId: string;
  orgName: string;
  clientName: string;
  clientEmail: string | null;
  dogName: string | null;
  breed: string | null;
  registryId: string | null;
  street: string | null;
  collectedAt: string;
  matchedAt: string | null;
  labReference: string | null;
  locationNote: string | null;
  fineCents: number;
  notes: string | null;
};

export const getViolationNotice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ matchId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<ViolationNotice> => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_dna_billing");
    const [{ data: org }, { data: m, error: mErr }] = await Promise.all([
      supabase.from("organizations").select("name").eq("id", orgId).single(),
      supabase
        .from("dna_matches")
        .select(
          "id, collected_at, matched_at, lab_reference, location_note, fine_cents, notes, matched_dog_id, client_id, property_id, " +
            "matched_dog:matched_dog_id(name, breed, dna_registry_id, properties:property_id(street, clients:client_id(display_name, primary_email))), " +
            "properties:property_id(street), clients:client_id(display_name, primary_email)",
        )
        .eq("id", data.matchId)
        .single(),
    ]);
    if (mErr) throw new Error(mErr.message);
    const row: any = m;
    const dog = row.matched_dog;
    const dogClient = dog?.properties?.clients;
    return {
      matchId: row.id,
      orgName: (org as any)?.name ?? "Your service",
      clientName: dogClient?.display_name ?? row.clients?.display_name ?? "Resident",
      clientEmail: dogClient?.primary_email ?? row.clients?.primary_email ?? null,
      dogName: dog?.name ?? null,
      breed: dog?.breed ?? null,
      registryId: dog?.dna_registry_id ?? null,
      street: dog?.properties?.street ?? row.properties?.street ?? null,
      collectedAt: row.collected_at,
      matchedAt: row.matched_at,
      labReference: row.lab_reference,
      locationNote: row.location_note,
      fineCents: row.fine_cents ?? 0,
      notes: row.notes,
    };
  });

