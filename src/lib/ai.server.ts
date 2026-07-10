// Server-only direct Anthropic (Claude API) access for AI Tools.
//
// Replaces the Vercel AI SDK's generic `Output.object()` wrapper layered on
// Lovable's AI gateway, whose structured-output mode failed unreliably across
// the whole AI Tools module ("No object generated: response did not match
// schema", or silent empty results). Structured output here uses the
// provider's native tool-use with a forced tool choice, which constrains the
// model to the JSON schema server-side.
//
// Every failure path throws AiGenerationError — a real failure must never be
// indistinguishable from a legitimately empty result.

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

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-5";

function model(): string {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type JsonSchema = Record<string, unknown>;

async function callAnthropic(label: string, body: Record<string, unknown>): Promise<any> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiGenerationError(label, "AI is not configured on this server (missing ANTHROPIC_API_KEY).");
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ model: model(), ...body }),
      });
    } catch (err) {
      lastErr = err; // network hiccup — retry
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Anthropic API returned ${res.status}`);
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[ai] ${label} request rejected`, res.status, detail.slice(0, 1000));
      throw new AiGenerationError(label, `The AI request was rejected (${res.status}).`);
    }
    return await res.json();
  }
  console.error(`[ai] ${label} unavailable after retries`, lastErr);
  throw new AiGenerationError(label, "The AI service is unavailable right now — try again in a minute.", lastErr);
}

/**
 * Generate a structured object matching `schema`, enforced natively by the
 * provider via a forced tool call (`jsonSchema` is the wire-format JSON
 * Schema for the same shape), then re-validated with zod before returning.
 * Throws AiGenerationError on any failure — never resolves to a silent
 * empty/void result.
 */
export async function generateStructured<T>(opts: {
  label: string;
  prompt: string;
  schema: z.ZodType<T>;
  jsonSchema: JsonSchema;
  maxTokens?: number;
}): Promise<T> {
  const data = await callAnthropic(opts.label, {
    max_tokens: opts.maxTokens ?? 4096,
    tools: [
      {
        name: "emit_result",
        description: "Emit the final structured result. Always call this exactly once.",
        input_schema: opts.jsonSchema,
      },
    ],
    tool_choice: { type: "tool", name: "emit_result" },
    messages: [{ role: "user", content: opts.prompt }],
  });

  if (data?.stop_reason === "max_tokens") {
    console.error(`[ai] ${opts.label} hit max_tokens — output truncated`);
    throw new AiGenerationError(opts.label, "The AI response was cut off before completing — try a smaller batch.");
  }

  const toolUse = (data?.content ?? []).find((b: any) => b?.type === "tool_use");
  if (!toolUse) {
    console.error(`[ai] ${opts.label} returned no tool_use block`, JSON.stringify(data?.content ?? []).slice(0, 1000));
    throw new AiGenerationError(opts.label, "The AI returned no structured result.");
  }

  const parsed = opts.schema.safeParse(toolUse.input);
  if (!parsed.success) {
    // Log the raw output so a schema/prompt mismatch is diagnosable from logs.
    console.error(
      `[ai] ${opts.label} schema validation failed`,
      JSON.stringify(parsed.error.issues).slice(0, 1000),
      JSON.stringify(toolUse.input).slice(0, 2000),
    );
    throw new AiGenerationError(opts.label, "The AI returned a result in an unexpected format.");
  }
  return parsed.data;
}

/** Generate plain prose. Throws AiGenerationError on failure or empty output. */
export async function generateAiText(opts: {
  label: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const data = await callAnthropic(opts.label, {
    max_tokens: opts.maxTokens ?? 2048,
    messages: [{ role: "user", content: opts.prompt }],
  });
  const text = (data?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new AiGenerationError(opts.label, "The AI returned an empty response.");
  }
  return text;
}
