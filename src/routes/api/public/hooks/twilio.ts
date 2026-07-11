import { createFileRoute } from "@tanstack/react-router";
import crypto from "node:crypto";

function secretEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Inbound SMS webhook.
// Configure in Twilio Console for each number as the "A MESSAGE COMES IN" URL:
//   https://<host>/api/public/hooks/twilio?s=<TWILIO_INBOUND_SECRET>
// (POST, application/x-www-form-urlencoded)
export const Route = createFileRoute("/api/public/hooks/twilio")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const shared = process.env.TWILIO_INBOUND_SECRET;
        const url = new URL(request.url);
        const sharedOk = !!shared && secretEq(url.searchParams.get("s") ?? "", shared);

        const form = await request.formData();
        const params: Record<string, string> = {};
        for (const [k, v] of form.entries()) params[k] = String(v);
        const from = params.From ?? "";
        const to = params.To ?? "";
        const body = (params.Body ?? "").trim();
        const sid = params.MessageSid || null;
        const signature = request.headers.get("X-Twilio-Signature");

        if (!from || !to) {
          return xml("<Response/>", 200);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Match org by sms_from_number == To
        const { data: org } = await supabaseAdmin
          .from("organizations")
          .select("id, slug, sms_from_number, ai_receptionist_enabled, ai_receptionist_faq, ai_receptionist_persona")
          .eq("sms_from_number", to)
          .maybeSingle();
        if (!org) {
          console.warn("Inbound SMS: no org for To=", to);
          return xml("<Response/>", 200);
        }

        // Authn: the shared inbound secret (platform-managed numbers) OR a valid
        // Twilio signature from this org's own (BYOK) auth token. A single shared
        // secret can't authenticate N tenant Twilio accounts, so BYOK orgs are
        // verified per-request against their own token.
        if (!sharedOk) {
          const { resolveOrgTwilioConfig } = await import("@/lib/twilio-credentials.server");
          const tenant = await resolveOrgTwilioConfig(org.id);
          const { twilioSignatureIsValid } = await import("@/lib/twilio-signature.server");
          // Twilio signs the exact public URL it was configured with; behind a
          // proxy request.url can differ (scheme/host/www), so validate against
          // both the raw URL and the canonical public URL to avoid a false 401
          // that would silently break BYOK inbound (M4).
          const canonicalUrl = (process.env.PUBLIC_APP_ORIGIN || "https://www.app.houndstack.com") + url.pathname + url.search;
          const ok = tenant?.authToken
            ? (twilioSignatureIsValid(request.url, params, tenant.authToken, signature) ||
               twilioSignatureIsValid(canonicalUrl, params, tenant.authToken, signature))
            : false;
          if (!ok) return new Response("unauthorized", { status: 401 });
        }

        // Replay/idempotency (M2): ignore a MessageSid we've already processed so
        // a captured request can't re-toggle opt-out or re-invoke the (paid) AI
        // receptionist.
        if (sid) {
          const { data: dup } = await supabaseAdmin
            .from("messages").select("id").eq("twilio_sid", sid).limit(1).maybeSingle();
          if (dup) return xml("<Response/>", 200);
        }

        // Match client by digits(primary_phone) == digits(from)
        const fromDigits = from.replace(/\D/g, "");
        // Sanitized sender for the history filter — strip anything that isn't a
        // phone char so it can't inject PostgREST .or() filter syntax (L5).
        const safeFrom = from.replace(/[^+\d]/g, "");
        const { data: candidates } = await supabaseAdmin
          .from("clients")
          .select("id, primary_phone, sms_opt_out")
          .eq("organization_id", org.id)
          .not("primary_phone", "is", null);
        const client = (candidates ?? []).find(
          (c) => (c.primary_phone ?? "").replace(/\D/g, "") === fromDigits,
        );

        // STOP / START / HELP keyword handling per carrier rules.
        const upper = body.toUpperCase();
        const isStop = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(upper);
        const isStart = ["START", "YES", "UNSTOP"].includes(upper);
        let reply: string | null = null;
        let aiHandled = false;
        let escalated = false;
        if (client && isStop) {
          await supabaseAdmin.from("clients").update({ sms_opt_out: true }).eq("id", client.id);
          reply = "You have been unsubscribed and will not receive further messages. Reply START to resubscribe.";
        } else if (client && isStart) {
          await supabaseAdmin.from("clients").update({ sms_opt_out: false }).eq("id", client.id);
          reply = "You are resubscribed to messages. Reply STOP to opt out.";
        } else if (upper === "HELP" || upper === "INFO") {
          reply = "Support: contact your service provider. Reply STOP to opt out.";
        }

        const { data: inboundMsg } = await supabaseAdmin.from("messages").insert({
          organization_id: org.id,
          client_id: client?.id ?? null,
          direction: "inbound",
          body,
          from_number: from,
          to_number: to,
          twilio_sid: sid,
          status: "received",
        }).select("id").single();

        // AI receptionist: only if enabled, not a keyword, and not opted out.
        if (!reply && org.ai_receptionist_enabled && !(client?.sms_opt_out) && body) {
          const { runAiReceptionist } = await import("@/lib/ai-receptionist.server");
          const { data: hist } = await supabaseAdmin
            .from("messages")
            .select("direction, body, created_at")
            .eq("organization_id", org.id)
            .or(`from_number.eq.${safeFrom},to_number.eq.${safeFrom}`)
            .order("created_at", { ascending: false })
            .limit(10);
          const history = (hist ?? [])
            .reverse()
            .filter((m: any) => m.body && m.body !== body)
            .map((m: any) => ({
              direction: m.direction as "inbound" | "outbound",
              body: m.body as string,
            }));

          const result = await runAiReceptionist({
            organizationId: org.id,
            orgSlug: (org as any).slug ?? "",
            fromNumber: from,
            toNumber: to,
            userText: body,
            clientId: client?.id ?? null,
            persona: org.ai_receptionist_persona ?? "",
            faq: org.ai_receptionist_faq ?? null,
            history,
          });
          if (result.reply) {
            reply = result.reply;
            aiHandled = true;
          }
          escalated = !!result.escalated;
          await supabaseAdmin.from("ai_receptionist_logs").insert({
            organization_id: org.id,
            inbound_message_id: inboundMsg?.id ?? null,
            from_number: from,
            user_text: body,
            reply_text: result.reply,
            tool_calls: result.toolCalls as any,
            model: result.model,
            latency_ms: result.latencyMs,
            error: result.error,
            escalated: result.escalated,
          });
        }

        // Ping the office when a human is needed: the AI escalated, or an
        // inbound text got no automated answer at all.
        if (body && (escalated || (!reply && !aiHandled))) {
          try {
            const { notifyRoles } = await import("@/lib/notify-center.server");
            await notifyRoles(["owner", "office_manager", "dispatcher"], {
              orgId: org.id,
              type: escalated ? "receptionist_escalation" : "inbound_sms",
              title: escalated ? "AI receptionist needs a human" : "New text needs a reply",
              body: `${from}: ${body.slice(0, 120)}`,
              link: "/messages",
            });
          } catch (e) {
            console.error("inbound in-app notification failed", (e as Error).message);
          }
        }

        if (reply) {
          // Log outbound (TwiML replies aren't captured by status callbacks)
          await supabaseAdmin.from("messages").insert({
            organization_id: org.id,
            client_id: client?.id ?? null,
            direction: "outbound",
            body: reply,
            from_number: to,
            to_number: from,
            status: "sent",
            ai_handled: aiHandled,
          });
          return xml(
            `<Response><Message>${escapeXml(reply)}</Message></Response>`,
            200,
          );
        }
        return xml("<Response/>", 200);
      },
    },
  },
});

function xml(body: string, status: number) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
