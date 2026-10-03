import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_FEATURES } from "@/lib/ai-usage";

// BUILD-2, the wiring half — the same class of test as
// tests/the-wiring-is-connected.ts, and for the same reason.
//
// v1.14 found EIGHT protections that could be switched off with the suite at
// 752 green, because every test exercised the rule and none checked the rule
// was attached to anything. A meter has that shape exactly: `recordAiUsage`
// can be perfectly correct and perfectly unreachable, and the symptom is a
// bill that never arrives and spend nobody sees.
//
// The specific failure this file exists to catch is the SEVENTH AI feature.
// There are three ways into the model and someone adding a fourth will not
// read this comment — but they will run the suite.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are not code — a rule this repo has had to learn three times. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

/**
 * A function's whole body, by counting brackets.
 *
 * Two wrong versions were written before this one, and both are worth naming
 * because both fail SILENTLY:
 *
 *   1. `/function name\([\s\S]*?\n\}/` — the non-greedy match stops at the
 *      first line starting with `}`, which in this codebase is usually a
 *      nested object literal a few lines in;
 *   2. counting braces from the first `{` after the name — that brace belongs
 *      to the PARAMETER object type (`recordAiUsage(opts: { ... })`), so the
 *      "body" returned is the argument list.
 *
 * Both return a fragment, and an assertion against a fragment passes or fails
 * for reasons unrelated to the function. Here it produced a false failure,
 * which is the lucky outcome — a false PASS is the one that ships.
 *
 * So: skip the parameter list by counting parens, then count braces from the
 * `{` that follows it.
 */
/** The object literal passed to a call: `fn({ ... })`.
 *
 *  A DIFFERENT shape from a declaration, and it needs a different rule —
 *  `bodyOf` would skip past this object looking for a body that does not
 *  exist, and land on whatever block came next. It did exactly that, and the
 *  assertion still passed, which is the failure mode this whole file is about.
 */
function callObjectOf(src: string, call: RegExp): string {
  const m = call.exec(src);
  if (!m) return "";
  const start = src.indexOf("{", m.index);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return "";
}

function bodyOf(src: string, decl: RegExp): string {
  const m = decl.exec(src);
  if (!m) return "";
  const open = src.indexOf("(", m.index);
  if (open < 0) return "";
  let parens = 0;
  let afterParams = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")") {
      parens--;
      if (parens === 0) {
        afterParams = i + 1;
        break;
      }
    }
  }
  if (afterParams < 0) return "";
  const start = src.indexOf("{", afterParams);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return "";
}

