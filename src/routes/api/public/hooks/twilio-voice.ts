import { createFileRoute } from "@tanstack/react-router";
import crypto from "node:crypto";
import { appOrigin } from "@/lib/app-origin";

function secretEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Inbound VOICE webhook.
// Configure in Twilio Console for each number as the "A CALL COMES IN" URL:
//   https://<host>/api/public/hooks/twilio-voice?s=<TWILIO_INBOUND_SECRET>
// (POST, application/x-www-form-urlencoded).
// Twilio's built-in <Gather input="speech"> handles STT, <Say> handles TTS.
export const Route = createFileRoute("/api/public/hooks/twilio-voice")({
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
        const callSid = params.CallSid ?? "";
        const speech = (params.SpeechResult ?? "").trim();
        const turn = Number(url.searchParams.get("turn") ?? "0");
        const signature = request.headers.get("X-Twilio-Signature");

        if (!from || !to || !callSid) return xml("<Response><Hangup/></Response>", 200);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: org } = await supabaseAdmin
          .from("organizations")
          .select(
            "id, slug, sms_from_number, ai_receptionist_faq, ai_receptionist_persona, ai_voice_enabled, ai_voice_greeting",
          )
          .eq("sms_from_number", to)
          .maybeSingle();

        if (!org || !(org as any).ai_voice_enabled) {
          return xml(
            `<Response><Say>Sorry, this number is not accepting calls right now. Goodbye.</Say><Hangup/></Response>`,
            200,
          );
        }

        // Authn: shared inbound secret (platform-managed) OR a valid Twilio
        // signature from this org's own (BYOK) auth token.
        if (!sharedOk) {
          const { resolveOrgTwilioConfig } = await import("@/lib/twilio-credentials.server");
          const tenant = await resolveOrgTwilioConfig(org.id);
          const { twilioSignatureIsValid } = await import("@/lib/twilio-signature.server");
          // Validate against both the raw and canonical public URL (proxy-safe, M4).
          const canonicalUrl = appOrigin() + url.pathname + url.search;
          const ok = tenant?.authToken
            ? (twilioSignatureIsValid(request.url, params, tenant.authToken, signature) ||
               twilioSignatureIsValid(canonicalUrl, params, tenant.authToken, signature))
            : false;
          if (!ok) return new Response("unauthorized", { status: 401 });
        }

        const nextUrl = sharedOk
          ? `/api/public/hooks/twilio-voice?s=${encodeURIComponent(shared!)}&turn=${turn + 1}`
          : `/api/public/hooks/twilio-voice?turn=${turn + 1}`;

        // Initial call — greet and gather.
        if (turn === 0 || !speech) {
          const greeting =
            (org as any).ai_voice_greeting?.trim() ||
            "Hi, thanks for calling. How can I help?";
          return xml(gatherTwiml(nextUrl, greeting), 200);
        }

        // Match client by phone digits (best-effort).
        const fromDigits = from.replace(/\D/g, "");
        const { data: candidates } = await supabaseAdmin
          .from("clients")
          .select("id, primary_phone")
          .eq("organization_id", org.id)
          .not("primary_phone", "is", null);
        const client = (candidates ?? []).find(
          (c) => (c.primary_phone ?? "").replace(/\D/g, "") === fromDigits,
        );

        // Load prior turns for this call to keep conversation context.
        const { data: prior } = await supabaseAdmin
          .from("ai_receptionist_logs")
          .select("user_text, reply_text")
          .eq("call_sid", callSid)
          .order("created_at", { ascending: true })
          .limit(20);
        const history: Array<{ direction: "inbound" | "outbound"; body: string }> = [];
        for (const p of prior ?? []) {
          if (p.user_text) history.push({ direction: "inbound", body: p.user_text });
          if (p.reply_text) history.push({ direction: "outbound", body: p.reply_text });
        }

        const { runAiReceptionist } = await import("@/lib/ai-receptionist.server");
        const result = await runAiReceptionist({
          organizationId: org.id,
          orgSlug: (org as any).slug ?? "",
          fromNumber: from,
          toNumber: to,
          userText: speech,
          clientId: client?.id ?? null,
          persona: (org as any).ai_receptionist_persona ?? "",
          faq: (org as any).ai_receptionist_faq ?? null,
          channel: "voice",
          history,
        });

        await supabaseAdmin.from("ai_receptionist_logs").insert({
          organization_id: org.id,
          from_number: from,
          user_text: speech,
          reply_text: result.reply,
          tool_calls: result.toolCalls as any,
          model: result.model,
          latency_ms: result.latencyMs,
          error: result.error,
          escalated: result.escalated,
          channel: "voice",
          call_sid: callSid,
          turn,
        });

        const reply =
          result.reply ??
          "Sorry, I had trouble with that. Let me pass you along to a person.";

        if (result.escalated || !result.reply) {
          return xml(
            `<Response><Say voice="Polly.Joanna">${escapeXml(reply)} Please leave a short message after the tone.</Say><Record maxLength="90" playBeep="true" trim="trim-silence"/><Hangup/></Response>`,
            200,
          );
        }

        return xml(gatherTwiml(nextUrl, reply), 200);
      },
    },
  },
});

function gatherTwiml(actionUrl: string, sayText: string) {
  // speechTimeout=auto lets Twilio detect end of utterance.
  return `<Response><Gather input="speech" action="${escapeXml(actionUrl)}" method="POST" speechTimeout="auto" speechModel="phone_call" language="en-US"><Say voice="Polly.Joanna">${escapeXml(sayText)}</Say></Gather><Say>I didn't catch that. Goodbye.</Say><Hangup/></Response>`;
}

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
