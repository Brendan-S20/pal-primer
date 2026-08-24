// The SaaS purchase UI is aliased out of the native build. This keeps the stub
// honest.
//
// ── THE HAZARD THIS GUARDS ────────────────────────────────────────────────
//
// vite.config.ts resolves `@/components/billing/PlanPicker` to
// `PlanPicker.native-stub.tsx` in a NATIVE_BUILD, so the plan cards and the
// inline subscription checkout are absent from the artifact rather than merely
// unreachable in it. Verified by build: `stripeAppearance`, which appears only
// in the real module, is in 0 chunks of dist-native.
//
// But `tsc` follows tsconfig paths, not vite aliases, so it type-checks the
// REAL module against every call site and never checks the stub against them.
// If the real component gains an export, or a prop the routes start passing,
// the stub can silently stop matching and the native build breaks — or worse,
// builds and renders wrong. Nothing else in the repo would notice.
//
// So: same exports, both directions.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const REAL = resolve(ROOT, "src/components/billing/PlanPicker.tsx");
const STUB = resolve(ROOT, "src/components/billing/PlanPicker.native-stub.tsx");

/** Every `export function|const|type` name in a module. */
function exportsOf(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/^export (?:function|const|type) (\w+)/gm)]
    .map((m) => m[1])
    .sort();
}

describe("the native stub matches the module it replaces", () => {
  it("both files exist", () => {
    expect(existsSync(REAL), "the real PlanPicker is gone").toBe(true);
    expect(existsSync(STUB), "the native stub is gone but the alias still points at it").toBe(true);
  });

  it("exports exactly the same names", () => {
    const real = exportsOf(REAL);
    const stub = exportsOf(STUB);
    expect(real.length, "no exports parsed from the real module — the parse has drifted")
      .toBeGreaterThan(2);
    expect(
      stub,
      "the stub and the real module disagree. tsc checks the real one against every " +
        "call site and never checks the stub, so this is the only thing that would notice.",
    ).toEqual(real);
  });

  it("is still wired into the native build", () => {
    const vite = readFileSync(resolve(ROOT, "vite.config.ts"), "utf8");
    expect(vite).toMatch(/PlanPicker\.native-stub/);
    // Inside the NATIVE_BUILD branch, not applied unconditionally — the hosted
    // app must keep its real purchase flow.
    const at = vite.indexOf("PlanPicker.native-stub");
    const before = vite.slice(Math.max(0, at - 400), at);
    expect(before, "the alias is not scoped to NATIVE_BUILD").toMatch(/NATIVE_BUILD/);
  });

  it("renders the same note the runtime gate uses", () => {
    // Two ways of saying the same thing would drift. The stub imports the
    // constant rather than repeating the sentence.
    expect(readFileSync(STUB, "utf8")).toMatch(/BILLING_MANAGED_OUTSIDE_APP/);
  });
});
