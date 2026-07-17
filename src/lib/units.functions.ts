// Commercial units (HOA model): per-unit residents, dogs, DNA registration
// and offending incidents. Units belong to commercial properties; the Units
// tab on the client detail page is the only surface that manages them.
//
// Write ops are can_write_org-level (owner / office_manager / dispatcher) —
// mirrored here server-side because RLS alone would surface as an opaque
// policy error instead of a clear message.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller, type CallerContext } from "@/lib/authz.server";
import { assertValidUnitLabel } from "@/lib/dna-linkage";

/** Server-side twin of the can_write_org() SQL helper (everyone but techs). */
async function requireCanWriteOrg(supabase: any, userId: string): Promise<CallerContext> {
  const caller = await resolveCaller(supabase, userId);
  if (!["owner", "office_manager", "dispatcher"].includes(caller.role)) {
    throw new Error("Not authorized");
  }
  return caller;
}

const INCIDENT_KINDS = ["waste_violation", "dna_match", "complaint", "other"] as const;
export type UnitIncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_KIND_LABELS: Record<UnitIncidentKind, string> = {
  waste_violation: "Waste violation",
  dna_match: "DNA match",
  complaint: "Complaint",
  other: "Other",
};

// ── Reads ────────────────────────────────────────────────────────────────────

export const listUnitsForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "view_client_directory");
    const { data: props, error: pErr } = await supabase
      .from("properties")
      .select("id")
      .eq("client_id", data.clientId);
    if (pErr) throw new Error(pErr.message);
    const ids = (props ?? []).map((p: any) => p.id);
    if (!ids.length) return { units: [], incidents: [], reviewDogs: [] };

    const [units, incidents, reviewDogs] = await Promise.all([
      (supabase as any)
        .from("property_units")
        .select(
          "id, property_id, unit_label, resident_name, resident_phone, resident_email, notes, offending_count, created_at",
        )
        .in("property_id", ids)
        .order("unit_label"),
      (supabase as any)
        .from("unit_incidents")
        .select("id, property_id, unit_id, dog_id, incident_on, kind, notes, charged_cents, created_at")
        .in("property_id", ids)
        .order("incident_on", { ascending: false })
        .order("created_at", { ascending: false }),
      // Orphan dogs (I5): on a unit-bearing property but assigned to no unit.
      // Surfaced here so /dna and the Units tab reconcile against the SAME
      // dog records (I3) instead of the Units tab silently showing zero.
      (supabase as any)
        .from("dogs")
        .select("id, name, breed, property_id, unit_id, dna_status, active, unit_review_needed")
        .in("property_id", ids)
        .eq("unit_review_needed", true)
        .order("name"),
    ]);
    if (units.error) throw new Error(units.error.message);
    if (incidents.error) throw new Error(incidents.error.message);
    if (reviewDogs.error) throw new Error(reviewDogs.error.message);
    return {
      units: units.data ?? [],
      incidents: incidents.data ?? [],
      reviewDogs: (reviewDogs.data ?? []).filter((d: any) => d.active !== false),
    };
  });

// ── Unit create / edit ───────────────────────────────────────────────────────

const unitFields = {
  unitLabel: z.string().min(1).max(80),
  residentName: z.string().max(160).optional().nullable(),
  residentPhone: z.string().max(40).optional().nullable(),
  residentEmail: z.string().max(200).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
};

export const createUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ propertyId: z.string().uuid(), ...unitFields }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requireCanWriteOrg(supabase, userId);
    const unitLabel = assertValidUnitLabel(data.unitLabel);
    const { data: prop, error: pErr } = await supabase
      .from("properties")
      .select("id, organization_id, client_id, street")
      .eq("id", data.propertyId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!prop) throw new Error("Property not found");

    const { data: row, error } = await (supabase as any)
      .from("property_units")
      .insert({
        organization_id: orgId,
        property_id: data.propertyId,
        unit_label: unitLabel,
        resident_name: data.residentName || null,
        resident_phone: data.residentPhone || null,
        resident_email: data.residentEmail || null,
        notes: data.notes || null,
      })
      .select("id")
      .single();
    if (error) {
      if (String(error.message).includes("duplicate"))
        throw new Error(`Unit "${data.unitLabel.trim()}" already exists on this property`);
      throw new Error(error.message);
    }

    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId: prop.client_id,
        propertyId: data.propertyId,
        actorUserId: userId,
        kind: "unit.added",
        summary: `Added unit ${data.unitLabel.trim()}${prop.street ? ` at ${prop.street}` : ""}`,
      });
    } catch {}
    return { id: row.id as string };
  });

export const updateUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ id: z.string().uuid(), ...unitFields })
      .partial({ unitLabel: true })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requireCanWriteOrg(supabase, userId);
    const patch: Record<string, string | null> = {};
    if (data.unitLabel !== undefined) patch.unit_label = assertValidUnitLabel(data.unitLabel);
    if (data.residentName !== undefined) patch.resident_name = data.residentName || null;
    if (data.residentPhone !== undefined) patch.resident_phone = data.residentPhone || null;
    if (data.residentEmail !== undefined) patch.resident_email = data.residentEmail || null;
    if (data.notes !== undefined) patch.notes = data.notes || null;
    if (Object.keys(patch).length === 0) return { ok: true };

    const { data: rows, error } = await (supabase as any)
      .from("property_units")
      .update(patch)
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .select("id");
    if (error) {
      if (String(error.message).includes("duplicate"))
        throw new Error("Another unit on this property already uses that label");
      throw new Error(error.message);
    }
    if (!rows?.length) throw new Error("Unit not found");
    return { ok: true };
  });

