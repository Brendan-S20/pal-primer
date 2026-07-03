import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const bootstrapSchema = z.object({
  orgName: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
});

export const bootstrapOrganization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => bootstrapSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: orgId, error } = await supabase.rpc("bootstrap_organization", {
      _org_name: data.orgName,
      _display_name: data.displayName,
    });
    if (error) throw new Error(error.message);
    return { organizationId: orgId as string };
  });

export const getMyOrg = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: role, error: roleErr } = await supabase
      .from("user_roles")
      .select("organization_id, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!role) return { organization: null as null };

    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .select("id, name, active_client_count, billing_tier, plan_status, current_period_end, stripe_customer_id, stripe_subscription_id")
      .eq("id", role.organization_id)
      .single();
    if (orgErr) throw new Error(orgErr.message);

    return { organization: { ...org, role: role.role as string } };
  });


const brandingSchema = z.object({
  brandColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).nullable().optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
  contactPhone: z.string().max(30).nullable().optional(),
  contactEmail: z.string().email().max(255).nullable().optional(),
  portalRescheduleCutoffHours: z.number().int().min(0).max(168).optional(),
  portalAllowSelfReschedule: z.boolean().optional(),
  portalAllowVacationHold: z.boolean().optional(),
  portalAllowFrequencyChange: z.boolean().optional(),
  portalAutoApplyChanges: z.boolean().optional(),
});

export const getOrgBranding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: role } = await supabase.from("user_roles")
      .select("organization_id").eq("user_id", userId).maybeSingle();
    if (!role) throw new Error("No org");
    const { data, error } = await (supabase.from("organizations") as any)
      .select("id, name, brand_color, logo_url, contact_phone, contact_email, portal_reschedule_cutoff_hours, portal_allow_self_reschedule, portal_allow_vacation_hold, portal_allow_frequency_change, portal_auto_apply_changes")
      .eq("id", role.organization_id).single();
    if (error) throw new Error(error.message);
    return data as {
      id: string; name: string;
      brand_color: string | null; logo_url: string | null;
      contact_phone: string | null; contact_email: string | null;
      portal_reschedule_cutoff_hours: number;
      portal_allow_self_reschedule: boolean;
      portal_allow_vacation_hold: boolean;
      portal_allow_frequency_change: boolean;
      portal_auto_apply_changes: boolean;
    };
  });

export const updateOrgBranding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => brandingSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: role } = await supabase.from("user_roles")
      .select("organization_id, role").eq("user_id", userId).maybeSingle();
    if (!role) throw new Error("No org");
    if (role.role !== "owner" && role.role !== "office_manager")
      throw new Error("Not permitted");
    const patch: Record<string, unknown> = {};
    if (data.brandColor !== undefined) patch.brand_color = data.brandColor;
    if (data.logoUrl !== undefined) patch.logo_url = data.logoUrl;
    if (data.contactPhone !== undefined) patch.contact_phone = data.contactPhone;
    if (data.contactEmail !== undefined) patch.contact_email = data.contactEmail;
    if (data.portalRescheduleCutoffHours !== undefined) patch.portal_reschedule_cutoff_hours = data.portalRescheduleCutoffHours;
    if (data.portalAllowSelfReschedule !== undefined) patch.portal_allow_self_reschedule = data.portalAllowSelfReschedule;
    if (data.portalAllowVacationHold !== undefined) patch.portal_allow_vacation_hold = data.portalAllowVacationHold;
    if (data.portalAllowFrequencyChange !== undefined) patch.portal_allow_frequency_change = data.portalAllowFrequencyChange;
    if (data.portalAutoApplyChanges !== undefined) patch.portal_auto_apply_changes = data.portalAutoApplyChanges;
    const { error } = await supabase.from("organizations")
      .update(patch as any).eq("id", role.organization_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
