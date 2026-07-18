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
  unit_id: string | null;
  unit_label: string | null;
  collected_by_staff_id: string | null;
  collected_by_name: string | null;
  kit_reference: string | null;
  dna_provider: string | null;
  report_reference: string | null;
  sample_photo_path: string | null;
  created_at: string;
};

export const listDnaMatches = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // H1/I7: the cross-client compliance registry (samples, matches, fines
    // billed, other clients' dogs) is NOT a technician surface. Techs are
    // scoped to sample LOGGING (createDnaMatch / status moves) only — reading
    // the registry requires the client-directory capability, which techs lack.
    // Enforced here in the server fn, not just by hiding the /dna route.
    const { orgId, role } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const canSeeDirectory = hasPermission(role, "view_client_directory");
    const { data, error } = await context.supabase
      .from("dna_matches")
      .select(
        "id, sample_kind, collected_at, location_note, lab_reference, status, matched_dog_id, matched_at, fine_cents, notes, property_id, client_id, unit_id, collected_by_staff_id, kit_reference, dna_provider, report_reference, sample_photo_path, " +
          "matched_dog:matched_dog_id(name, properties:property_id(clients:client_id(display_name))), " +
          "properties:property_id(street), clients:client_id(display_name), " +
          "property_units:unit_id(unit_label), staff:collected_by_staff_id(display_name)",
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
      unit_id: r.unit_id,
      unit_label: r.property_units?.unit_label ?? null,
      collected_by_staff_id: r.collected_by_staff_id,
      collected_by_name: r.staff?.display_name ?? null,
      kit_reference: r.kit_reference,
      dna_provider: r.dna_provider,
      report_reference: r.report_reference,
      sample_photo_path: r.sample_photo_path ?? null,
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
  // Chain of custody (B8): where the property has units, key the sample to
  // one; who collected it; the kit tracking + provider references. No raw
  // genetic markers — references/statuses/reports only (I9).
  unitId: z.string().uuid().optional().nullable(),
  collectedByStaffId: z.string().uuid().optional().nullable(),
  kitReference: z.string().max(120).optional().nullable(),
  dnaProvider: z.string().max(120).optional().nullable(),
  reportReference: z.string().max(200).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  // Collection-evidence photo in the private dna-samples bucket (deferred B8
  // item). A storage path, not genetic data — I9 still holds.
  samplePhotoPath: z.string().max(300).optional().nullable(),
});

export const createDnaMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    // A supplied unit must belong to the supplied property (chain integrity;
    // the DB trigger also enforces this cross-tenant).
    if (data.unitId) {
      if (!data.propertyId) throw new Error("Pick a property before choosing a unit");
      const { data: unit, error: uErr } = await (context.supabase as any)
        .from("property_units")
        .select("id, property_id")
        .eq("id", data.unitId)
        .maybeSingle();
      if (uErr) throw new Error(uErr.message);
      if (!unit || unit.property_id !== data.propertyId)
        throw new Error("Unit not found on this property");
    }
    // A photo path must live inside the caller's org folder — otherwise a
    // crafted path could point signed-URL generation at another tenant's file.
    if (data.samplePhotoPath && !data.samplePhotoPath.startsWith(`${orgId}/`)) {
      throw new Error("Invalid sample photo path");
    }
    const { data: row, error } = await context.supabase
      .from("dna_matches")
      .insert({
        organization_id: orgId,
        sample_kind: data.sampleKind,
        location_note: data.locationNote ?? null,
        lab_reference: data.labReference ?? null,
        property_id: data.propertyId ?? null,
        client_id: data.clientId ?? null,
        unit_id: data.unitId ?? null,
        collected_by_staff_id: data.collectedByStaffId ?? null,
        kit_reference: data.kitReference ?? null,
        dna_provider: data.dnaProvider ?? null,
        report_reference: data.reportReference ?? null,
        notes: data.notes ?? null,
        sample_photo_path: data.samplePhotoPath ?? null,
        created_by: context.userId,
      } as any)
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
    // H1/I7: cross-client registered-dog list is registry data, not a tech
    // surface — gate the read on the directory capability (techs are rejected).
    const { orgId, role } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const canSeeDirectory = hasPermission(role, "view_client_directory");
    const { data, error } = await context.supabase
      .from("dogs")
      .select(
        "id, name, breed, dna_registry_id, unit_id, property_id, " +
          "property_units:unit_id(unit_label), " +
          "properties:property_id(street, clients:client_id(display_name))",
      )
      .eq("organization_id", orgId)
      .eq("dna_registered", true)
      .order("name");
    if (error) throw new Error(error.message);
    return (data ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      breed: d.breed,
      registry_id: d.dna_registry_id,
      unit_id: d.unit_id,
      unit_label: d.property_units?.unit_label ?? null,
      client_name: canSeeDirectory ? (d.properties?.clients?.display_name ?? null) : null,
      street: canSeeDirectory ? (d.properties?.street ?? null) : null,
    }));
  });

