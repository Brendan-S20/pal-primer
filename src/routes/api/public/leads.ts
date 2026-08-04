// Public JSON endpoint for the external marketing site to submit contact leads.
// POST https://www.app.houndstack.com/api/public/leads
// CORS: allow all origins (the marketing site is not deployed yet). Lock down
// later by echoing the request Origin against an allow-list.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveSupabaseUrl } from "@/lib/supabase-url";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

const jsonHeaders = { "Content-Type": "application/json", ...CORS };

const leadSchema = z.object({
  // Which business this lead belongs to (the tenant's portal slug). Required so
  // an embedded/hosted form routes to the right org (finding #25).
  slug: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  company: z.string().trim().max(120).optional().or(z.literal("")),
  location: z.string().trim().max(200).optional().or(z.literal("")),
  dog_count: z.coerce.number().int().min(0).max(999).optional().nullable(),
  frequency: z.string().trim().max(40).optional().or(z.literal("")),
  message: z.string().trim().max(2000).optional().or(z.literal("")),
  source: z.string().trim().max(60).optional(),
});

export const Route = createFileRoute("/api/public/leads")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: jsonHeaders,
          });
        }
        const parsed = leadSchema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: "Invalid input", details: parsed.error.flatten() }),
            { status: 400, headers: jsonHeaders },
          );
        }
        const data = parsed.data;
        const supabase = createClient<Database>(
          resolveSupabaseUrl(),
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false } },
        );
        // Resolve the tenant from its public slug (SECURITY DEFINER RPC, so it
        // works for the anonymous key). Lead capture matches portal_slug and is
        // not gated on public_signup_enabled (#3).
        const { data: orgRows } = await supabase.rpc("public_get_org_for_lead_form", { _slug: data.slug });
        const orgId = (orgRows as Array<{ id: string }> | null)?.[0]?.id ?? null;
        if (!orgId) {
          return new Response(JSON.stringify({ error: "Unknown business" }), { status: 404, headers: jsonHeaders });
        }
        const { error } = await (supabase.from("leads") as any).insert({
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
        });
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: jsonHeaders,
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: jsonHeaders,
        });
      },
    },
  },
});
