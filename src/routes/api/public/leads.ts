// Public JSON endpoint for a lead form embedded on a tenant's own website.
//
// POST https://app.houndstack.com/api/public/leads
//
// That host was wrong on this line until 2026-08-10: it read
// `www.app.houndstack.com`, which no longer has a DNS record at all. The app's
// own lead page (routes/lead.$slug.tsx) posts to the relative path and was
// never affected — but a tenant embedding this form copies the absolute URL
// from a line exactly like this one, and a Resend webhook configured against
// the same stale host sat disabled for eight days before anyone noticed. A
// test now pins every `VERB https://…` comment in the repo to appOrigin(); see
// tests/one-app-origin.test.ts.
//
// CORS: allow all origins, because the callers are tenant websites on domains
// this app does not know ahead of time. Narrowing it means echoing the request
// Origin against a site the tenant has registered, which needs somewhere to
// store that — not built, and deliberately not half-built here.
//
// Since 20261009220000 this is also the only way a lead gets in from outside.
// It used to write with the publishable key, under an INSERT policy that let
// anyone holding that key (every browser) post straight to /rest/v1/leads past
// everything below. That policy is gone and the write is the service role's,
// behind the honeypot, the time-to-submit check and the rate limit in
// lib/public-form-guard.ts. A refusal says one calm thing and writes nothing. A
// lead that IS written is told to the office (lib/lead-notify.server.ts).
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import {
  CALM_REFUSAL,
  ELAPSED_FIELD,
  HONEYPOT_FIELD,
  callerAddress,
  screenSubmission,
} from "@/lib/public-form-guard";
import { customerCanBookService } from "@/lib/service-lines";
import { isRequestedAsAStay } from "@/lib/public-services";
import {
  bookingDetailsColumns,
  bookingDetailsSchema,
  bookingDetailsProblem,
  normalizeBookingDetails,
} from "@/lib/booking-details";

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
  // The service asked about (phase 5), when the business offers more than
  // one. An id from public_services, checked below against the business the
  // slug resolved to; a business that sells one thing never sends it.
  service_id: z.string().uuid().optional().nullable(),
  // The first visit's answers (#527): the pets by name, how to get in, and
  // when to start. All optional here; see the check below for why.
  ...bookingDetailsSchema.shape,
  // The spam filters (public-form-guard.ts). Unknown rather than a bounded
  // string, so a script that stuffs the honeypot with a novel gets the same
  // calm refusal as one that writes a word, not a validation error naming it.
  [HONEYPOT_FIELD]: z.unknown().optional(),
  [ELAPSED_FIELD]: z.unknown().optional(),
});

