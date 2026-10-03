// Server-only direct-provider access for AI Tools (Anthropic OR OpenAI).
//
// Each org brings its own provider + API key (Settings → AI); this module is
// handed a resolved AiConfig per call. Structured output uses the provider's
// native forced tool/function call, which constrains the model to the JSON
// schema server-side, then we re-validate with zod. Every failure path throws
// AiGenerationError — a real failure must never be indistinguishable from a
// legitimately empty result.

import { z } from "zod";

export class AiGenerationError extends Error {
  constructor(
    public readonly label: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`${label}: ${message}`);
    this.name = "AiGenerationError";
  }
}

export type AiProvider = "anthropic" | "openai";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
}

/** BUILD-2. Who to bill and what for.
 *
 *  Optional, because two callers legitimately have no org: the Settings health
 *  check before an org exists, and any future platform-side use. Absent means
 *  "not metered", which is only ever correct when there is nobody to meter —
 *  every tenant-facing call site passes it, and tests/ai-metering-is-wired.test.ts is
 *  what stops a new one from quietly not. */
export interface AiMeter {
  orgId: string;
  feature: import("@/lib/ai-usage").AiFeature;
  /** From clearAiCall — recorded on the event so an overage line is traceable
   *  to the individual calls that caused it. */
  overAllowance?: boolean;
}

const REQUEST_TIMEOUT_MS = 120_000;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
};

/**
 * Resolve the effective AI config: the per-org config if present, else the
 * platform's own ANTHROPIC_API_KEY env fallback (so the tools still work if an
 * operator sets a default). Returns null when nothing is configured.
 */
