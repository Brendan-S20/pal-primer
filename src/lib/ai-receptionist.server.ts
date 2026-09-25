// AI SMS Receptionist — server only.
// Called from the Twilio inbound webhook when an org has ai_receptionist_enabled.
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider, GATEWAY_MODEL_ID } from "./ai-gateway.server";

const MODEL_ID = GATEWAY_MODEL_ID;
const MAX_REPLY_LEN_SMS = 320; // ~2 SMS segments
const MAX_REPLY_LEN_VOICE = 500; // ~2 sentences read aloud

export type AiReceptionistInput = {
  organizationId: string;
  orgSlug: string;
  fromNumber: string;
  toNumber: string;
  userText: string;
  clientId: string | null;
  persona: string;
  faq: string | null;
  channel?: "sms" | "voice";
  // last N messages with this from_number, oldest→newest
  history: Array<{ direction: "inbound" | "outbound"; body: string }>;
};

export type AiReceptionistResult = {
  reply: string | null;
  toolCalls: unknown[];
  escalated: boolean;
  latencyMs: number;
  model: string;
  error: string | null;
};

export async function runAiReceptionist(input: AiReceptionistInput): Promise<AiReceptionistResult> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) {
    return {
      reply: null,
      toolCalls: [],
      escalated: true,
      latencyMs: 0,
      model: MODEL_ID,
      error: "LOVABLE_API_KEY not configured",
    };
  }

  // BUILD-7: AI is paid-only. Escalate rather than fail — a real customer just
  // texted this business, and the worst outcome is that nobody answers because
  // the plan lapsed. `escalated: true` routes it to a human on the existing
  // path, which is exactly what should happen when the robot cannot reply.
  const { orgMayUseAi } = await import("@/lib/ai-access.server");
  if (!(await orgMayUseAi(input.organizationId))) {
    return {
      reply: null,
      toolCalls: [],
      escalated: true,
      latencyMs: 0,
      model: MODEL_ID,
      error: "AI receptionist needs a paid plan",
    };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const gateway = createLovableAiGatewayProvider(key);

  const tools = {
    get_pricing_quote: tool({
      description:
        "Get an instant per-visit price quote for this business. Use this whenever the caller asks about price, cost, or how much it is.",
      inputSchema: z.object({
        postal_code: z.string().trim().describe("5-digit US ZIP code"),
        dogs: z.number().int().min(1).max(10),
        frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]),
      }),
      execute: async ({ postal_code, dogs, frequency }) => {
        const { data, error } = await supabaseAdmin.rpc("public_quote", {
          _slug: input.orgSlug,
          _postal_code: postal_code,
          _dog_count: dogs,
          _frequency: frequency,
        });
        if (error) return { available: false, reason: error.message };
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) return { available: false, reason: "No service in that zip." };
        return {
          available: true,
          price_per_visit_usd: (row.recurring_price_cents ?? 0) / 100,
          first_cleanup_usd: (row.initial_cleanup_cents ?? 0) / 100,
          zone_name: row.zone_name ?? null,
        };
      },
    }),
    lookup_faq: tool({
      description:
        "Look up an answer in the business's FAQ knowledge base for questions about scheduling, service area, cancellation, weather, or company policies.",
      inputSchema: z.object({
        topic: z.string().describe("The topic the caller is asking about."),
      }),
      execute: async ({ topic }) => ({ faq: input.faq ?? "", topic }),
    }),
    capture_lead: tool({
      description:
        "Save a new prospect's contact info so a human can follow up. Use when the caller wants to sign up, wants a callback, or asks a question the FAQ can't answer.",
      inputSchema: z.object({
        display_name: z.string().min(1),
        note: z.string().describe("What they want or asked about."),
      }),
      execute: async ({ display_name, note }) => {
        const digits = input.fromNumber.replace(/\D/g, "") || "unknown";
        const { data, error } = await supabaseAdmin
          .from("leads")
          .insert({
            name: display_name,
            email: `${digits}@sms.lead`,
            phone: input.fromNumber,
            source: "sms_receptionist",
            message: note,
            status: "new",
          })
          .select("id")
          .single();
        if (error) return { ok: false, error: error.message };
        return { ok: true, lead_id: data.id };
      },
    }),
    escalate_to_human: tool({
      description:
        "Send this conversation to a human dispatcher. Use only when you cannot help or the caller explicitly asks for a person.",
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => ({ escalated: true, reason }),
    }),
  };

  const isVoice = input.channel === "voice";
  const maxLen = isVoice ? MAX_REPLY_LEN_VOICE : MAX_REPLY_LEN_SMS;
  // em-dash-ok: addressed to the model, not to a person. Rewording a prompt
  // to satisfy a punctuation rule is editing behaviour to fix a typo.
  const channelRule = isVoice
    ? `- You are on a live PHONE CALL. Speak conversationally in 1-2 short sentences (under ${maxLen} characters). No emoji, no URLs, no markdown — everything you say is read aloud.`
    : `- Keep every SMS reply under ${maxLen} characters.`;
  const system = [
    input.persona.trim(),
    "",
    "Rules:",
    channelRule,
    "- Never guess prices. Always call get_pricing_quote before quoting.",
    "- If you don't know something, call lookup_faq. If the FAQ doesn't cover it, call escalate_to_human.",
    "- If the caller expresses interest in signing up, call capture_lead with their name and what they asked for.",
    "- End with a clear next step (a question, a price, or a promise to follow up).",
  ].join("\n");

  const messages = [
    ...input.history.map((m) => ({
      role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    })),
    { role: "user" as const, content: input.userText },
  ];

  const started = Date.now();
  try {
    const result = await generateText({
      model: gateway(MODEL_ID),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(6),
    });
    const latencyMs = Date.now() - started;

    // Flatten tool calls across steps for logging + escalation detection
    const toolCalls: any[] = [];
    let escalated = false;
    for (const step of result.steps ?? []) {
      for (const tc of step.toolCalls ?? []) {
        toolCalls.push({ name: tc.toolName, args: tc.input });
        if (tc.toolName === "escalate_to_human") escalated = true;
      }
    }

    const raw = (result.text ?? "").trim();
    const reply = raw ? raw.slice(0, maxLen) : null;

    // BUILD-2. ONE action for the whole conversation turn, not one per model
    // step — a customer cannot be told they were billed six times for one
    // text. The TOKENS are summed across every step, because that is what the
    // turn actually cost us, and the gap between the two is the number that
    // tells us whether the receptionist's $49/mo is priced right.
    //
    // This is the call site the hard ceiling exists for: it is triggered by an
    // inbound message, so nobody is watching, and a loop between two automated
    // systems spends real money at machine speed.
    void (async () => {
      const [{ tokensFromAiSdkResult }, { recordAiUsage }] = await Promise.all([
        import("@/lib/ai-usage"),
        import("@/lib/ai-usage.server"),
      ]);
      await recordAiUsage({
        orgId: input.organizationId,
        feature: "ai_receptionist",
        provider: "lovable-gateway",
        model: MODEL_ID,
        ...tokensFromAiSdkResult(result),
      });
    })().catch((e) => console.error("[receptionist] metering failed", e));

    return { reply, toolCalls, escalated, latencyMs, model: MODEL_ID, error: null };
  } catch (e: any) {
    return {
      reply: null,
      toolCalls: [],
      escalated: true,
      latencyMs: Date.now() - started,
      model: MODEL_ID,
      error: e?.message ?? String(e),
    };
  }
}
