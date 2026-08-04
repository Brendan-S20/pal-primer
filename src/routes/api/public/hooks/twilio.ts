import { createFileRoute } from "@tanstack/react-router";
import { verifyTwilioInbound } from "@/lib/twilio-inbound-auth.server";

// Inbound SMS webhook.
// Configure in Twilio Console for each number as the "A MESSAGE COMES IN" URL:
//   https://<host>/api/public/hooks/twilio?s=<TWILIO_INBOUND_SECRET>
// (POST, application/x-www-form-urlencoded)
export const Route = createFileRoute("/api/public/hooks/twilio")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);

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
          // name/contact are not decoration: carrier rules require the BRAND to
          // identify itself in every STOP and HELP auto-reply, and require HELP
          // to give a real support contact.
          .select("id, slug, name, contact_email, contact_phone, sms_from_number, ai_receptionist_enabled, ai_receptionist_faq, ai_receptionist_persona")
          .eq("sms_from_number", to)
          .maybeSingle();
        if (!org) {
          console.warn("Inbound SMS: no org for To=", to);
          return xml("<Response/>", 200);
        }

        // Authn. SIGNATURE FIRST — see lib/twilio-inbound-auth.server. The old
        // order checked the shared query secret first, which made the stronger
        // check unreachable and left one platform-wide credential, carried in a
        // URL, as the whole of inbound authentication for every tenant.
        const auth = await verifyTwilioInbound({
          requestUrl: request.url,
          pathWithQuery: url.pathname + url.search,
          params,
          signature,
          orgId: org.id,
        });
        if (!auth.ok) return new Response("unauthorized", { status: 401 });

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
        // The BRAND has to name itself in every one of these. A reply that says
        // "contact your service provider" identifies nobody, gives the recipient
        // nowhere to go, and is the shape that fails a toll-free or 10DLC
        // verification review — the requirement is the brand name in the STOP
        // confirmation, and the brand name PLUS a real support contact in HELP.
        const brand = (org as any).name?.trim() || "HoundStack";
        const supportContact =
          (org as any).contact_phone?.trim() ||
          (org as any).contact_email?.trim() ||
          "support@houndstack.com";
        if (client && isStop) {
          await supabaseAdmin.from("clients").update({ sms_opt_out: true }).eq("id", client.id);
          reply =
            `${brand}: You are unsubscribed and will receive no further messages. ` +
            `Reply START to resubscribe or HELP for help.`;
        } else if (client && isStart) {
          await supabaseAdmin.from("clients").update({ sms_opt_out: false }).eq("id", client.id);
          reply =
            `${brand}: You are resubscribed to service messages. ` +
            `Msg & data rates may apply. Reply STOP to opt out or HELP for help.`;
        } else if (upper === "HELP" || upper === "INFO") {
          reply =
            `${brand}: Service and account messages. For help contact ${supportContact}. ` +
            `Msg & data rates may apply. Reply STOP to opt out.`;
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
