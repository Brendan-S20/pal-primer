import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { LEAD_SOURCE, normalizeFormConfig } from "@/lib/new-customer-form";

const FORM_SOURCES = [LEAD_SOURCE.quoteRequest, LEAD_SOURCE.onlineSignup];

const STATUSES = ["new", "contacted", "qualified", "converted", "archived"] as const;


const leadSchema = z.object({
  slug: z.string().trim().min(1).max(120), // which business (finding #25)
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  company: z.string().trim().max(120).optional().or(z.literal("")),
  location: z.string().trim().max(200).optional().or(z.literal("")),
  dog_count: z.coerce.number().int().min(0).max(999).optional(),
  frequency: z.string().trim().max(40).optional().or(z.literal("")),
  message: z.string().trim().max(2000).optional().or(z.literal("")),
  source: z.string().trim().max(60).optional(),
});


// Finding #25: config + basic analytics for the tenant's public form. Since
// 2026-10-08 that is ONE form, /signup/{slug}, which prices the yard and lets
// the visitor start service or ask for a quote; /lead/{slug} forwards to it.
// The config (branding, copy, which optional questions to ask) is the hosted
// lead form's, read through normalizeFormConfig in new-customer-form.ts so the
// public page and this settings read cannot disagree about a default.

export const getLeadFormConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_leads");
    const [{ data: org }, totalRes, weekRes] = await Promise.all([
      (context.supabase.from("organizations") as any)
        .select("name, portal_slug, slug, public_signup_enabled, lead_form_config")
        .eq("id", orgId)
        .maybeSingle(),
      // Both things the public form makes: a quote request, and a signup
      // (which writes a lead too, see createSignupPaymentIntent). Not door
      // signups: those come from walk mode, not from the form.
      context.supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("source", FORM_SOURCES),
      context.supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("source", FORM_SOURCES)
        .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()),
    ]);
    return {
      orgName: org?.name ?? null,
      // The address the form answers on: portal_slug first, the signup slug
      // as the fallback, the same order public_get_org_for_lead_form and
      // public_quote resolve it in. portal_slug alone (as this read until the
      // forms merged) said "no address" to a business that had one.
      slug: org?.portal_slug ?? org?.slug ?? null,
      publicSignupEnabled: !!org?.public_signup_enabled,
      submissionsTotal: totalRes.count ?? 0,
      submissionsLast30: weekRes.count ?? 0,
      config: normalizeFormConfig(org?.lead_form_config),
    };
  });

const leadFormConfigSchema = z.object({
  brandColor: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, "Use a hex color like #2563eb").or(z.literal("")).nullable().optional(),
  logoUrl: z.string().trim().url().or(z.literal("")).nullable().optional(),
  headline: z.string().trim().max(120).optional(),
  intro: z.string().trim().max(400).optional(),
  confirmation: z.string().trim().max(400).optional(),
  fields: z.object({
    phone: z.boolean(),
    location: z.boolean(),
    dogCount: z.boolean(),
    message: z.boolean(),
  }),
});

export const setLeadFormConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => leadFormConfigSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_leads");
    const color = data.brandColor ? (data.brandColor.startsWith("#") ? data.brandColor : `#${data.brandColor}`) : null;
    const config = {
      brandColor: color,
      logoUrl: data.logoUrl || null,
      headline: data.headline || null,
      intro: data.intro || null,
      confirmation: data.confirmation || null,
      fields: data.fields,
    };
    const { error } = await (context.supabase.from("organizations") as any)
      .update({ lead_form_config: config })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "manage_leads");
    // With the signup a lead started, when it started one: Leads labels a
    // row "Started service online" or "Started signup online, didn't pay"
    // from it. signup_requests.lead_id (20261008160000) is the link.
    // And the service asked about (leads.service_id, 20261011150000), by its
    // name, when the business offers more than one and the visitor picked.
    const { data, error } = await context.supabase
      .from("leads")
      .select("*, signup_requests(status, refunded_at, created_at), service:services(name)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// Converting a lead opens the new-client wizard started from it
// (/clients/new?fromLead=<id>), and onboardClient marks the lead converted
// when the wizard saves. This used to be a one-tap insert that copied the
// name, email, phone and message and nothing else, so a lead with a ZIP, three
// dogs and a weekly frequency became a client with no property, no dogs and no
// service. See src/lib/lead-conversion.ts.
//
// The wizard reads the lead here, server-side, by id, rather than taking its
// fields in the URL: a lead is a stranger's name, email, phone and address,
// and a query string ends up in history, logs and referrers.
export const getLeadForConversion = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_leads");
    const { loadLeadForConversion } = await import("@/lib/lead-conversion.server");
    const { isSyntheticLeadEmail } = await import("@/lib/lead-conversion");
    const lead = await loadLeadForConversion(context.supabase, orgId, data.id);

    // The old conversion reused a client with the same email instead of
    // making a second one. The wizard cannot do that silently (it is about to
    // create a client), so it says so and offers to link the lead instead.
    let existingClient: { id: string; displayName: string } | null = null;
    if (lead.email && !isSyntheticLeadEmail(lead.email)) {
      const { data: match, error } = await context.supabase
        .from("clients")
        .select("id, display_name")
        .eq("organization_id", orgId)
        .eq("primary_email", lead.email.trim().toLowerCase())
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (match) existingClient = { id: match.id, displayName: match.display_name };
    }
    return { lead, existingClient };
  });

/** The lead IS an existing client (same person, already on the books): record
 *  the conversion against that client instead of creating a second one. */
export const linkLeadToExistingClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ leadId: z.string().uuid(), clientId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_leads");
    const { loadLeadForConversion, assertConvertible, markLeadConverted } = await import(
      "@/lib/lead-conversion.server"
    );
    const lead = await loadLeadForConversion(context.supabase, orgId, data.leadId);
    assertConvertible(lead);
    const { data: client, error } = await context.supabase
      .from("clients")
      .select("id")
      .eq("id", data.clientId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!client) throw new Error("That client was not found.");
    if (!(await markLeadConverted(context.supabase, lead.id, client.id)))
      throw new Error("That lead has already been converted.");
    return { clientId: client.id as string };
  });

export const updateLeadStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["new", "contacted", "qualified", "converted", "archived"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_leads");
    const patch: {
      status: (typeof STATUSES)[number];
      contacted_at?: string;
      converted_at?: string;
    } = { status: data.status };
    if (data.status === "contacted") patch.contacted_at = new Date().toISOString();
    if (data.status === "converted") patch.converted_at = new Date().toISOString();
    const { error } = await context.supabase.from("leads").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