export function resolveAiConfigFromEnv(): AiConfig | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return {
    provider: "anthropic",
    apiKey: key,
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODELS.anthropic,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type JsonSchema = Record<string, unknown>;

function requireConfig(label: string, config: AiConfig | null): AiConfig {
  if (!config || !config.apiKey) {
    // Was "Add your Anthropic or OpenAI API key in Settings → AI", which named
    // a field IMP-9 removed with BYOK. Nothing a tenant can do reaches this
    // now: the only way here is a deployment with no platform key, since a
    // plan refusal throws its own reason in resolveOrgAiConfig.
    throw new AiGenerationError(
      label,
      "AI is temporarily unavailable on HoundStack's side. Nothing is wrong with your account. Please contact support if it persists.",
    );
  }
  return config;
}

/**
 * BUILD-2: the one place a Path-A response body exists in full, and therefore
 * the one place its token counts can be read.
 *
 * Metering happens HERE rather than in the two public functions because both
 * of them go through this, and a meter attached to the callers is a meter the
 * third caller forgets. It runs only on a SUCCESSFUL response: a request that
 * was rejected or that ran out of retries spent nothing the customer asked for,
 * and billing for a failure we could not deliver is not defensible.
 *
 * Awaited, and it never throws. It used to be `void`, so the customer's result
 * would not wait on our bookkeeping. But this runs on Cloudflare Workers, where
 * work still pending when the response goes out may be cancelled, and this row
 * is what the hard cap counts and what the overage invoice bills. One insert
 * after seconds of model time is the cheaper trade (2026-10-03).
 */
async function meter(meterOpts: AiMeter | undefined, config: AiConfig, body: unknown): Promise<void> {
  if (!meterOpts) return;
  await (async () => {
    const [{ tokensFromResponse }, { recordAiUsage }] = await Promise.all([
      import("@/lib/ai-usage"),
      import("@/lib/ai-usage.server"),
    ]);
    const { inputTokens, outputTokens } = tokensFromResponse(body);
    await recordAiUsage({
      orgId: meterOpts.orgId,
      feature: meterOpts.feature,
      provider: config.provider,
      model: config.model,
      inputTokens,
      outputTokens,
      overAllowance: meterOpts.overAllowance,
    });
  })().catch((e) => console.error("[ai] metering failed", meterOpts.feature, e));
}

async function callProvider(
  label: string,
  config: AiConfig,
  body: Record<string, unknown>,
  meterOpts?: AiMeter,
): Promise<any> {
  const isAnthropic = config.provider === "anthropic";
  const url = isAnthropic ? ANTHROPIC_URL : OPENAI_URL;
  const headers: Record<string, string> = isAnthropic
    ? {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      }
    : { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: config.model, ...body }),
        // There was no limit at all. Two minutes covers the largest call here
        // (churn scoring, up to 16k output tokens); past that the request is
        // hung, and a hung request must not be retried twice more.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = err;
      if ((err as Error)?.name === "TimeoutError") break;
      continue; // network hiccup — retry
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`${config.provider} API returned ${res.status}`);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[ai] ${label} request rejected`,
        config.provider,
        res.status,
        detail.slice(0, 1000),
      );
      // There is no API key in Settings any more (BYOK went with IMP-9; see
      // line 78), so a 401 is ours to fix, not the tenant's. The hint used to
      // send them to look for a field that does not exist.
      const hint =
        res.status === 401 ? " (a HoundStack configuration issue, not your account)" : "";
      throw new AiGenerationError(label, `The AI request was rejected (${res.status})${hint}.`);
    }
    const json = await res.json();
    await meter(meterOpts, config, json);
    return json;
  }
  console.error(`[ai] ${label} unavailable after retries`, config.provider, lastErr);
  throw new AiGenerationError(
    label,
    "The AI service is unavailable right now. Try again in a minute.",
    lastErr,
  );
}

/**
 * Generate a structured object matching `schema`, enforced natively by the
 * provider via a forced tool/function call (`jsonSchema` is the wire-format
 * JSON Schema for the same shape), then re-validated with zod. Throws
 * AiGenerationError on any failure — never resolves to a silent empty result.
 */
export async function generateStructured<T>(opts: {
  config: AiConfig | null;
  label: string;
  prompt: string;
  schema: z.ZodType<T>;
  jsonSchema: JsonSchema;
  maxTokens?: number;
  /** BUILD-2. Omit ONLY when there is no organization to attribute the call to. */
  meter?: AiMeter;
}): Promise<T> {
  const config = requireConfig(opts.label, opts.config);
  const maxTokens = opts.maxTokens ?? 4096;

  let rawInput: unknown;
  if (config.provider === "anthropic") {
    const data = await callProvider(
      opts.label,
      config,
      {
        max_tokens: maxTokens,
        tools: [
          {
            name: "emit_result",
            description: "Emit the final structured result. Always call this exactly once.",
            input_schema: opts.jsonSchema,
          },
        ],
        tool_choice: { type: "tool", name: "emit_result" },
        messages: [{ role: "user", content: opts.prompt }],
      },
      opts.meter,
    );
    if (data?.stop_reason === "max_tokens") {
      console.error(`[ai] ${opts.label} hit max_tokens, output truncated`);
      throw new AiGenerationError(
        opts.label,
        "The AI response was cut off before completing. Try a smaller batch.",
      );
    }
    const toolUse = (data?.content ?? []).find((b: any) => b?.type === "tool_use");
    if (!toolUse) {
      console.error(
        `[ai] ${opts.label} returned no tool_use block`,
        JSON.stringify(data?.content ?? []).slice(0, 1000),
      );
      throw new AiGenerationError(opts.label, "The AI returned no structured result.");
    }
    rawInput = toolUse.input;
  } else {
    const data = await callProvider(
      opts.label,
      config,
      {
        max_tokens: maxTokens,
        tools: [
          {
            type: "function",
            function: {
              name: "emit_result",
              description: "Emit the final structured result. Always call this exactly once.",
              parameters: opts.jsonSchema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_result" } },
        messages: [{ role: "user", content: opts.prompt }],
      },
      opts.meter,
    );
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === "length") {
      console.error(`[ai] ${opts.label} hit token limit, output truncated`);
      throw new AiGenerationError(
        opts.label,
        "The AI response was cut off before completing. Try a smaller batch.",
      );
    }
    const call = choice?.message?.tool_calls?.[0]?.function?.arguments;
    if (!call) {
      console.error(
        `[ai] ${opts.label} returned no function call`,
        JSON.stringify(choice ?? {}).slice(0, 1000),
      );
      throw new AiGenerationError(opts.label, "The AI returned no structured result.");
    }
    try {
      rawInput = JSON.parse(call);
    } catch {
      throw new AiGenerationError(opts.label, "The AI returned malformed structured output.");
    }
  }

  const parsed = opts.schema.safeParse(rawInput);
  if (!parsed.success) {
    console.error(
      `[ai] ${opts.label} schema validation failed`,
      JSON.stringify(parsed.error.issues).slice(0, 1000),
      JSON.stringify(rawInput).slice(0, 2000),
    );
    throw new AiGenerationError(opts.label, "The AI returned a result in an unexpected format.");
  }
  return parsed.data;
}

/** Generate plain prose. Throws AiGenerationError on failure or empty output. */
export async function generateAiText(opts: {
  config: AiConfig | null;
  label: string;
  prompt: string;
  maxTokens?: number;
  /** BUILD-2. Omit ONLY when there is no organization to attribute the call to. */
  meter?: AiMeter;
}): Promise<string> {
  const config = requireConfig(opts.label, opts.config);
  const maxTokens = opts.maxTokens ?? 2048;

  let text = "";
  if (config.provider === "anthropic") {
    const data = await callProvider(
      opts.label,
      config,
      {
        max_tokens: maxTokens,
        messages: [{ role: "user", content: opts.prompt }],
      },
      opts.meter,
    );
    text = (data?.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  } else {
    const data = await callProvider(
      opts.label,
      config,
      {
        max_tokens: maxTokens,
        messages: [{ role: "user", content: opts.prompt }],
      },
      opts.meter,
    );
    text = (data?.choices?.[0]?.message?.content ?? "").trim();
  }
  if (!text) {
    throw new AiGenerationError(opts.label, "The AI returned an empty response.");
  }
  return text;
}
