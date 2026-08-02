import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

const bootstrapSchema = z.object({
  orgName: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
  // Referral/marketing attribution captured on /sign-up — only persisted at
  // org creation, the one moment attribution is reliable.
  refCode: z.string().trim().max(40).optional(),
  utm: z.record(z.string(), z.string().max(200)).optional(),
  // The "Promo or referral code" box on Get-started. May hold a platform
  // coupon code OR a tenant referral code — classified server-side below.
  promoCode: z.string().trim().max(40).optional(),
});

// Pre-signup validation for the "Promo or referral code" box: public (the
// account doesn't exist yet), advisory only — an invalid code warns in the UI
// but NEVER blocks signup, and bootstrapOrganization re-classifies
// authoritatively anyway.
export const validateSignupCode = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ code: z.string().trim().min(1).max(40) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { lookupSignupCode } = await import("@/lib/signup-codes.server");
    const hit = await lookupSignupCode(supabaseAdmin, data.code);
    if (hit.kind === "invalid") return { valid: false as const, message: hit.reason };
    return { valid: true as const, kind: hit.kind, message: hit.description };
  });

export const bootstrapOrganization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => bootstrapSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { lookupSignupCode } = await import("@/lib/signup-codes.server");

    // Classify the typed promo box BEFORE the RPC: a referral code entered
    // there rides the existing attribution path inside bootstrap_organization
    // (tenant_referrals ledger + fraud flags), while a coupon code is stored
    // on the org after creation for the first Stripe subscribe. Invalid codes
    // are dropped silently — a bad code must never block signup.
    let refCode = data.refCode || undefined;
    let couponCode: string | null = null;
    if (data.promoCode?.trim()) {
      try {
        const hit = await lookupSignupCode(supabaseAdmin, data.promoCode);
        if (hit.kind === "coupon") couponCode = hit.coupon.code;
        else if (hit.kind === "referral" && !refCode) refCode = data.promoCode.trim();
      } catch (e) {
        console.error("signup code classification failed (continuing without it)", e);
      }
    }

    const { data: orgId, error } = await supabase.rpc("bootstrap_organization", {
      _org_name: data.orgName,
      _display_name: data.displayName,
      _ref_code: refCode,
      _utm: data.utm && Object.keys(data.utm).length ? data.utm : undefined,
    });
    if (error) throw new Error(error.message);

    // Coupon capture: written once (only while null, so an idempotent re-run
    // for an existing org can't overwrite), audited best-effort. Application
    // happens later, at the first subscribe (createPlanSubscription).
    if (orgId && couponCode) {
      try {
        const { data: updated } = await (supabaseAdmin as any)
          .from("organizations")
          .update({ signup_promo_code: couponCode })
          .eq("id", orgId)
          .is("signup_promo_code", null)
          .select("id");
        if (updated?.length) {
          await supabaseAdmin.from("platform_admin_audit").insert({
            actor_user_id: userId,
            organization_id: orgId as string,
            action: "signup_promo_captured",
            after_json: { code: couponCode },
          });
        }
      } catch (e) {
        console.error("signup promo capture failed (signup continues)", e);
      }
    }
    return { organizationId: orgId as string };
  });

// Twilio/TCPA compliance: persist the owner's express SMS consent collected
// during the Get-started walkthrough — timestamp, the number it covers, and
// the exact language they agreed to. Also stamps the phone on their staff row.
export const recordSmsConsent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        phone: z.string().trim().min(7).max(40),
        consentText: z.string().min(10).max(1000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Writes org-level SMS consent via supabaseAdmin (which bypasses the
    // owner-only org RLS), so enforce the settings capability in code — a
    // tech/dispatcher token must not set org consent (I7). During onboarding
    // the caller is the just-created owner, who holds manage_settings.
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(supabase, userId, "manage_settings");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("organizations")
      .update({
        sms_consent_at: new Date().toISOString(),
        sms_consent_phone: data.phone,
        sms_consent_text: data.consentText,
      })
      .eq("id", orgId);
    if (error) throw new Error(error.message);

    await (supabaseAdmin as any)
      .from("staff")
      .update({ phone: data.phone })
      .eq("organization_id", orgId)
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
      .select(
        "id, name, portal_slug, active_client_count, billing_tier, plan_status, current_period_end, stripe_customer_id, stripe_subscription_id",
      )
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
    if (taken) throw new Error("That address is already taken. Try another.");
    const { error } = await admin
      .from("organizations")
      .update({ portal_slug: clean })
      .eq("id", orgId);
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
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{3,8}$/)
    .nullable()
    .optional(),
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
    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!role) throw new Error("No org");
    const { data, error } = await (supabase.from("organizations") as any)
      .select(
        "id, name, brand_color, logo_url, contact_phone, contact_email, portal_reschedule_cutoff_hours, portal_allow_self_reschedule, portal_allow_vacation_hold, portal_allow_frequency_change, portal_auto_apply_changes",
      )
      .eq("id", role.organization_id)
      .single();
    if (error) throw new Error(error.message);
    return data as {
      id: string;
      name: string;
      brand_color: string | null;
      logo_url: string | null;
      contact_phone: string | null;
      contact_email: string | null;
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
    if (data.portalRescheduleCutoffHours !== undefined)
      patch.portal_reschedule_cutoff_hours = data.portalRescheduleCutoffHours;
    if (data.portalAllowSelfReschedule !== undefined)
      patch.portal_allow_self_reschedule = data.portalAllowSelfReschedule;
    if (data.portalAllowVacationHold !== undefined)
      patch.portal_allow_vacation_hold = data.portalAllowVacationHold;
    if (data.portalAllowFrequencyChange !== undefined)
      patch.portal_allow_frequency_change = data.portalAllowFrequencyChange;
    if (data.portalAutoApplyChanges !== undefined)
      patch.portal_auto_apply_changes = data.portalAutoApplyChanges;
    // Through the helper so a zero-row update is an error. This is the only
    // write path for contact_email, which BUILD-5 made the reply-to on customer
    // email: an office manager "fixing" the reply-to used to get a success
    // toast while replies kept going to noreply@.
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(supabase, orgId, patch);
    return { ok: true };
  });
