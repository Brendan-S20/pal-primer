import { createFileRoute } from "@tanstack/react-router";

// Inbound SMS webhook.
// Configure in Twilio Console for each number as the "A MESSAGE COMES IN" URL:
//   https://<host>/api/public/hooks/twilio?s=<TWILIO_INBOUND_SECRET>
// (POST, application/x-www-form-urlencoded)
export const Route = createFileRoute("/api/public/hooks/twilio")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const shared = process.env.TWILIO_INBOUND_SECRET;
        if (!shared) return new Response("not configured", { status: 500 });

        const url = new URL(request.url);
        if (url.searchParams.get("s") !== shared) {
          return new Response("unauthorized", { status: 401 });
        }

        const form = await request.formData();
        const from = String(form.get("From") ?? "");
        const to = String(form.get("To") ?? "");
        const body = String(form.get("Body") ?? "").trim();
        const sid = String(form.get("MessageSid") ?? "") || null;

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

        // Match client by digits(primary_phone) == digits(from)
        const fromDigits = from.replace(/\D/g, "");
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
            .or(`from_number.eq.${from},to_number.eq.${from}`)
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
