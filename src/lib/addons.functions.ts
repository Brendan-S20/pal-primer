import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await resolveCaller(supabase, userId)).orgId;
}

/** Default per-charge ceiling for field-billed add-ons when the org hasn't set one. */
export const DEFAULT_FIELD_ADDON_CAP_CENTS = 20000;

const FREQ = ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
const KIND = ["one_time", "recurring"] as const;

export const listAddonServices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ includeInactive: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    let q = context.supabase
      .from("addon_services")
      .select("*")
      .eq("organization_id", orgId)
      .order("name");
    if (!data.includeInactive) q = q.eq("active", true);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { services: rows ?? [] };
  });

export const upsertAddonService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid().optional(),
        code: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        description: z.string().max(500).optional().nullable(),
        kind: z.enum(KIND).default("one_time"),
        unit_price_cents: z.number().int().min(0),
        default_frequency: z.enum(FREQ).optional().nullable(),
        taxable: z.boolean().optional(),
        active: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const payload: any = {
      organization_id: orgId,
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      kind: data.kind,
      unit_price_cents: data.unit_price_cents,
      default_frequency: data.default_frequency ?? null,
      taxable: data.taxable ?? false,
      active: data.active ?? true,
      updated_at: new Date().toISOString(),
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("addon_services")
        .update(payload)
        .eq("id", data.id)
        .eq("organization_id", orgId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("addon_services")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row!.id as string };
  });

export const listClientAddons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const [charges, subs] = await Promise.all([
      context.supabase
        .from("addon_charges")
        .select("*, addon_services(name)")
        .eq("client_id", data.clientId)
        .order("occurred_on", { ascending: false })
        .limit(100),
      context.supabase
        .from("addon_subscriptions")
        .select("*, addon_services(name)")
        .eq("client_id", data.clientId)
        .order("created_at", { ascending: false }),
    ]);
    if (charges.error) throw new Error(charges.error.message);
    if (subs.error) throw new Error(subs.error.message);
    return { charges: charges.data ?? [], subscriptions: subs.data ?? [] };
  });

export const createAddonCharge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        addonServiceId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999).default(1),
        unitPriceCents: z.number().int().min(0).optional(),
        description: z.string().max(200).optional(),
        visitId: z.string().uuid().optional(),
        source: z.enum(["office", "field"]).default("office"),
        note: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let unitPriceCents = data.unitPriceCents;

    if (data.source === "field") {
      // Field billing is the capped, confirmed technician flow: catalog price
      // only, tied to one of the caller's own visits, total under the org cap.
      const { orgId } = await requirePermission(supabase, userId, "record_field_addons");

      if (!data.visitId) throw new Error("Field add-ons must be billed from a visit");
      const { data: visit, error: vErr } = await supabase
        .from("visits")
        .select("id, client_id, staff:assigned_staff_id(user_id)")
        .eq("id", data.visitId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (vErr) throw new Error(vErr.message);
      if (!visit) throw new Error("Visit not found");
      if (visit.client_id !== data.clientId) throw new Error("Visit does not belong to this client");
      if ((visit as any).staff?.user_id !== userId) {
        // Office roles may still field-bill on a tech's behalf.
        await requirePermission(supabase, userId, "manage_client_billing");
      }

      const [{ data: svc, error: sErr }, { data: org, error: oErr }] = await Promise.all([
        supabase
          .from("addon_services")
          .select("unit_price_cents")
          .eq("id", data.addonServiceId)
          .eq("organization_id", orgId)
          .maybeSingle(),
        supabase
          .from("organizations")
          // Column ships with the field-addon-cap migration; generated types
          // lag until Lovable regenerates them, hence the cast.
          .select("field_addon_cap_cents" as any)
          .eq("id", orgId)
          .single() as unknown as Promise<{ data: { field_addon_cap_cents: number | null } | null; error: any }>,
      ]);
      if (sErr) throw new Error(sErr.message);
      if (!svc) throw new Error("Add-on service not found");
      if (oErr) throw new Error(oErr.message);

      unitPriceCents = undefined; // field source always bills the catalog price
      const capCents = org?.field_addon_cap_cents ?? DEFAULT_FIELD_ADDON_CAP_CENTS;
      const totalCents = svc.unit_price_cents * Math.max(1, data.quantity);
      if (totalCents > capCents) {
        throw new Error(
          `Field add-ons are capped at $${(capCents / 100).toFixed(2)} per charge. Ask the office to bill this one`,
        );
      }
    } else {
      await requirePermission(supabase, userId, "manage_client_billing");
    }

    const { data: id, error } = await supabase.rpc("create_addon_charge", {
      _client_id: data.clientId,
      _addon_service_id: data.addonServiceId,
      _quantity: data.quantity,
      _unit_price_cents: unitPriceCents ?? undefined,
      _description: data.description ?? undefined,
      _visit_id: data.visitId ?? undefined,
      _source: data.source,
      _note: data.note ?? undefined,
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

export const voidAddonCharge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ chargeId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase.rpc("void_addon_charge", { _charge_id: data.chargeId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const createAddonSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        addonServiceId: z.string().uuid(),
        frequency: z.enum(FREQ),
        priceCents: z.number().int().min(0),
        quantity: z.number().int().min(1).default(1),
        startedOn: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const started = data.startedOn ?? new Date().toISOString().slice(0, 10);
    const { data: row, error } = await context.supabase
      .from("addon_subscriptions")
      .insert({
        organization_id: orgId,
        client_id: data.clientId,
        addon_service_id: data.addonServiceId,
        frequency: data.frequency,
        price_cents: data.priceCents,
        quantity: data.quantity,
        started_on: started,
        next_charge_on: started,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row!.id as string };
  });

export const setAddonSubscriptionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["active", "paused", "canceled"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase
      .from("addon_subscriptions")
      .update({ status: data.status, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const generateAddonCharges = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ through: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { data: n, error } = await context.supabase.rpc("generate_addon_charges_through", {
      _org_id: orgId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    return { generated: (n as number) ?? 0 };
  });
