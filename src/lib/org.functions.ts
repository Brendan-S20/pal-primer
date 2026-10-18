import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuthedContext } from "@/lib/server-fn-context";
import { accessTurnedOff, requirePermission } from "@/lib/authz.server";
import { assertValidOrgName } from "@/lib/dna-linkage";
import { isMissingCountryColumn, selectWithCountryFallback } from "@/lib/org-country-column";

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
  // The browser's own IANA zone, read at signup. Shape-checked only: whether
  // this server can actually resolve it is pg_timezone_names' question, and
  // bootstrap_organization asks it. An unrecognised zone is dropped there
  // rather than raised on, so a browser string can never block a signup.
  timezone: z.string().trim().max(64).optional(),
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
      _timezone: data.timezone || undefined,
    });
    if (error) throw new Error(error.message);

    // Coupon capture: written once (only while null, so an idempotent re-run
    // for an existing org can't overwrite), audited best-effort. Application
    // happens later, at the first subscribe (createPlanSubscription).
    //
    // `promoStored` is null when there was no coupon code to keep, and a
    // boolean when there was. That distinction is the point: Get-started
    // validates the typed code on blur and TELLS THE PERSON it is good, so a
    // capture that then fails leaves somebody promised a discount, with nothing
    // stored, and no way for createPlanSubscription to warn them later --
    // "never entered a code" and "we lost your code" are the same empty column.
    // This is the only place the difference is still visible.
    let promoStored: boolean | null = null;
    if (orgId && couponCode) {
      promoStored = false;
      try {
        const { data: updated } = await (supabaseAdmin as any)
          .from("organizations")
          .update({ signup_promo_code: couponCode })
          .eq("id", orgId)
          .is("signup_promo_code", null)
          .select("id");
        if (updated?.length) {
          promoStored = true;
          await supabaseAdmin.from("platform_admin_audit").insert({
            actor_user_id: userId,
            organization_id: orgId as string,
            action: "signup_promo_captured",
            after_json: { code: couponCode },
          });
        } else {
          // Zero rows is NOT necessarily a failure: the `.is(null)` guard makes
          // this idempotent, so a re-run against an org that already carries a
          // code matches nothing and that is the correct outcome. Asking what
          // is actually stored is the only way to tell that apart from a write
          // that did not land.
          const { data: row } = await (supabaseAdmin as any)
            .from("organizations")
            .select("signup_promo_code")
            .eq("id", orgId)
            .maybeSingle();
          promoStored = !!row?.signup_promo_code;
        }
      } catch (e) {
        console.error("signup promo capture failed (signup continues)", e);
      }
    }
    return { organizationId: orgId as string, promoStored };
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
  .handler(async ({ context }) => loadMyOrg(context));

