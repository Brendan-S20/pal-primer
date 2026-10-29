import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  canSubmit,
  einSchema,
  registrationDetailsSchema,
  STALE_SUBMIT_MS,
  type RegistrationStatus,
} from "@/lib/texting-registration";

// Settings → Texting (#538). The owner files the business's details here and
// HoundStack does the rest with Twilio: lib/twilio-provisioning.server.
//
// What comes back to the browser: the details the owner typed (they are the
// owner's own), the last four digits of the EIN, the number, and the status in
// Twilio's words for the screen to turn into plain ones. Never the EIN, never
// a token, never a SID.

const DETAIL_COLUMNS =
  "status, legal_name, business_type, dba, street, street2, city, region, postal_code, " +
  "website_url, privacy_url, terms_url, business_email, business_phone, contacts, ein_last4, " +
  "phone_number, rejection_reason, rejection_code, resubmit_deadline, last_error, " +
  "submitted_at, approved_at, checked_at, status_changed_at, updated_at";

export const getTextingRegistration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { orgCanTextClients } = await import("@/lib/twilio-credentials.server");
    const [{ data: reg }, live, { data: org }] = await Promise.all([
      (supabaseAdmin as any)
        .from("org_texting_registrations")
        .select(DETAIL_COLUMNS)
        .eq("organization_id", orgId)
        .maybeSingle(),
      orgCanTextClients(orgId),
      (supabaseAdmin as any)
        .from("organizations")
        .select("name, contact_email, contact_phone")
        .eq("id", orgId)
        .maybeSingle(),
    ]);
    return {
      registration: (reg ?? null) as null | (Record<string, any> & { status: RegistrationStatus }),
      /** True only once the verification is approved and activated. */
      live,
      /** What the business already told HoundStack, to start the form from. */
      suggestions: {
        businessName: (org?.name as string | null) ?? "",
        email: (org?.contact_email as string | null) ?? "",
        phone: (org?.contact_phone as string | null) ?? "",
      },
    };
  });

/** A draft keeps whatever has been typed; nothing is checked until submit. */
const draftSchema = z.object({
  legal_name: z.string().max(200).optional(),
  business_type: z.string().max(40).optional(),
  dba: z.string().max(200).optional(),
  street: z.string().max(200).optional(),
  street2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(80).optional(),
  postal_code: z.string().max(20).optional(),
  website_url: z.string().max(500).optional(),
  privacy_url: z.string().max(500).optional(),
  terms_url: z.string().max(500).optional(),
  business_email: z.string().max(255).optional(),
  business_phone: z.string().max(40).optional(),
  contacts: z
    .array(
      z.object({
        first_name: z.string().max(80).optional(),
        last_name: z.string().max(80).optional(),
        title: z.string().max(80).optional(),
        email: z.string().max(255).optional(),
        phone: z.string().max(40).optional(),
      }),
    )
    .max(2)
    .optional(),
});

async function currentStatus(
  orgId: string,
): Promise<{ status: RegistrationStatus | null; updatedAt: string | null }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (supabaseAdmin as any)
    .from("org_texting_registrations")
    .select("status, updated_at")
    .eq("organization_id", orgId)
    .maybeSingle();
  return {
    status: (data?.status as RegistrationStatus | undefined) ?? null,
    updatedAt: (data?.updated_at as string | undefined) ?? null,
  };
}

export const saveTextingDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => draftSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { status, updatedAt } = await currentStatus(orgId);
    if (!canSubmit(status, updatedAt))
      throw new Error("This registration is with Twilio and cannot be edited now.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as any;
    const clean = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : v]),
    );
    const { error: seedErr } = await db
      .from("org_texting_registrations")
      .upsert(
        { organization_id: orgId, status: "draft" },
        { onConflict: "organization_id", ignoreDuplicates: true },
      );
    if (seedErr) throw new Error(seedErr.message);
    // Conditional, like the submit's claim, so a save racing a submit cannot
    // write over a registration that has just gone to Twilio.
    const staleBefore = new Date(Date.now() - STALE_SUBMIT_MS).toISOString();
    const { data: saved, error } = await db
      .from("org_texting_registrations")
      .update({
        ...clean,
        contacts: data.contacts ?? [],
        // A draft stays a draft, and a rejected or stopped one keeps its
        // status (and its reason) until it is submitted again. A submit that
        // died partway is recorded as stopped, so saving does not make it
        // look freshly busy.
        ...(status === "submitting"
          ? { status: "failed", last_error: "Setup stopped before it finished." }
          : {}),
        updated_by: context.userId,
      })
      .eq("organization_id", orgId)
      .or(
        `status.in.(draft,rejected,failed),and(status.eq.submitting,updated_at.lt."${staleBefore}")`,
      )
      .select("organization_id");
    if (error) throw new Error(error.message);
    if (!saved?.length)
      throw new Error("This registration is with Twilio and cannot be edited now.");
    return { ok: true };
  });

export const submitTextingRegistration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ details: registrationDetailsSchema, ein: einSchema }).parse(d))
  .handler(async ({ data, context }) => {
    // Only the owner files a legal registration in the business's name.
    const { orgId, role } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_settings",
    );
    if (role !== "owner") throw new Error("Only the owner can submit the business's registration.");
    // A first check for a clear message; the provisioning claim is the one
    // that actually decides, atomically, who submits.
    const { status, updatedAt } = await currentStatus(orgId);
    if (!canSubmit(status, updatedAt)) throw new Error("This registration is already with Twilio.");
    const { submitTextingRegistration: submit } = await import("@/lib/twilio-provisioning.server");
    // The EIN is passed through to Twilio and dropped; see the module header.
    return submit({ orgId, userId: context.userId, details: data.details, ein: data.ein });
  });

/** "Check now": ask Twilio immediately rather than wait for the poll. At most
 *  once a minute per business. */
export const checkTextingStatusNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("org_texting_registrations")
      .select("status, checked_at")
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!data) return { status: null };
    // Only something Twilio still has, or an approval not yet switched on.
    // A live business is never re-activated from here.
    if (!["submitted", "in_review", "approved"].includes(data.status)) {
      return { status: data.status as RegistrationStatus };
    }
    if (data.checked_at && Date.now() - new Date(data.checked_at).getTime() < 60_000) {
      return { status: data.status as RegistrationStatus };
    }
    const { refreshTextingStatus, scrub } = await import("@/lib/twilio-provisioning.server");
    try {
      return { status: await refreshTextingStatus(orgId) };
    } catch (e) {
      console.error("texting status check failed", orgId, scrub((e as Error).message));
      throw new Error("Could not reach Twilio just now. Try again in a minute.");
    }
  });
