import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { COAT_TYPES, PET_SIZES, type GroomRule } from "@/lib/groom";

export type ServiceSizeRule = GroomRule & {
  id: string;
  service_id: string;
  organization_id: string;
};
export const sizeRuleSchema = z.object({
  id: z.string().uuid().optional(),
  serviceId: z.string().uuid(),
  size: z.enum(PET_SIZES),
  coatType: z.enum(COAT_TYPES).nullable(),
  durationMin: z.number().int().min(1).max(720),
  priceCents: z.number().int().min(0).max(10_000_000),
});

async function requireGroomService(supabase: any, serviceId: string, orgId: string) {
  const { data, error } = await supabase
    .from("services")
    .select("id, service_line")
    .eq("id", serviceId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Service not found.");
  if (data.service_line !== "mobile_grooming")
    throw new Error("Size rules are only for mobile grooming services.");
}

export const listServiceSizeRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ serviceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    await requireGroomService(context.supabase, data.serviceId, orgId);
    const { data: rules, error } = await context.supabase
      .from("service_size_rules")
      .select("*")
      .eq("service_id", data.serviceId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { rules: (rules ?? []) as ServiceSizeRule[] };
  });

export const upsertServiceSizeRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => sizeRuleSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    await requireGroomService(context.supabase, data.serviceId, orgId);
    const row = {
      service_id: data.serviceId,
      size: data.size,
      coat_type: data.coatType,
      duration_min: data.durationMin,
      price_cents: data.priceCents,
    };
    const query = data.id
      ? context.supabase
          .from("service_size_rules")
          .update(row)
          .eq("id", data.id)
          .eq("service_id", data.serviceId)
          .eq("organization_id", orgId)
      : context.supabase
          .from("service_size_rules")
          .upsert(row, { onConflict: "service_id,size,coat_type" });
    const { data: saved, error } = await query.select("id").single();
    if (error)
      throw new Error(
        error.code === "23505" ? "A rule already exists for this size and coat." : error.message,
      );
    return { id: saved.id };
  });

export const deleteServiceSizeRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), serviceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    await requireGroomService(context.supabase, data.serviceId, orgId);
    const { error } = await context.supabase
      .from("service_size_rules")
      .delete()
      .eq("id", data.id)
      .eq("service_id", data.serviceId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