describe("every door into the model is metered", () => {
  it("Path A meters inside callProvider, not in its callers", () => {
    // Both public entry points go through callProvider, and it is the only
    // place the full response body — and therefore the token counts — exists.
    // A meter attached to the two callers is a meter the third caller forgets.
    const src = code(read("src/lib/ai.server.ts"));
    const fn = bodyOf(src, /async function callProvider\(/);
    expect(fn, "callProvider not found").not.toBe("");
    expect(fn, "the response is returned without being metered").toMatch(
      /meter\(meterOpts, config/,
    );
    // After the ok-check, so a rejected request bills nothing.
    expect(fn.indexOf("meter(meterOpts")).toBeGreaterThan(fn.indexOf("if (!res.ok)"));
  });

  it("both Path A entry points accept and forward a meter", () => {
    const src = code(read("src/lib/ai.server.ts"));
    expect((src.match(/meter\?: AiMeter/g) ?? []).length).toBe(2);
    // EVERY callProvider call site forwards it — four of them: two entry
    // points × two provider branches. Counting both sides rather than
    // pattern-matching the call: an earlier version asserted the single-line
    // shape `}, opts.meter)` and broke the moment prettier wrapped the
    // arguments, which is a test that tracks formatting instead of behaviour.
    const callSites = (src.match(/await callProvider\(/g) ?? []).length;
    const forwarded = (src.match(/opts\.meter/g) ?? []).length;
    expect(callSites).toBe(4);
    expect(forwarded, "a callProvider call does not forward the meter").toBe(callSites);
  });

  it("the Lovable gateway paths record their own usage", () => {
    // These do NOT go through ai.server.ts — they call the Vercel AI SDK
    // directly. The whole reason ai-access.server.ts exists is that gating
    // only the resolver left these two doors open, and they are the unattended
    // ones: cron and an inbound text.
    for (const f of ["src/lib/digest.server.ts", "src/lib/ai-receptionist.server.ts"]) {
      const src = code(read(f));
      expect(src, `${f} calls the model without recording usage`).toMatch(/recordAiUsage\(/);
      expect(src, `${f} does not sum usage across steps`).toMatch(/tokensFromAiSdkResult\(/);
    }
  });

  it("the receptionist bills one action for a whole conversation", () => {
    // It runs up to six model steps per inbound text. Six actions for one
    // text is not a line anyone can defend on an invoice — and the tokens are
    // still summed across all six, which is what tells us our real cost.
    const src = code(read("src/lib/ai-receptionist.server.ts"));
    const call = callObjectOf(src, /recordAiUsage\(/);
    expect(call, "recordAiUsage call not found").not.toBe("");
    expect(call).toMatch(/feature: "ai_receptionist"/);
    expect(call, "an explicit per-step action count would over-bill").not.toMatch(/actions:/);
  });

  it("every tenant-facing AI tool passes a feature name", () => {
    // resolveOrgAiCall resolves the config and the metering context together.
    // Resolving them separately means a second read, a different answer, and
    // an overage line nobody can reconcile to the calls behind it.
    const src = code(read("src/lib/ai-tools.functions.ts"));
    const calls = src.match(/resolveOrgAiCall\(staff\.organization_id, "([a-z_]+)"\)/g) ?? [];
    expect(calls.length, "an AI tool resolved its config without a meter").toBe(6);
    expect(src, "the unmetered resolver is still in use here").not.toMatch(/resolveOrgAiConfig\(/);
  });

  it("names only features the closed set knows about", () => {
    // A typo'd feature slug is a usage row that never appears in a breakdown
    // and a label that renders as a raw identifier on a billing screen.
    const sources = [
      "src/lib/ai-tools.functions.ts",
      "src/lib/ai-settings.functions.ts",
      "src/lib/ai-receptionist.server.ts",
      "src/lib/advisor.functions.ts",
      "src/lib/digest.server.ts",
    ];
    const named = new Set<string>();
    for (const f of sources) {
      for (const m of code(read(f)).matchAll(/feature(?::| =) "([a-z_]+)"/g)) named.add(m[1]);
      for (const m of code(read(f)).matchAll(/resolveOrgAiCall\([^,]+, "([a-z_]+)"\)/g))
        named.add(m[1]);
      for (const m of code(read(f)).matchAll(/generateDigestInsights\([^,)]+, "([a-z_]+)"\)/g))
        named.add(m[1]);
    }
    expect(named.size).toBeGreaterThan(0);
    for (const n of named) {
      expect(AI_FEATURES as readonly string[], `unknown feature "${n}"`).toContain(n);
    }
  });

  it("the digest and the advisor are told apart", () => {
    // One analysis engine, two callers, and only one of them was asked for:
    // the weekly digest fires from cron. An owner reading "what used my
    // allowance" needs those separated or the answer is useless.
    expect(code(read("src/lib/advisor.functions.ts"))).toMatch(
      /generateDigestInsights\(metrics, "business_advisor"\)/,
    );
    // The cron email carries its OWN label since 2026-09-20: the dashboard's
    // digest panel (ai-tools.functions.ts) also logged "weekly_digest", so the
    // breakdown could not say which of the TWO digests spent what. Three
    // callers, three labels — this pin holds the email one.
    expect(code(read("src/lib/digest.server.ts"))).toMatch(
      /AiFeature = "weekly_digest_email"/,
    );
  });
});

describe("the ceiling is on the path every door already used", () => {
  it("requireAiAccess and orgMayUseAi both go through the budget check", () => {
    // These two functions are what the three doors already called. Routing the
    // budget through them is what puts the ceiling on all three without asking
    // any call site to remember it.
    const src = code(read("src/lib/ai-access.server.ts"));
    const req = bodyOf(src, /export async function requireAiAccess/);
    const may = bodyOf(src, /export async function orgMayUseAi/);
    expect(req).toMatch(/clearAiCall\(/);
    expect(may).toMatch(/clearAiCall\(/);
    expect(src).toMatch(/checkAiBudget/);
  });

  it("the budget is never served from the plan cache", () => {
    // checkAiAccess caches for 60 seconds. Usage changes with every call, and
    // 60 seconds of an automated loop past the ceiling is precisely the spend
    // the ceiling exists to stop.
    const src = code(read("src/lib/ai-access.server.ts"));
    const clear = bodyOf(src, /export async function clearAiCall/);
    expect(clear, "clearAiCall not found").not.toBe("");
    expect(clear, "the budget was folded into the cached decision").not.toMatch(/CACHE\./);
    // The budget module must not have grown a cache of its own either.
    // `\b` rather than `\(` — a typed cache is written `new Map<string, X>()`,
    // and the paren-anchored version of this assertion did not match it. The
    // mutation sweep caught that; a reader would not have.
    const budget = code(read("src/lib/ai-usage.server.ts"));
    expect(budget, "the budget check grew a cache").not.toMatch(/new Map\b|TTL_MS|CACHE/);
  });

  it("the tenant-facing resolver enforces the budget, not just the plan", () => {
    const src = code(read("src/lib/ai-credentials.server.ts"));
    expect(src, "still gating on the plan alone").not.toMatch(/checkAiAccess\(/);
    expect(src).toMatch(/clearAiCall\(/);
  });
});

describe("the meter cannot break the feature it meters", () => {
  it("recordAiUsage swallows its own failures", () => {
    // The model call already happened and the money is already spent, so a
    // throw here loses the customer's result AND the record of the cost.
    const src = code(read("src/lib/ai-usage.server.ts"));
    const fn = bodyOf(src, /export async function recordAiUsage\(/);
    expect(fn, "recordAiUsage not found").not.toBe("");
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch/);
    expect(fn, "a metering failure would surface as a feature failure").not.toMatch(/throw /);
  });

  it("the budget check fails open, unlike the plan check", () => {
    // The asymmetry is deliberate and is stated in both places. The plan check
    // fails closed because a lookup error there could grant AI to someone who
    // has not paid; here the org is already eligible, and refusing a paying
    // customer because a counter did not load turns our outage into theirs.
    const src = code(read("src/lib/ai-usage.server.ts"));
    const fn = bodyOf(src, /export async function checkAiBudget\(/);
    expect(fn, "checkAiBudget not found").not.toBe("");
    expect(fn).toMatch(/if \(!state\) return \{ allowed: true/);
  });

  it("the meter finishes before the response does", () => {
    // This was the opposite rule until 2026-10-03: fire-and-forget at all
    // three sites, so the customer never waited on a database write. But the
    // app runs on Cloudflare Workers, where a promise still pending when the
    // response is returned may be cancelled, and this row is what the hard
    // cap counts and what the overage invoice bills. A dropped row is free AI
    // and a cap that does not hold. One insert after seconds of model time is
    // the cheaper side of that trade.
    for (const f of [
      "src/lib/ai.server.ts",
      "src/lib/digest.server.ts",
      "src/lib/ai-receptionist.server.ts",
    ]) {
      const src = code(read(f));
      expect(src, `${f} meters fire-and-forget again`).not.toMatch(/void \(async \(\)/);
      expect(src, `${f} no longer meters at all`).toMatch(/await \(async \(\)/);
    }
    expect(code(read("src/lib/ai.server.ts"))).toMatch(/await meter\(/);
  });
});

describe("the page tells the truth about itself", () => {
  it("no longer says metering is unavailable", () => {
    // This string was accurate for as long as there was nothing behind it, and
    // becomes the thing this ledger keeps finding — a written claim treated as
    // a fact — the moment it is not updated.
    const src = read("src/lib/ai-settings.functions.ts");
    expect(src).toMatch(/meteringAvailable: true/);
    const page = read("src/routes/_authenticated/settings.ai.tsx");
    expect(page, "the 'arrives with billing metering' copy is still shipping").not.toMatch(
      /arrives with billing metering/,
    );
    expect(page).toMatch(/AiUsageMeter/);
  });

  it("the advisor's allowance claim is now true", () => {
    // BusinessAdvisor.tsx has said "Uses part of your plan's AI allowance"
    // since before an allowance existed. It stays only because BUILD-2 made it
    // accurate — and it is asserted here so it cannot outlive the meter.
    expect(read("src/components/BusinessAdvisor.tsx")).toMatch(/AI allowance/);
    expect(read("src/lib/advisor.functions.ts")).toMatch(/business_advisor/);
  });
});
