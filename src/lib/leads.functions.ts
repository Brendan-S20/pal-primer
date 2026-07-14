import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import type { Database } from "@/integrations/supabase/types";

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
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY!;
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

export const submitLead = createServerFn({ method: "POST" })
  .inputValidator((d) => leadSchema.parse(d))
  .handler(async ({ data }) => {
    const supabase = anonClient();
    // Lead capture resolves by portal_slug (what Settings hands out), not the
    // signup-gated public_get_org_by_slug (#3).
    const { data: orgRows } = await supabase.rpc("public_get_org_for_lead_form", { _slug: data.slug });
    const orgId = (orgRows as Array<{ id: string }> | null)?.[0]?.id ?? null;
    if (!orgId) throw new Error("Unknown business");
    const payload = {
      organization_id: orgId,
      name: data.name,
      email: data.email.toLowerCase(),
      phone: data.phone || null,
      company: data.company || null,
      location: data.location || null,
      dog_count: data.dog_count ?? null,
      frequency: data.frequency || null,
      message: data.message || null,
      source: data.source || "website",
    };
    const { error } = await (supabase.from("leads") as any).insert(payload);
    if (error) throw new Error(error.message);
    // In-app notification to the office that a new website lead came in.
    try {
      const { notifyRoles } = await import("@/lib/notify-center.server");
      await notifyRoles(["owner", "office_manager", "dispatcher"], {
        orgId,
        type: "lead",
        title: "New website lead",
        body: `${data.name}${data.location ? ` · ${data.location}` : ""}`,
        link: "/leads",
      });
    } catch (e) {
      console.error("lead in-app notification failed", (e as Error).message);
    }
    return { ok: true };
  });

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

// Finding #39: actually convert a lead into a Client (pre-filled from the
// lead), instead of just relabeling its status. Idempotent-ish: a lead already
// converted with a linked client is not duplicated.
export const convertLeadToClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_leads");
    const { data: lead, error } = await context.supabase
      .from("leads")
      .select("id, name, email, phone, message, status")
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);

    // Reuse an existing client with the same email in this org if one exists.
    let clientId: string | null = null;
    if (lead.email) {
      const { data: existing } = await context.supabase
        .from("clients")
        .select("id")
        .eq("organization_id", orgId)
        .eq("primary_email", lead.email.toLowerCase())
        .maybeSingle();
      clientId = existing?.id ?? null;
    }

    if (!clientId) {
      const { data: created, error: cErr } = await context.supabase
        .from("clients")
        .insert({
          organization_id: orgId,
          display_name: lead.name,
          account_type: "residential",
          primary_email: lead.email ? lead.email.toLowerCase() : null,
          primary_phone: lead.phone || null,
          notes: lead.message || null,
        })
        .select("id")
        .single();
      if (cErr) throw new Error(cErr.message);
      clientId = created.id as string;
    }

    await context.supabase
      .from("leads")
      .update({ status: "converted", converted_at: new Date().toISOString() })
      .eq("id", data.id);

    return { clientId };
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
