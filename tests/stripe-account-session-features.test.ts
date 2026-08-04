// Stripe rejects the WHOLE AccountSession when any two components declare
// different values for a feature they have in common:
//
//   "The `features[capture_payments]` property specified by `payments` and
//    `payment_details` must be the same."
//   "The `features[capture_payments]` property specified by `payment_details`
//    and `disputes_list` must be the same."
//
// Two errors, one defect. The first fix read the first message as naming the
// two components involved and gave exactly those two a shared object — but the
// rule is not pairwise, it is over every component that accepts the feature.
// `disputes_list` was still bare, still taking Stripe's defaults, and the same
// bug simply reappeared under a different pair of names.
//
// So this file does NOT assert the current shape. Asserting the shape is what
// the last test did, and it passed while the session was broken. It derives
// the constraint from the Stripe SDK's own type definitions — the same source
// the API validates against — and checks our config satisfies it. Enable a new
// component that shares a feature, forget its features block, and this fails
// here rather than on the tenant's Payments screen.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

const SRC = readFileSync(join(root, "src/lib/stripe-connect.functions.ts"), "utf8");
/** The comments above quote the error being fixed, so they'd satisfy any
 *  match. They go before anything is read. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** snake_case component name → the features Stripe accepts on it.
 *
 *  Parsed out of `stripe/cjs/resources/AccountSessions.d.ts`, which ships with
 *  the pinned SDK. Reading the real types means the partition below can never
 *  drift from what the API enforces — an SDK bump that adds a feature to a
 *  component shows up here as a failure, which is the point. */
function featuresByComponent(): Map<string, Set<string>> {
  const dts = readFileSync(
    join(root, "node_modules/stripe/cjs/resources/AccountSessions.d.ts"),
    "utf8",
  );
  const out = new Map<string, Set<string>>();
  // `namespace Payments { interface Features { capture_payments?: boolean; … } }`
  const re = /namespace (\w+) \{\s*interface Features \{([\s\S]*?)\n\s{8}\}/g;
  for (const m of dts.matchAll(re)) {
    const snake = m[1].replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
    const keys = new Set([...m[2].matchAll(/^\s+([a-z_]+)\??:/gm)].map((k) => k[1]));
    // The file declares each namespace twice (response type, then params).
    // Union them; they agree on names and differ only in optionality.
    const prev = out.get(snake);
    if (prev) for (const k of keys) prev.add(k);
    else out.set(snake, keys);
  }
  return out;
}

/** The `components: { … }` we actually send, as component → declared features.
 *  A component with no features block maps to null, which is the defect: it
 *  means "whatever Stripe defaults to", and defaults are what disagreed. */
function declaredComponents(): Map<string, Set<string> | null> {
  const start = code.indexOf("components: {");
  expect(start).toBeGreaterThan(-1);
  const block = code.slice(start, code.indexOf("\n    });", start));

  // The two source objects, resolved so a spread can be expanded.
  const objects = new Map<string, Set<string>>();
  for (const m of block.matchAll(/const (\w+Features) = \{([\s\S]*?)\n\s+\} as const;/g)) {
    objects.set(m[1], new Set([...m[2].matchAll(/^\s+([a-z_]+):/gm)].map((k) => k[1])));
  }
  for (const m of code.matchAll(/const (\w+Features) = \{([\s\S]*?)\n\s+\} as const;/g)) {
    const keys = new Set([...m[2].matchAll(/^\s+([a-z_]+):/gm)].map((k) => k[1]));
    for (const s of m[2].matchAll(/\.\.\.(\w+Features)/g)) {
      for (const k of objects.get(s[1]) ?? []) keys.add(k);
    }
    objects.set(m[1], keys);
  }

  const out = new Map<string, Set<string> | null>();
  for (const m of block.matchAll(/^\s{8}([a-z_]+): \{ enabled: true(.*)$/gm)) {
    const rest = m[2];
    const spread = rest.match(/\.\.\.(\w+Features)/);
    if (!spread) {
      out.set(m[1], /features:/.test(rest) ? new Set() : null);
      continue;
    }
    out.set(m[1], objects.get(spread[1]) ?? new Set());
  }
  return out;
}

describe("no two components can disagree about a shared feature", () => {
  const accepted = featuresByComponent();
  const declared = declaredComponents();

  it("parsed both sides", () => {
    // A regex that silently matched nothing would make every assertion below
    // pass over an empty set. This is the control.
    expect(accepted.get("payments")).toContain("capture_payments");
    expect(accepted.get("payment_disputes")).not.toContain("capture_payments");
    expect(declared.size).toBeGreaterThanOrEqual(8);
    expect(declared.get("payment_details")).toContain("capture_payments");
  });

  it("declares each shared feature on every component that takes it, or none", () => {
    // The invariant, and it is all-or-none rather than always-declare.
    //
    // Declared everywhere → the values are ours and they match by construction.
    // Declared nowhere → every component takes the SAME Stripe default, since
    // defaults are a property of the connected account, so they agree too.
    //
    // Only the mixed case is a bug: one component states a value while another
    // silently takes a default that differs. That is what broke the dashboard
    // twice, and it is the only arrangement this rejects.
    const mixed: string[] = [];
    for (const feature of new Set([...accepted.values()].flatMap((s) => [...s]))) {
      const takesIt = [...declared.keys()].filter((c) => accepted.get(c)?.has(feature));
      if (takesIt.length < 2) continue; // nothing to disagree with
      const states = takesIt.filter((c) => declared.get(c)?.has(feature));
      if (states.length !== 0 && states.length !== takesIt.length) {
        const silent = takesIt.filter((c) => !states.includes(c));
        mixed.push(
          `${feature}: declared on ${states.join(", ")} but left to Stripe's default on ${silent.join(", ")}`,
        );
      }
    }
    expect(mixed).toEqual([]);
  });

  it("never sends a component a feature it does not accept", () => {
    // The other half, and its own error rather than a mismatch: this is why
    // `capture_payments` cannot simply go into one object for all four.
    const extras: string[] = [];
    for (const [component, ours] of declared) {
      const theirs = accepted.get(component);
      if (!ours || !theirs) continue;
      for (const f of ours) {
        if (!theirs.has(f)) extras.push(`${component}: ${f} is not a feature of this component`);
      }
    }
    expect(extras).toEqual([]);
  });

  it("keeps capture_payments off, on each component that has it", () => {
    // The product fact underneath: HoundStack creates and confirms a
    // PaymentIntent in one step, so there is nothing for a tenant to capture
    // by hand and the control would never apply.
    const shared = code.match(/const paymentFeatures = \{[\s\S]*?\} as const;/)?.[0] ?? "";
    expect(shared).toMatch(/capture_payments: false/);
    // Exactly one literal, or the two objects drift apart again.
    expect(code.match(/capture_payments:/g) ?? []).toHaveLength(1);
  });
});
