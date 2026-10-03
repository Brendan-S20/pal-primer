import { describe, expect, it } from "vitest";
import {
  AI_FEATURES,
  allowanceFraction,
  decideAiCall,
  estimateCostMicros,
  isBillableFeature,
  rateFamilyFor,
  shouldWarn,
  tokensFromAiSdkResult,
  tokensFromResponse,
  WARN_AT_FRACTION,
  type AiUsageState,
} from "@/lib/ai-usage";
import { DEFAULT_MODELS } from "@/lib/ai.server";

// BUILD-2. Every AI feature in this product runs on HoundStack's own API keys
// and nothing counted a single call — the receptionist answers inbound texts
// unattended, the digest fires from cron, and both spent our money with no
// record that they did.
//
// The SQL (20260801140000) owns where an org STANDS. These are the decisions
// made from that answer: whether a call proceeds, whether to warn, and what a
// call cost us.

const state = (o: Partial<AiUsageState> = {}): AiUsageState => ({
  periodMonth: "2026-08-01",
  actionsUsed: 0,
  actionsIncluded: 200,
  overageCentsPerAction: 10,
  hardCapActions: 600,
  overAllowance: false,
  overHardCap: false,
  overageCents: 0,
  ...o,
});

describe("the soft cap does not stop anything", () => {
  it("allows a call inside the allowance", () => {
    const d = decideAiCall(state({ actionsUsed: 50 }));
    expect(d.allow).toBe(true);
    expect(d.allow && d.overAllowance).toBe(false);
  });

  it("allows a call past the allowance, and says it was past it", () => {
    // The owner chose overage billing over refusal. A soft cap that blocked
    // would be a hard cap, and the flag is what makes an overage line on an
    // invoice traceable to the calls that caused it.
    const d = decideAiCall(state({ actionsUsed: 250, overAllowance: true }));
    expect(d.allow).toBe(true);
    expect(d.allow && d.overAllowance).toBe(true);
  });
});

