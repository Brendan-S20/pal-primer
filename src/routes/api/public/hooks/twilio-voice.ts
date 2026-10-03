import { createFileRoute } from "@tanstack/react-router";
import { RECEPTIONIST_LAUNCHED } from "@/lib/receptionist-launch";
import {
  verifyTwilioInbound,
  continuationToken,
  continuationTokenValid,
} from "@/lib/twilio-inbound-auth.server";

// Inbound VOICE webhook.
// Configure in Twilio Console for each number as the "A CALL COMES IN" URL:
//   https://<host>/api/public/hooks/twilio-voice
// Set TWILIO_AUTH_TOKEN and no query secret is needed — Twilio signs every
// request. `?s=<TWILIO_INBOUND_SECRET>` still works as a fallback.
// (POST, application/x-www-form-urlencoded).
// Twilio's built-in <Gather input="speech"> handles STT, <Say> handles TTS.
export const Route = createFileRoute("/api/public/hooks/twilio-voice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);

        // Same as the SMS hook: public endpoint, `formData()` throws on a body
        // it cannot parse, and an unhandled throw is a 500 that means nothing.
        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response("expected application/x-www-form-urlencoded", { status: 400 });
        }
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
            "id, slug, sms_from_number, ai_receptionist_enabled, ai_receptionist_faq, ai_receptionist_persona, ai_voice_enabled, ai_voice_greeting",
          )
          .eq("sms_from_number", to)
          .maybeSingle();

        // Not launched: nothing reaches the model, whatever the flags say.
        if (
          !RECEPTIONIST_LAUNCHED ||
          !org ||
          !(org as any).ai_voice_enabled ||
          !(org as any).ai_receptionist_enabled
        ) {
          return xml(
            `<Response><Say>Sorry, this number is not accepting calls right now. Goodbye.</Say><Hangup/></Response>`,
            200,
          );
        }

        // Authn. SIGNATURE FIRST — see lib/twilio-inbound-auth.server. The old
        // order tried the shared query secret first, which made the stronger
        // check unreachable; and because this route echoed that secret into the
        // TwiML continuation URL, every multi-turn call wrote the platform's
        // master credential into Twilio's stored call log.
        const auth = await verifyTwilioInbound({
          requestUrl: request.url,
          pathWithQuery: url.pathname + url.search,
          params,
          signature,
          orgId: org.id,
          // A continuation is this call, this turn, and nothing else.
          continuationOk: continuationTokenValid(callSid, turn, url.searchParams.get("t")),
        });
        if (!auth.ok) return new Response("unauthorized", { status: 401 });

        // Scoped to THIS call and THIS turn, derived from the secret rather
        // than being it — so a leaked TwiML line or call log is not a reusable
        // credential and cannot be aimed at another call or replayed later.
        // Null when no secret is set, because then Twilio's own signature on
        // the continuation request is doing the work and nothing is needed.
        const nextToken = continuationToken(callSid, turn + 1);
        const nextUrl = nextToken
          ? `/api/public/hooks/twilio-voice?t=${encodeURIComponent(nextToken)}&turn=${turn + 1}`
          : `/api/public/hooks/twilio-voice?turn=${turn + 1}`;

        // Initial call — greet and gather.
        if (turn === 0 || !speech) {
          const greeting =
            (org as any).ai_voice_greeting?.trim() ||
            "Hi, thanks for calling. How can I help?";
          return xml(gatherTwiml(nextUrl, greeting), 200);
        }

        // Every spoken turn is a fresh model call and a metered action, and
        // nothing ended a call that kept going: a caller (or a robocaller, or
        // a voicemail system talking back) could hold the line and spend the
        // tenant's allowance a turn at a time. Past the limit it goes to a
        // person, the same way an escalation does.
        if (turn > MAX_AI_TURNS_PER_CALL) {
          return xml(
            `<Response><Say voice="Polly.Joanna">${escapeXml(
              "Let me have someone from the office get back to you.",
            )} Please leave a short message after the tone.</Say><Record maxLength="90" playBeep="true" trim="trim-silence"/><Hangup/></Response>`,
            200,
          );
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

const MAX_AI_TURNS_PER_CALL = 8;

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