export const listAllDogsForDna = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // H1/I7: the full cross-client dog roster (registry tab) is not a tech
    // surface — gate on the directory capability (techs are rejected).
    const { orgId, role } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const canSeeDirectory = hasPermission(role, "view_client_directory");
    const { data, error } = await context.supabase
      .from("dogs")
      .select(
        "id, name, breed, dna_registered, dna_registry_id, dna_status, dna_provider, dna_kit_reference, " +
          "unit_id, property_id, unit_review_needed, " +
          "property_units:unit_id(unit_label), " +
          "properties:property_id(street, account_type, clients:client_id(display_name))",
      )
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    return (data ?? []).map((d: any) => ({
      id: d.id,
      name: d.name,
      breed: d.breed,
      dna_registered: !!d.dna_registered,
      registry_id: d.dna_registry_id,
      dna_status: d.dna_status ?? "not_registered",
      dna_provider: d.dna_provider ?? null,
      kit_reference: d.dna_kit_reference ?? null,
      unit_id: d.unit_id,
      unit_label: d.property_units?.unit_label ?? null,
      // Orphan dog on a unit-bearing property (I5): shown as review-needed so
      // /dna and the Units tab reconcile against the same record (I3).
      review_needed: !!d.unit_review_needed,
      client_name: canSeeDirectory ? (d.properties?.clients?.display_name ?? null) : null,
      street: canSeeDirectory ? (d.properties?.street ?? null) : null,
    }));
  });

// Options for the DNA sample form (B8): properties (with their client + units)
// and the field techs who can collect a sample. Cross-property, org-scoped.
export const listDnaFormOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // H1/I7: the sample-logging form lists every property + its client across
    // the org — that cross-client directory is office-only. Techs are rejected.
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const [props, units, staff] = await Promise.all([
      context.supabase
        .from("properties")
        .select("id, street, city, account_type, has_units, client_id, clients:client_id(display_name)")
        .eq("organization_id", orgId)
        .is("archived_at", null)
        .order("street"),
      (context.supabase as any)
        .from("property_units")
        .select("id, property_id, unit_label")
        .eq("organization_id", orgId)
        .order("unit_label"),
      context.supabase
        .from("staff")
        .select("id, display_name, is_field_tech")
        .eq("organization_id", orgId)
        .eq("active", true)
        .order("display_name"),
    ]);
    if (props.error) throw new Error(props.error.message);
    if (units.error) throw new Error(units.error.message);
    if (staff.error) throw new Error(staff.error.message);
    return {
      properties: (props.data ?? []).map((p: any) => ({
        id: p.id,
        street: p.street,
        city: p.city,
        account_type: p.account_type,
        has_units: !!p.has_units,
        client_id: p.client_id,
        client_name: (p.clients as any)?.display_name ?? null,
      })),
      units: units.data ?? [],
      // Field techs first, but keep everyone selectable as a fallback collector.
      staff: (staff.data ?? []).sort(
        (a: any, b: any) => Number(b.is_field_tech) - Number(a.is_field_tech),
      ),
    };
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

