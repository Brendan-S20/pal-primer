import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AiGenerationError,
  generateAiText,
  generateStructured,
  type AiConfig,
} from "@/lib/ai.server";

const SCHEMA = z.object({ reply: z.string(), notes: z.string() });
const JSON_SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" }, notes: { type: "string" } },
  required: ["reply", "notes"],
};

const ANTHROPIC: AiConfig = {
  provider: "anthropic",
  apiKey: "sk-ant-test",
  model: "claude-sonnet-5",
};
const OPENAI: AiConfig = { provider: "openai", apiKey: "sk-openai-test", model: "gpt-4o" };

function structuredOpts(overrides: Partial<Parameters<typeof generateStructured>[0]> = {}) {
  return {
    config: ANTHROPIC as AiConfig | null,
    label: "Test tool",
    prompt: "do the thing",
    schema: SCHEMA,
    jsonSchema: JSON_SCHEMA,
    ...overrides,
  };
}

function apiResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const anthropicOk = () =>
  apiResponse({
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", name: "emit_result", input: { reply: "Thanks!", notes: "none" } },
    ],
  });

const openaiOk = () =>
  apiResponse({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              function: {
                name: "emit_result",
                arguments: JSON.stringify({ reply: "Hi", notes: "none" }),
              },
            },
          ],
        },
      },
    ],
  });

describe("generateStructured — Anthropic", () => {
  it("returns the validated tool_use payload and forces the tool", async () => {
    fetchMock.mockResolvedValueOnce(anthropicOk());
    const out = await generateStructured(structuredOpts());
    expect(out).toEqual({ reply: "Thanks!", notes: "none" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("api.anthropic.com");
    const body = JSON.parse((init as any).body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_result" });
    expect((init as any).headers["x-api-key"]).toBe("sk-ant-test");
  });

  it("throws a typed error (never a silent empty) on schema mismatch", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "emit_result", input: { reply: 42 } }],
      }),
    );
    await expect(generateStructured(structuredOpts())).rejects.toThrow(AiGenerationError);
  });

  it("throws on truncation at max_tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        stop_reason: "max_tokens",
        content: [{ type: "tool_use", name: "emit_result", input: {} }],
      }),
    );
    await expect(generateStructured(structuredOpts())).rejects.toThrow(/cut off/i);
  });
});

describe("generateStructured — OpenAI", () => {
  it("uses OpenAI function-calling and parses the arguments", async () => {
    fetchMock.mockResolvedValueOnce(openaiOk());
    const out = await generateStructured(structuredOpts({ config: OPENAI }));
    expect(out).toEqual({ reply: "Hi", notes: "none" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("api.openai.com");
    const body = JSON.parse((init as any).body);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "emit_result" } });
    expect((init as any).headers.authorization).toBe("Bearer sk-openai-test");
  });

  it("throws a typed error when OpenAI returns no function call", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({ choices: [{ finish_reason: "stop", message: { content: "nope" } }] }),
    );
    await expect(generateStructured(structuredOpts({ config: OPENAI }))).rejects.toThrow(
      /no structured result/i,
    );
  });
});

describe("generateStructured — shared behavior", () => {
  it("blames us, not the tenant, when no config is provided", async () => {
    // This asserted /Settings → AI/ — a field IMP-9 deleted along with BYOK, so
    // the message sent people looking for a setting that no longer exists. The
    // only way to reach this now is a deployment with no platform key, which is
    // ours to fix; a refusal on plan grounds throws its own reason earlier, in
    // resolveOrgAiConfig.
    await expect(generateStructured(structuredOpts({ config: null }))).rejects.toThrow(
      /temporarily unavailable on HoundStack's side/i,
    );
    await expect(generateStructured(structuredOpts({ config: null }))).rejects.toThrow(
      /nothing is wrong with your account/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a 401 as ours to fix, not a key the tenant should go and find", async () => {
    // The hint used to say "check your API key in Settings → AI". That field
    // was deleted with BYOK, so it sent people looking for nothing.
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    await expect(generateStructured(structuredOpts())).rejects.toThrow(
      /HoundStack configuration issue/i,
    );
  });

  it("retries transient 5xx then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(anthropicOk());
    const out = await generateStructured(structuredOpts());
    expect(out.reply).toBe("Thanks!");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15_000);
});

describe("generateAiText", () => {
  it("returns Anthropic text", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse({ content: [{ type: "text", text: "Digest." }] }));
    await expect(generateAiText({ config: ANTHROPIC, label: "Digest", prompt: "p" })).resolves.toBe(
      "Digest.",
    );
  });

  it("returns OpenAI text", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({ choices: [{ message: { content: "Digest." } }] }),
    );
    await expect(generateAiText({ config: OPENAI, label: "Digest", prompt: "p" })).resolves.toBe(
      "Digest.",
    );
  });

  it("throws on empty output instead of returning nothing", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse({ content: [] }));
    await expect(
      generateAiText({ config: ANTHROPIC, label: "Digest", prompt: "p" }),
    ).rejects.toThrow(AiGenerationError);
  });
});
