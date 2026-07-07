// Public JSON endpoint for the external marketing site to submit workspace
// signup requests. An admin then approves each request from the platform UI.
// POST https://app.houndstack.com/api/public/signup-requests
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

const jsonHeaders = { "Content-Type": "application/json", ...CORS };

const schema = z.object({
  organization_name: z.string().trim().min(1).max(200),
  contact_name: z.string().trim().min(1).max(120),
  contact_email: z.string().trim().email().max(255),
  contact_phone: z.string().trim().max(40).optional().or(z.literal("")),
  website: z.string().trim().max(255).optional().or(z.literal("")),
  approx_client_count: z.coerce.number().int().min(0).max(100000).optional().nullable(),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const Route = createFileRoute("/api/public/signup-requests")({
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
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: "Invalid input", details: parsed.error.flatten() }),
            { status: 400, headers: jsonHeaders },
          );
        }
        const data = parsed.data;
        const email = data.contact_email.toLowerCase();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: existing } = await supabaseAdmin
          .from("platform_signup_requests")
          .select("id")
          .eq("contact_email", email)
          .eq("status", "pending")
          .maybeSingle();
        if (existing) {
          return new Response(
            JSON.stringify({ ok: true, id: existing.id, dedup: true }),
            { status: 200, headers: jsonHeaders },
          );
        }

        const { data: row, error } = await supabaseAdmin
          .from("platform_signup_requests")
          .insert({
            organization_name: data.organization_name,
            contact_name: data.contact_name,
            contact_email: email,
            contact_phone: data.contact_phone || null,
            website: data.website || null,
            approx_client_count: data.approx_client_count ?? null,
            notes: data.notes || null,
          })
          .select("id")
          .single();
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: jsonHeaders,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, id: row.id, dedup: false }),
          { status: 201, headers: jsonHeaders },
        );
      },
    },
  },
});
