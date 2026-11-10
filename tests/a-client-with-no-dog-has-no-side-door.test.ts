// #828. #779 made "a residential client needs at least one named dog" a rule,
// and onboardClient enforces it before anything is read or written. The older
// `createClient` server function in the same file did not. Nothing in the app
// called it, but a server function is an HTTP endpoint whether or not a
// screen calls it, so a residential client with no dog was one POST away.
//
// It was retired rather than patched: it had no caller, and a second insert
// path that has to be kept in step with the first is exactly the drift that
// produced the gap. These pins keep it retired and keep the one remaining
// path in clients.functions.ts behind the rule.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("src/lib/clients.functions.ts");

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

describe("the legacy createClient server function is gone (#828)", () => {
  it("is not declared in clients.functions.ts", () => {
    expect(source).not.toMatch(/\bcreateClient\s*=\s*createServerFn\b/);
    expect(source).not.toMatch(/\bcreateClientSchema\b/);
  });

  it("is not exported by the module", async () => {
    const mod = (await import("@/lib/clients.functions")) as Record<string, unknown>;
    expect(mod.createClient).toBeUndefined();
    expect(typeof mod.onboardClient).toBe("function");
  });
});

describe("every client insert in clients.functions.ts is behind the named-dog rule", () => {
  // Split the file at each server function, so an insert is attributed to the
  // handler it sits in rather than to the file as a whole.
  const handlers = source
    .split(/(?=^export const \w+ = createServerFn\b)/m)
    .filter((chunk) => /^export const \w+ = createServerFn\b/.test(chunk));

  const insertsAClient = (chunk: string) => /\.from\("clients"\)\s*\.insert\(/.test(chunk);

  it("finds at least the onboardClient insert (so the scan is measuring something)", () => {
    const names = handlers
      .filter(insertsAClient)
      .map((chunk) => /^export const (\w+)/.exec(chunk)![1]);
    expect(names).toContain("onboardClient");
  });

  it("refuses with needsANamedDog before the insert, in each of them", () => {
    const unguarded = handlers.filter(insertsAClient).flatMap((chunk) => {
      const name = /^export const (\w+)/.exec(chunk)![1];
      const guard = chunk.search(/needsANamedDog\(/);
      const insert = chunk.search(/\.from\("clients"\)\s*\.insert\(/);
      return guard >= 0 && guard < insert ? [] : [name];
    });
    expect(unguarded).toEqual([]);
  });
});
