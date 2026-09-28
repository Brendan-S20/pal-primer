import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import type { Database } from "@/integrations/supabase/types";
import { resolveSupabaseUrl } from "@/lib/supabase-url";

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

function anonClient() {
  const url = resolveSupabaseUrl();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

// Finding #25: config + basic analytics for the tenant's embeddable lead form.

// Default copy + field visibility for the hosted/embedded lead form. name +
// email are always required; the rest are toggleable.
const LEAD_FORM_DEFAULTS = {
  brandColor: null as string | null,
  logoUrl: null as string | null,
  headline: "Request a quote",
  intro: "Tell us about your yard and we'll get you a quote.",
  confirmation: "Thanks, we got your request! We'll be in touch shortly to set up your service.",
  fields: { phone: true, location: true, dogCount: true, message: true },
};

function normalizeLeadFormConfig(raw: any) {
  const c = raw && typeof raw === "object" ? raw : {};
  const f = c.fields && typeof c.fields === "object" ? c.fields : {};
  return {
    brandColor: typeof c.brandColor === "string" && c.brandColor ? c.brandColor : LEAD_FORM_DEFAULTS.brandColor,
    logoUrl: typeof c.logoUrl === "string" && c.logoUrl ? c.logoUrl : LEAD_FORM_DEFAULTS.logoUrl,
    headline: typeof c.headline === "string" && c.headline.trim() ? c.headline : LEAD_FORM_DEFAULTS.headline,
    intro: typeof c.intro === "string" && c.intro.trim() ? c.intro : LEAD_FORM_DEFAULTS.intro,
    confirmation: typeof c.confirmation === "string" && c.confirmation.trim() ? c.confirmation : LEAD_FORM_DEFAULTS.confirmation,
    fields: {
      phone: f.phone !== false,
      location: f.location !== false,
      dogCount: f.dogCount !== false,
      message: f.message !== false,
    },
  };
}

export const getLeadFormConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_leads");
    const [{ data: org }, totalRes, weekRes] = await Promise.all([
      (context.supabase.from("organizations") as any)
        .select("name, portal_slug, public_signup_enabled, lead_form_config")
        .eq("id", orgId)
        .maybeSingle(),
      context.supabase.from("leads").select("id", { count: "exact", head: true }).eq("source", "website"),
      context.supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("source", "website")
        .gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString()),
    ]);
    return {
      orgName: org?.name ?? null,
      slug: org?.portal_slug ?? null,
      publicSignupEnabled: !!org?.public_signup_enabled,
      submissionsTotal: totalRes.count ?? 0,
      submissionsLast30: weekRes.count ?? 0,
      config: normalizeLeadFormConfig(org?.lead_form_config),
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

/** Public (no-auth) branding + field config for the hosted lead form. */
export const getPublicLeadForm = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().trim().min(1).max(120) }).parse(d))
  .handler(async ({ data }) => {
    const supabase = anonClient();
    const { data: orgRows } = await supabase.rpc("public_get_org_for_lead_form", { _slug: data.slug });
    const org = (orgRows as Array<{ id: string; name?: string }> | null)?.[0] ?? null;
    if (!org) throw new Error("Unknown business");
    // Read the (public-safe) branding config with the service role — anon can't
    // select organizations directly under RLS.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: cfgRow } = await (supabaseAdmin as any)
      .from("organizations")
      .select("name, lead_form_config")
      .eq("id", org.id)
      .maybeSingle();
    return {
      orgName: cfgRow?.name ?? org.name ?? null,
      config: normalizeLeadFormConfig(cfgRow?.lead_form_config),
    };
  });

export const listLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "manage_leads");
    const { data, error } = await context.supabase
      .from("leads")
      .select("*")
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
