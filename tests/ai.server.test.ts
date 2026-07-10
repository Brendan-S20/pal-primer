import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiGenerationError, generateAiText, generateStructured } from "@/lib/ai.server";

const SCHEMA = z.object({ reply: z.string(), notes: z.string() });
const JSON_SCHEMA = {
  type: "object",
  properties: { reply: { type: "string" }, notes: { type: "string" } },
  required: ["reply", "notes"],
};

function structuredOpts(overrides: Partial<Parameters<typeof generateStructured>[0]> = {}) {
  return {
    label: "Test tool",
    prompt: "do the thing",
    schema: SCHEMA,
    jsonSchema: JSON_SCHEMA,
    ...overrides,
  };
}

function apiResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("generateStructured", () => {
  it("returns the validated tool_use payload on success", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "emit_result", input: { reply: "Thanks!", notes: "none" } }],
      }),
    );
    const out = await generateStructured(structuredOpts());
    expect(out).toEqual({ reply: "Thanks!", notes: "none" });

    // The request must force the structured-output tool natively.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_result" });
    expect(body.tools[0].input_schema).toEqual(JSON_SCHEMA);
  });

  it("throws a typed error (never a silent empty) when the payload fails schema validation", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "emit_result", input: { reply: 42 } }],
      }),
    );
    await expect(generateStructured(structuredOpts())).rejects.toThrow(AiGenerationError);
  });

  it("throws a typed error when no tool_use block comes back", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "sorry, no" }] }),
    );
    await expect(generateStructured(structuredOpts())).rejects.toThrow(/no structured result/i);
  });

  it("throws a typed error when output is truncated at max_tokens", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({ stop_reason: "max_tokens", content: [{ type: "tool_use", name: "emit_result", input: {} }] }),
    );
    await expect(generateStructured(structuredOpts())).rejects.toThrow(/cut off/i);
  });

  it("throws a typed error on a non-retryable API rejection (4xx)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(generateStructured(structuredOpts())).rejects.toThrow(/rejected \(400\)/i);
  });

  it("retries transient 5xx errors and succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("overloaded", { status: 529 }))
      .mockResolvedValueOnce(
        apiResponse({
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "emit_result", input: { reply: "ok", notes: "none" } }],
        }),
      );
    const out = await generateStructured(structuredOpts());
    expect(out.reply).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("throws a typed error when the API key is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(generateStructured(structuredOpts())).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generateAiText", () => {
  it("returns joined text content", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "Weekly digest here." }] }),
    );
    await expect(generateAiText({ label: "Digest", prompt: "p" })).resolves.toBe("Weekly digest here.");
  });

  it("throws a typed error on empty output instead of returning nothing", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse({ stop_reason: "end_turn", content: [] }));
    await expect(generateAiText({ label: "Digest", prompt: "p" })).rejects.toThrow(AiGenerationError);
  });
});