// ── Incidents ────────────────────────────────────────────────────────────────

/** Get-or-create the org's catalog entry that unit incident charges bill
 * against. create_addon_charge requires an addon service; the price is
 * always overridden per charge. */
async function unitIncidentAddonServiceId(supabase: any, orgId: string): Promise<string> {
  const { data: existing, error: sErr } = await supabase
    .from("addon_services")
    .select("id")
    .eq("organization_id", orgId)
    .eq("code", "unit_incident")
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (existing) return existing.id as string;
  const { data: row, error } = await supabase
    .from("addon_services")
    .insert({
      organization_id: orgId,
      code: "unit_incident",
      name: "Unit incident charge",
      description: "One-off charge for a unit incident (waste violation, DNA match…)",
      kind: "one_time",
      unit_price_cents: 0,
      taxable: false,
      active: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return row.id as string;
}

export const logUnitIncident = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        unitId: z.string().uuid(),
        kind: z.enum(INCIDENT_KINDS),
        incidentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dogId: z.string().uuid().optional().nullable(),
        notes: z.string().max(1000).optional().nullable(),
        chargedCents: z.number().int().min(1).max(10_000_000).optional().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requireCanWriteOrg(supabase, userId);
    // Billing an incident creates a real charge — that needs the billing
    // capability, checked up front so the caller gets one clear error.
    if (data.chargedCents) {
      await requirePermission(supabase, userId, "manage_client_billing");
    }

    const { data: unit, error: uErr } = await (supabase as any)
      .from("property_units")
      .select("id, unit_label, offending_count, property_id, properties(id, client_id, street)")
      .eq("id", data.unitId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (uErr) throw new Error(uErr.message);
    if (!unit) throw new Error("Unit not found");
    const clientId = unit.properties?.client_id as string | undefined;

    // A named dog must live in this unit (prevents cross-unit attribution).
    if (data.dogId) {
      const { data: dog, error: dErr } = await (supabase as any)
        .from("dogs")
        .select("id, unit_id")
        .eq("id", data.dogId)
        .maybeSingle();
      if (dErr) throw new Error(dErr.message);
      if (!dog || dog.unit_id !== data.unitId) throw new Error("Dog not found in this unit");
    }

    // Bill it first: if the charge fails, no incident row is left claiming
    // money that never landed on an invoice.
    let chargeId: string | null = null;
    if (data.chargedCents && clientId) {
      const addonServiceId = await unitIncidentAddonServiceId(supabase, orgId);
      const label = INCIDENT_KIND_LABELS[data.kind].toLowerCase();
      const { data: cId, error: cErr } = await supabase.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 1,
        _unit_price_cents: data.chargedCents,
        _description: `Unit ${unit.unit_label}: ${label}`,
        _source: "office",
        _note: data.notes || undefined,
      });
      if (cErr) throw new Error(cErr.message);
      chargeId = (cId as unknown as string) ?? null;
    }

    // Compensation (wave-2 QA finding 5): if the incident insert fails after
    // the charge landed, void the charge so no money is billed for an
    // incident that doesn't exist, then rethrow.
    let row: { id: string };
    try {
      const { data: inserted, error } = await (supabase as any)
        .from("unit_incidents")
        .insert({
          organization_id: orgId,
          property_id: unit.property_id,
          unit_id: data.unitId,
          dog_id: data.dogId || null,
          incident_on: data.incidentOn ?? new Date().toISOString().slice(0, 10),
          kind: data.kind,
          notes: data.notes || null,
          charged_cents: data.chargedCents ?? null,
          created_by: userId,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      row = inserted as { id: string };
    } catch (e) {
      if (chargeId) {
        const { error: vErr } = await supabase.rpc("void_addon_charge", {
          _charge_id: chargeId,
        });
        if (vErr)
          console.error(
            `failed to void orphaned addon charge ${chargeId} after incident insert failure:`,
            vErr.message,
          );
      }
      throw e;
    }

    // Waste violations and DNA matches count against the unit's record.
    // Atomic SQL increment (wave-2 QA finding 6) — the previous JS
    // read-modify-write lost counts under concurrent incident logging.
    if (data.kind === "waste_violation" || data.kind === "dna_match") {
      const { error: incErr } = await (supabase as any).rpc("increment_unit_offense", {
        _unit_id: data.unitId,
      });
      if (incErr) console.warn("offending_count update failed:", incErr.message);
    }

    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId,
        clientId: clientId ?? null,
        propertyId: unit.property_id,
        actorUserId: userId,
        kind: "unit.incident",
        summary: `Logged ${INCIDENT_KIND_LABELS[data.kind].toLowerCase()} for unit ${unit.unit_label}${
          data.chargedCents ? ` ($${(data.chargedCents / 100).toFixed(2)} billed)` : ""
        }`,
      });
    } catch {}
    return { id: row.id as string };
  });