const refused = (status: number) =>
  new Response(JSON.stringify({ error: CALM_REFUSAL }), { status, headers: jsonHeaders });

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

        // The two checks that need nothing but the body, before anything is
        // looked up or written.
        const screened = screenSubmission({
          honeypot: data[HONEYPOT_FIELD],
          elapsedMs: data[ELAPSED_FIELD],
        });
        if (!screened.ok) {
          console.warn("public lead refused", screened.reason);
          return refused(400);
        }

        const supabase = createClient<Database>(
          resolveSupabaseUrl(),
          process.env.SUPABASE_PUBLISHABLE_KEY!,
          { auth: { persistSession: false } },
        );
        // Resolve the tenant from its public slug (SECURITY DEFINER RPC, so it
        // works for the anonymous key). Lead capture matches portal_slug and is
        // not gated on public_signup_enabled (#3).
        const { data: orgRows } = await supabase.rpc("public_get_org_for_lead_form", {
          _slug: data.slug,
        });
        const orgId = (orgRows as Array<{ id: string }> | null)?.[0]?.id ?? null;
        if (!orgId) {
          return new Response(JSON.stringify({ error: "Unknown business" }), {
            status: 404,
            headers: jsonHeaders,
          });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // The service named has to be THIS business's. Another business's id,
        // or one that does not exist, is a body the form never sends, so it is
        // the same refusal as any other malformed input, before a turn is
        // taken or anything is written. A deactivated service of this business
        // is still recorded: the person asked for it, and the office should
        // know that, even if it is no longer sold. A service on a line that is
        // still Coming soon is refused the same way (#506): the form never
        // lists one (publicServiceChoices), so naming one is a hand-built body.
        // Coming soon is the platform switch, read at runtime (#531).
        let service: { id: string; name: string; stay: boolean } | null = null;
        if (data.service_id) {
          const { data: svc } = await (supabaseAdmin.from("services") as any)
            .select("id, name, service_line, price_unit")
            .eq("id", data.service_id)
            .eq("organization_id", orgId)
            .maybeSingle();
          const { loadServiceLineAvailability } =
            await import("@/lib/service-line-availability.server");
          if (
            !svc?.id ||
            !customerCanBookService(svc.service_line, await loadServiceLineAvailability())
          ) {
            return new Response(JSON.stringify({ error: "Invalid input" }), {
              status: 400,
              headers: jsonHeaders,
            });
          }
          service = {
            id: svc.id as string,
            name: (svc.name as string) ?? "",
            stay: isRequestedAsAStay(svc),
          };
        }
        // A stay (priced per night, #546) is a request for dates, not a
        // cadence: whatever frequency a body carries, the lead stores none,
        // so the office never reads "Weekly" on an Overnight stay.
        const frequency = service?.stay ? null : data.frequency || null;

        // The first visit's answers, held to the business's settings. Only
        // what was SENT is checked: a start date before the business can
        // come is refused, but a required question left out is not, because
        // this endpoint is also the one a tenant's own website posts to, and
        // a form embedded before #527 has no such fields. Turning "required"
        // on in Settings must not silently stop the website's leads. The
        // booking link itself enforces required in the browser.
        let detailsConfig = normalizeBookingDetails(null);
        try {
          const { data: org } = await (supabaseAdmin.from("organizations") as any)
            .select("lead_form_config")
            .eq("id", orgId)
            .maybeSingle();
          const cfg = org?.lead_form_config;
          detailsConfig = normalizeBookingDetails(
            cfg && typeof cfg === "object" ? (cfg as any).details : null,
          );
        } catch (e) {
          console.error("public lead booking details lookup failed", orgId, e);
        }
        const detailsAnswer = {
          pets: data.pets,
          dogCount: data.dog_count ?? null,
          accessNotes: data.access_notes,
          preferredStartDate: data.preferred_start_date,
        };
        const detailsProblem = bookingDetailsProblem(
          { ...detailsConfig, pets: "optional", access: "optional", startDate: "optional" },
          detailsAnswer,
          new Date().toISOString().slice(0, 10),
        );
        if (detailsProblem) {
          return new Response(JSON.stringify({ error: detailsProblem }), {
            status: 400,
            headers: jsonHeaders,
          });
        }
        const details = bookingDetailsColumns(detailsConfig, detailsAnswer);

        const { takePublicFormTurn } = await import("@/lib/public-form-guard.server");
        const turn = await takePublicFormTurn(
          supabaseAdmin as any,
          orgId,
          callerAddress((h) => request.headers.get(h)),
        );
        if (!turn.ok) {
          console.warn("public lead rate-limited", orgId, turn.reason);
          return refused(429);
        }

        // The service role, so status and the three workflow stamps are what
        // this line says and nothing the caller sent: a submission is always a
        // new, untouched lead. That was the dropped INSERT policy's rule; it
        // lives where the write is now.
        const source = data.source || "website";
        const location = data.location || null;
        const { data: lead, error } = await (supabaseAdmin.from("leads") as any)
          .insert({
            organization_id: orgId,
            name: data.name,
            email: data.email.toLowerCase(),
            phone: data.phone || null,
            company: data.company || null,
            location,
            dog_count: data.dog_count ?? null,
            frequency,
            message: data.message || null,
            source,
            status: "new",
            // Only when one was named: a lead from a business that sells one
            // thing is the row it always was, with no service_id key at all.
            ...(service ? { service_id: service.id } : {}),
            // Only the answers given: a lead from an older embedded form is
            // the row it always was.
            ...Object.fromEntries(Object.entries(details).filter(([, v]) => v != null)),
          })
          .select("id")
          .single();
        if (error || !lead?.id) {
          // Postgres's words are for us, not for a homeowner.
          console.error("public lead insert failed", orgId, error?.message);
          return new Response(
            JSON.stringify({ error: "Something went wrong. Please try again." }),
            { status: 500, headers: jsonHeaders },
          );
        }

        const { notifyOfficeOfNewLead } = await import("@/lib/lead-notify.server");
        await notifyOfficeOfNewLead({
          orgId,
          leadId: lead.id as string,
          name: data.name,
          source,
          location,
          dogCount: data.dog_count ?? null,
          frequency,
          serviceName: service?.name ?? null,
        });

        return new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: jsonHeaders,
        });
      },
    },
  },
});
