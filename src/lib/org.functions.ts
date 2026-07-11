import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

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

// Twilio/TCPA compliance: persist the owner's express SMS consent collected
// during the Get-started walkthrough — timestamp, the number it covers, and
// the exact language they agreed to. Also stamps the phone on their staff row.
export const recordSmsConsent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      phone: z.string().trim().min(7).max(40),
      consentText: z.string().min(10).max(1000),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: role, error: roleErr } = await supabase
      .from("user_roles")
      .select("organization_id, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!role) throw new Error("No organization for user");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("organizations")
      .update({
        sms_consent_at: new Date().toISOString(),
        sms_consent_phone: data.phone,
        sms_consent_text: data.consentText,
      })
      .eq("id", role.organization_id);
    if (error) throw new Error(error.message);

    await (supabaseAdmin as any)
      .from("staff")
      .update({ phone: data.phone })
      .eq("organization_id", role.organization_id)
      .eq("user_id", userId);
    return { ok: true };
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

    const { data: org, error: orgErr } = await (supabase as any)
      .from("organizations")
      .select("id, name, portal_slug, active_client_count, billing_tier, plan_status, current_period_end, stripe_customer_id, stripe_subscription_id")
      .eq("id", role.organization_id)
      .single();
    if (orgErr) throw new Error(orgErr.message);

    return { organization: { ...org, role: role.role as string } };
  });

const slugSchema = z.object({ slug: z.string().trim().min(3).max(63) });

/** Owner/office-manager: set the org's portal slug (unique, URL-safe). */
export const setPortalSlug = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => slugSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { slugify, isUuid } = await import("@/lib/portal-links.server");
    const clean = slugify(data.slug);
    if (clean.length < 3) throw new Error("Use at least 3 letters or numbers.");
    if (isUuid(clean)) throw new Error("That format isn't allowed.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as any;
    const { data: taken } = await admin
      .from("organizations")
      .select("id")
      .eq("portal_slug", clean)
      .neq("id", orgId)
      .maybeSingle();
    if (taken) throw new Error("That address is already taken — try another.");
    const { error } = await admin.from("organizations").update({ portal_slug: clean }).eq("id", orgId);
    if (error) throw new Error(error.message);
    return { slug: clean };
  });

/** Suggest an available slug from the org's current name (for the Settings UI). */
export const suggestPortalSlug = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { ensureOrgSlug } = await import("@/lib/portal-links.server");
    return { slug: await ensureOrgSlug(orgId) };
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
    const { orgId } = await requirePermission(supabase, userId, "manage_settings");
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
      .update(patch as any).eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
