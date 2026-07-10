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
    const { data: orgRows } = await supabase.rpc("public_get_org_by_slug", { _slug: data.slug });
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
    return { ok: true };
  });

// Finding #25: config + basic analytics for the tenant's embeddable lead form.
export const getLeadFormConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_leads");
    const [{ data: org }, totalRes, weekRes] = await Promise.all([
      (context.supabase.from("organizations") as any)
        .select("name, portal_slug, public_signup_enabled")
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
