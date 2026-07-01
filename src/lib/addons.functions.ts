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
    const orgId = await resolveOrgId(context.supabase, context.userId);
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
    const { data: id, error } = await context.supabase.rpc("create_addon_charge", {
      _client_id: data.clientId,
      _addon_service_id: data.addonServiceId,
      _quantity: data.quantity,
      _unit_price_cents: data.unitPriceCents ?? undefined,
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
    const orgId = await resolveOrgId(context.supabase, context.userId);
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
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: n, error } = await context.supabase.rpc("generate_addon_charges_through", {
      _org_id: orgId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    return { generated: (n as number) ?? 0 };
  });