/** getMyOrg's answer, also asked by getShellContext. */
export const loadMyOrg = createServerOnlyFn(
  async (context: AuthedContext) => {
    const { supabase, userId } = context;

    // Both at once. access_turned_off is the one question a person who has
    // been turned off may still ask: which business turned them off.
    const [{ data: role, error: roleErr }, off] = await Promise.all([
      supabase.from("user_roles").select("organization_id, role").eq("user_id", userId).maybeSingle(),
      accessTurnedOff(supabase),
    ]);
    if (roleErr) throw new Error(roleErr.message);
    if (!role) return { organization: null as null, accessTurnedOff: null as null };

    // Off means off (20261009180000): no business, and the shell says why
    // instead of drawing a workspace every query in which comes back empty.
    const mine = off.find((o) => o.organizationId === role.organization_id);
    if (mine) {
      return {
        organization: null as null,
        accessTurnedOff: { organizationName: mine.organizationName },
      };
    }

    // Through the fallback so a deploy that lands before 20261018120000 reads
    // `country: null` instead of breaking every signed-in page.
    const { data: org, error: orgErr } = await selectWithCountryFallback(
      // `timezone` is here for useOrgToday: components that judge whether a
      // date has passed must ask the org's calendar, not the server's
      // default. See src/hooks/useOrgToday.ts. `require_completion_photo`
      // and `visit_checklist` are here for My Day (useOrgFieldRules): this
      // query is persisted for offline, so a tech in a dead zone still
      // knows what finishing a visit asks of them. `country` and `currency`
      // are here for useDistanceUnit: miles or km on the board and drawer.
      "id, name, portal_slug, timezone, country, currency, active_client_count, billing_tier, plan_status, current_period_end, stripe_customer_id, stripe_subscription_id, slug, is_comped, require_completion_photo, visit_checklist",
      (columns) =>
        (supabase as any)
          .from("organizations")
          .select(columns)
          .eq("id", role.organization_id)
          .single(),
    );
    if (orgErr) throw new Error(orgErr.message);

    return { organization: { ...org, role: role.role as string }, accessTurnedOff: null as null };
  },
);

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
  // The business name. Editable here because until now it could ONLY be set at
  // signup: /get-started asks for it, and every other route to an organization
  // — an OAuth round-trip, a magic link, a bootstrap deferred past email
  // confirmation — derived one and left the owner stuck with it. It is printed
  // on invoices, the customer portal and outbound email, so "Jane Smith's
  // Organization" was a name real customers would read.
  name: z.string().trim().min(1).max(120).optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{3,8}$/)
    .nullable()
    .optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
  contactPhone: z.string().max(30).nullable().optional(),
  contactEmail: z.string().email().max(255).nullable().optional(),
  // Free text, one field, printed not parsed — see the migration header.
  // Max matches the CHECK on the column so the two cannot disagree.
  contactAddress: z.string().trim().min(1).max(300).nullable().optional(),
  // ISO 3166-1 alpha-2, the same rule as the column's CHECK
  // (20261018120000). null is "not set": the app asks the browser instead.
  country: z
    .string()
    .regex(/^[A-Z]{2}$/, "Choose a country")
    .nullable()
    .optional(),
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
    // Same fallback as loadMyOrg: `country: null` until the column exists.
    const { data, error } = await selectWithCountryFallback(
      // latitude/longitude: the point updateOrgBranding geocodes the address
      // to. The setup guide centres the first service area on it.
      "id, name, brand_color, logo_url, contact_phone, contact_email, contact_address, country, latitude, longitude, portal_reschedule_cutoff_hours, portal_allow_self_reschedule, portal_allow_vacation_hold, portal_allow_frequency_change, portal_auto_apply_changes",
      (columns) =>
        (supabase.from("organizations") as any)
          .select(columns)
          .eq("id", role.organization_id)
          .single(),
    );
    if (error) throw new Error(error.message);
    return data as {
      id: string;
      name: string;
      brand_color: string | null;
      logo_url: string | null;
      contact_phone: string | null;
      contact_email: string | null;
      contact_address: string | null;
      country: string | null;
      latitude: number | null;
      longitude: number | null;
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
    // Through the same validator signup uses, so the placeholder rules cannot
    // be sidestepped by editing afterwards what could not be typed at signup.
    if (data.name !== undefined) patch.name = assertValidOrgName(data.name);
    if (data.brandColor !== undefined) patch.brand_color = data.brandColor;
    if (data.logoUrl !== undefined) patch.logo_url = data.logoUrl;
    if (data.contactPhone !== undefined) patch.contact_phone = data.contactPhone;
    if (data.contactEmail !== undefined) patch.contact_email = data.contactEmail;
    if (data.contactAddress !== undefined) {
      patch.contact_address = data.contactAddress;
      // Geocoded here because the route planner cannot use an address. When a
      // technician has no start address of their own, staff_start_point falls
      // back to the business location — see 20260815180000 — and that tier is
      // dead weight unless somebody turns this string into a point.
      //
      // Cleared when the address is cleared. Coordinates left pointing at a
      // previous premises are worse than none: the planner has no way to doubt
      // them, and every route would start from the old yard.
      if (data.contactAddress) {
        const { geocodeAddress } = await import("@/lib/geocode.server");
        const geo = await geocodeAddress({ street: data.contactAddress });
        patch.latitude = geo?.latitude ?? null;
        patch.longitude = geo?.longitude ?? null;
      } else {
        patch.latitude = null;
        patch.longitude = null;
      }
    }
    if (data.country !== undefined) patch.country = data.country;
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
    try {
      await updateOwnOrg(supabase, orgId, patch);
    } catch (e) {
      // Before 20261018120000 is applied the whole update fails on `country`.
      // Save everything else once more without it rather than lose the form.
      if (!("country" in patch) || !isMissingCountryColumn(e as Error)) throw e;
      console.warn("organizations.country is not on this database yet; saved without it");
      const { country: _notYet, ...rest } = patch;
      if (Object.keys(rest).length) await updateOwnOrg(supabase, orgId, rest);
    }
    return { ok: true };
  });