describe("the hard ceiling does stop", () => {
  it("refuses once the month is at the ceiling", () => {
    const d = decideAiCall(state({ actionsUsed: 600, overAllowance: true, overHardCap: true }));
    expect(d.allow).toBe(false);
  });

  it("says which limit and both ways out", () => {
    // "Quota exceeded" sends a business owner to support. This is the message
    // shown to someone whose receptionist just stopped answering texts, so it
    // has to carry the number, the ceiling, and what they can do about it.
    const d = decideAiCall(state({ actionsUsed: 601, overHardCap: true, hardCapActions: 600 }));
    expect(d.allow).toBe(false);
    const reason = !d.allow ? d.reason : "";
    expect(reason).toContain("601");
    expect(reason).toContain("600");
    expect(reason).toMatch(/Settings/);
    expect(reason).toMatch(/next month/);
  });

  it("never refuses an unlimited plan", () => {
    // Enterprise is a negotiated contract. A hard-coded ceiling on it would
    // pause an account we contractually agreed not to.
    const d = decideAiCall(
      state({ actionsUsed: 1_000_000, actionsIncluded: null, hardCapActions: null }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("the 80% warning fires once", () => {
  it("does not warn below the threshold", () => {
    expect(shouldWarn(state({ actionsUsed: 159 }), false)).toBe(false);
  });

  it("warns on crossing", () => {
    expect(shouldWarn(state({ actionsUsed: 160 }), false)).toBe(true);
    expect(allowanceFraction(state({ actionsUsed: 160 }))).toBe(WARN_AT_FRACTION);
  });

  it("does not warn again once warned", () => {
    // Otherwise a business gets one alert per AI action for the rest of the
    // month, which is how a real warning ends up in a folder nobody reads.
    expect(shouldWarn(state({ actionsUsed: 500 }), true)).toBe(false);
  });

  it("has nothing to warn about on an unlimited plan", () => {
    expect(allowanceFraction(state({ actionsIncluded: null }))).toBeNull();
    expect(shouldWarn(state({ actionsUsed: 999_999, actionsIncluded: null }), false)).toBe(false);
  });

  it("does not divide by a zero allowance", () => {
    expect(allowanceFraction(state({ actionsIncluded: 0 }))).toBeNull();
    expect(shouldWarn(state({ actionsUsed: 5, actionsIncluded: 0 }), false)).toBe(false);
  });
});

describe("our own diagnostic is not billed to the customer", () => {
  it("exempts the connection test and nothing else", () => {
    expect(isBillableFeature("connection_test")).toBe(false);
    for (const f of AI_FEATURES) {
      if (f !== "connection_test") expect(isBillableFeature(f), f).toBe(true);
    }
  });
});

describe("what a call cost us", () => {
  it("prices a Sonnet call at roughly the published rate", () => {
    // 3,000 in at $2/M + 1,000 out at $10/M = $0.016 = 1,600,000 micros.
    expect(
      estimateCostMicros({ model: "claude-sonnet-5", inputTokens: 3000, outputTokens: 1000 }),
    ).toBe(1_600_000);
  });

  it("prices the default model, Haiku 4.5, at its published rate", () => {
    // The default since 2026-10-03 (ai.server.ts). $1/M in + $5/M out: 3,000
    // in and 1,000 out is $0.008 = 800,000 micros. Pinned against the default
    // itself, so a change of model that the rate table does not know about
    // fails here instead of being recorded as zero cost.
    expect(rateFamilyFor(DEFAULT_MODELS.anthropic)).toBe("claude-haiku");
    expect(
      estimateCostMicros({ model: DEFAULT_MODELS.anthropic, inputTokens: 3000, outputTokens: 1000 }),
    ).toBe(800_000);
  });

  it("matches a model family through its version and date suffixes", () => {
    // Model ids carry versions that change constantly; the family does not.
    expect(rateFamilyFor("claude-sonnet-5")).toBe("claude-sonnet");
    expect(rateFamilyFor("claude-3-5-haiku-20241022")).toBe("claude-haiku");
    expect(rateFamilyFor("claude-opus-4-1")).toBe("claude-opus");
    expect(rateFamilyFor("gpt-4o-2024-11-20")).toBe("gpt-4o");
    expect(rateFamilyFor("google/gemini-3-flash-preview")).toBe("gemini-flash");
  });

  it("records zero rather than a guess for a model it does not know", () => {
    // An invented cost that flatters or alarms us is worse than an honest gap,
    // and the token counts are stored raw so any figure can be recomputed.
    expect(rateFamilyFor("some-new-model-2029")).toBeNull();
    expect(
      estimateCostMicros({ model: "some-new-model-2029", inputTokens: 5000, outputTokens: 5000 }),
    ).toBe(0);
    expect(estimateCostMicros({ model: null, inputTokens: 100, outputTokens: 100 })).toBe(0);
  });

  it("does not go negative on nonsense counts", () => {
    expect(
      estimateCostMicros({ model: "claude-sonnet-5", inputTokens: -50, outputTokens: -50 }),
    ).toBe(0);
  });
});

describe("reading token counts off three providers that disagree", () => {
  it("reads Anthropic's shape", () => {
    expect(tokensFromResponse({ usage: { input_tokens: 120, output_tokens: 45 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it("reads OpenAI's shape", () => {
    expect(tokensFromResponse({ usage: { prompt_tokens: 120, completion_tokens: 45 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it("reads the AI SDK's shape", () => {
    expect(tokensFromResponse({ usage: { inputTokens: 120, outputTokens: 45 } })).toEqual({
      inputTokens: 120,
      outputTokens: 45,
    });
  });

  it("returns zero rather than throwing when a provider changes a field name", () => {
    // A meter that throws takes down the feature it meters. The ACTION is what
    // the customer is billed for; the tokens are our own telemetry.
    expect(tokensFromResponse({ usage: { something_else: 5 } })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(tokensFromResponse({})).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tokensFromResponse(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tokensFromResponse("not an object")).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("ignores a negative or non-numeric count", () => {
    expect(tokensFromResponse({ usage: { input_tokens: -5, output_tokens: "many" } })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("a multi-step conversation costs what all its steps cost", () => {
  it("sums usage across every step", () => {
    // The receptionist runs up to six model round-trips to answer one text.
    // Reporting only the last step would under-count our cost by most of it,
    // and that number is the whole evidence base for whether the $49/mo
    // receptionist add-on is priced right.
    const result = {
      usage: { inputTokens: 200, outputTokens: 20 },
      steps: [
        { usage: { inputTokens: 500, outputTokens: 40 } },
        { usage: { inputTokens: 700, outputTokens: 30 } },
        { usage: { inputTokens: 900, outputTokens: 60 } },
      ],
    };
    expect(tokensFromAiSdkResult(result)).toEqual({ inputTokens: 2100, outputTokens: 130 });
  });

  it("falls back to top-level usage when there are no steps", () => {
    expect(tokensFromAiSdkResult({ usage: { inputTokens: 10, outputTokens: 5 } })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(
      tokensFromAiSdkResult({ steps: [], usage: { inputTokens: 10, outputTokens: 5 } }),
    ).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("falls back when the steps carry no usage at all", () => {
    // The gateway is an OpenAI-compatible shim and may not populate per-step
    // usage. Summing to zero and reporting zero would silently lose the cost.
    expect(
      tokensFromAiSdkResult({ steps: [{}, {}], usage: { inputTokens: 80, outputTokens: 9 } }),
    ).toEqual({ inputTokens: 80, outputTokens: 9 });
  });

  it("survives a shape it has never seen", () => {
    expect(tokensFromAiSdkResult(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(tokensFromAiSdkResult({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
