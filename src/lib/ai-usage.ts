// BUILD-2 — the parts of usage metering that are arithmetic, kept pure so they
// can be tested without a database or a model.
//
// The SQL function `ai_usage_state` is the authority on where an org stands
// (see 20260801140000). This module does not re-derive that: it interprets the
// answer, and it prices a provider call. Both halves are here because both are
// pure, and because the alternative — arithmetic inline in a server function —
// is what produced three copies of the royalty calculation.

/** Every feature that can spend an org's allowance. The string is stored on
 *  every usage row and shown to the customer, so it is a closed set rather
 *  than whatever label a call site happened to pass. */
export const AI_FEATURES = [
  "marketing_content",
  "review_reply",
  "churn_scoring",
  "weekly_digest",
  "weekly_digest_email",
  "business_advisor",
  "dispatch_suggestion",
  "zone_pricing",
  "ai_receptionist",
  "connection_test",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Features whose cost is NOT charged to the org.
 *
 *  `connection_test` is the Settings → AI health check: a 32-token call the
 *  product makes to prove its own configuration works. Billing a customer for
 *  our diagnostic is indefensible, and it is capped at 32 output tokens so the
 *  cost of exempting it is bounded. It is still RECORDED — an exemption that
 *  leaves no trace is indistinguishable from a meter that missed the call. */
export const UNBILLED_FEATURES: readonly AiFeature[] = ["connection_test"];

export function isBillableFeature(feature: AiFeature): boolean {
  return !UNBILLED_FEATURES.includes(feature);
}

/** What `ai_usage_state` returns, in TypeScript. Field names match the SQL
 *  column names exactly — a rename on either side should break the other. */
export type AiUsageState = {
  periodMonth: string;
  actionsUsed: number;
  /** null = unlimited (Enterprise). */
  actionsIncluded: number | null;
  overageCentsPerAction: number | null;
  hardCapActions: number | null;
  overAllowance: boolean;
  overHardCap: boolean;
  overageCents: number;
};

export type AiUsageDecision =
  { allow: true; overAllowance: boolean } | { allow: false; reason: string };

/** The fraction of the allowance consumed, or null when there is no allowance
 *  to be a fraction of. */
export function allowanceFraction(state: AiUsageState): number | null {
  if (state.actionsIncluded == null || state.actionsIncluded <= 0) return null;
  return state.actionsUsed / state.actionsIncluded;
}

export const WARN_AT_FRACTION = 0.8;

/** Should this org be warned that it is close to its allowance?
 *
 *  Only crossing matters. Warning on every call once past 80% would send a
 *  business one alert per AI action for the rest of the month, which is how a
 *  real warning gets filtered into a folder nobody reads. */
export function shouldWarn(state: AiUsageState, alreadyWarned: boolean): boolean {
  if (alreadyWarned) return false;
  const f = allowanceFraction(state);
  return f != null && f >= WARN_AT_FRACTION;
}

/**
 * May this call proceed?
 *
 * The soft cap does not stop anything — that is what makes it soft, and the
 * owner chose overage billing over refusal. The HARD ceiling does stop, and the
 * refusal has to say something a business owner can act on: which limit, and
 * the two ways out. A generic "quota exceeded" sends them to support.
 */
export function decideAiCall(state: AiUsageState): AiUsageDecision {
  if (state.overHardCap) {
    const used = state.actionsUsed.toLocaleString();
    const cap = (state.hardCapActions ?? 0).toLocaleString();
    return {
      allow: false,
      reason:
        `AI is paused for this month: ${used} actions used against a ceiling of ${cap}. ` +
        `Raise the ceiling in Settings → AI Tools, or it resets at the start of next month.`,
    };
  }
  return { allow: true, overAllowance: state.overAllowance };
}

// ── what a call cost US ────────────────────────────────────────────────────
//
// Recorded per event so the allowance can be checked against reality later.
// This is OUR cost, never the customer's — the customer pays per action, and
// the whole reason to record cost separately is to find out whether that price
// is right.
//
// Rates are in micros (millionths of a cent) per token, so an integer column
// holds them exactly. A 3,000-in / 1,000-out Sonnet call is 3000*200 +
// 1000*1000 = 1,600,000 micros = $0.016, which is the right order of magnitude
// against the published per-million-token prices.
//
// Approximate on purpose. An exact cost would mean tracking every provider's
// price list as it changes, and being wrong about a number nobody bills from
// is cheaper than being late. If a rate is missing we record ZERO rather than
// guessing high — an invented cost that flatters or alarms us is worse than an
// honest gap, and the token counts are stored raw so any figure can be
// recomputed later.
type TokenRates = { inMicrosPerToken: number; outMicrosPerToken: number };

const RATES: Record<string, TokenRates> = {
  // Re-baselined 2026-09-20 to the current generation's published prices.
  // The old rows priced Sonnet at the 4.6 generation's $3/$15 and Opus at
  // $15/$75 — TRIPLE Opus 5's actual $5/$25 — which matters because this
  // table is what anyone reads before deciding a feature "can't afford" a
  // stronger model. Approximate stays the policy; three-times-off does not.
  // Anthropic Sonnet-class (Sonnet 5): $2/M in, $10/M out.
  "claude-sonnet": { inMicrosPerToken: 200, outMicrosPerToken: 1000 },
  // Anthropic Haiku-class (Haiku 4.5): $1/M in, $5/M out.
  "claude-haiku": { inMicrosPerToken: 100, outMicrosPerToken: 500 },
  // Anthropic Opus-class (Opus 5): $5/M in, $25/M out.
  "claude-opus": { inMicrosPerToken: 500, outMicrosPerToken: 2500 },
  // OpenAI 4o-class: $2.50/M in, $10/M out.
  "gpt-4o": { inMicrosPerToken: 250, outMicrosPerToken: 1000 },
  // Gemini Flash-class, via the gateway: $0.30/M in, $2.50/M out.
  "gemini-flash": { inMicrosPerToken: 30, outMicrosPerToken: 250 },
};

/** Match a provider's model id to a rate family. Model ids carry versions and
 *  dates that change constantly; the family does not. */
export function rateFamilyFor(model: string | null | undefined): string | null {
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  if (m.includes("opus")) return "claude-opus";
  if (m.includes("haiku")) return "claude-haiku";
  if (m.includes("sonnet") || m.startsWith("claude")) return "claude-sonnet";
  if (m.includes("gpt-4o") || m.startsWith("gpt-")) return "gpt-4o";
  if (m.includes("flash") || m.includes("gemini")) return "gemini-flash";
  return null;
}

/** Our estimated cost for one call, in micros. Zero when the model is unknown. */
export function estimateCostMicros(opts: {
  model: string | null | undefined;
  inputTokens: number;
  outputTokens: number;
}): number {
  const family = rateFamilyFor(opts.model);
  const rates = family ? RATES[family] : undefined;
  if (!rates) return 0;
  const inTok = Math.max(0, Math.round(opts.inputTokens || 0));
  const outTok = Math.max(0, Math.round(opts.outputTokens || 0));
  return inTok * rates.inMicrosPerToken + outTok * rates.outMicrosPerToken;
}

// ── reading token counts back off a provider response ──────────────────────
//
// Three shapes, because there are three providers and none of them agree:
//
//   Anthropic     usage.input_tokens   / usage.output_tokens
//   OpenAI        usage.prompt_tokens  / usage.completion_tokens
//   Vercel AI SDK usage.inputTokens    / usage.outputTokens  (or promptTokens)
//
// Missing counts are ZERO, not an error. A meter that throws when a provider
// changes a field name would take down the feature it meters, and the ACTION
// is what the customer is billed for — the tokens are our own telemetry.

export type TokenCounts = { inputTokens: number; outputTokens: number };

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

export function tokensFromResponse(body: unknown): TokenCounts {
  const u = (body as { usage?: Record<string, unknown> } | null | undefined)?.usage;
  if (!u || typeof u !== "object") return { inputTokens: 0, outputTokens: 0 };
  return {
    inputTokens:
      num(u.input_tokens) || num(u.prompt_tokens) || num(u.inputTokens) || num(u.promptTokens),
    outputTokens:
      num(u.output_tokens) ||
      num(u.completion_tokens) ||
      num(u.outputTokens) ||
      num(u.completionTokens),
  };
}

/** The AI SDK returns usage at the top level rather than under `.usage` on the
 *  raw body, and multi-step calls report per-step usage that has to be summed
 *  — a receptionist conversation is six round-trips and reporting only the
 *  last one would under-count our cost by most of it. */
export function tokensFromAiSdkResult(result: unknown): TokenCounts {
  const r = result as { usage?: unknown; steps?: Array<{ usage?: unknown }> } | null | undefined;
  if (!r) return { inputTokens: 0, outputTokens: 0 };

  const steps = Array.isArray(r.steps) ? r.steps : [];
  if (steps.length > 0) {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const s of steps) {
      const t = tokensFromResponse({ usage: s?.usage });
      inputTokens += t.inputTokens;
      outputTokens += t.outputTokens;
    }
    if (inputTokens || outputTokens) return { inputTokens, outputTokens };
  }
  return tokensFromResponse({ usage: r.usage });
}
