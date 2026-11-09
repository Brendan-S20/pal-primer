// Onboarding audit, 2026-11-09, D2 (blocker).
//
// /clients/new let a residential client through the Dogs step on one blank
// row. The plan priced `Math.max(1, rows)` = 1 dog, only a NAMED row is saved
// as a dog, and so the first thing the new client's Summary said was:
//
//   "Services bill for 1 dog, but no dog is on file. Every screen counts 1
//    from the plan until the dogs are added on Properties."
//
// Fixed in three places, each held here:
//   1. the rule (lib/new-client-dogs): residential needs one named dog,
//      commercial / HOA may still skip;
//   2. the wizard: Continue on Dogs is refused with an inline alert (not a
//      toast), and Create client is refused while the rule fails, which
//      covers the groom path where Dogs is the last step and a restored draft
//      that opens on Plan;
//   3. the server: onboardClient refuses before anything is read or written.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  namedDogs,
  needsANamedDog,
  needsANamedDogMessage,
  SERVER_NEEDS_A_NAMED_DOG,
} from "@/lib/new-client-dogs";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const WIZARD = "src/routes/_authenticated/clients.new.tsx";

const blank = { name: "" };
const spaces = { name: "   " };
const bailey = { name: "Bailey" };

describe("the rule", () => {
  it("a residential client with no named dog cannot continue", () => {
    expect(needsANamedDog("residential", [])).toBe(true);
    expect(needsANamedDog("residential", [blank])).toBe(true);
    expect(needsANamedDog("residential", [spaces, blank])).toBe(true);
    expect(needsANamedDog("residential", undefined)).toBe(true);
  });
  it("one named dog is enough, even beside unnamed rows from a lead", () => {
    expect(needsANamedDog("residential", [bailey])).toBe(false);
    expect(needsANamedDog("residential", [blank, bailey, blank])).toBe(false);
    expect(namedDogs([blank, bailey, spaces])).toEqual([bailey]);
  });
  it("a commercial / HOA account may still skip the step", () => {
    expect(needsANamedDog("commercial", [])).toBe(false);
    expect(needsANamedDog("commercial", [blank])).toBe(false);
  });
  it("says what to do, in the step's own word", () => {
    expect(needsANamedDogMessage()).toMatch(/at least one dog's name/);
    expect(needsANamedDogMessage(true)).toMatch(/at least one pet's name/);
  });
});

describe("the inline message on the Dogs step", async () => {
  const { NeedsANamedDogAlert } = await import("@/components/NeedsANamedDogAlert");
  it("is an alert on the page, with the message, when the rule fails", () => {
    const html = renderToStaticMarkup(createElement(NeedsANamedDogAlert, { pets: false }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('id="needs-a-named-dog"');
    expect(html).toContain(needsANamedDogMessage(false).replace(/'/g, "&#x27;"));
  });
  it("says pet for a sitting business", () => {
    const html = renderToStaticMarkup(createElement(NeedsANamedDogAlert, { pets: true }));
    expect(html).toContain("pet&#x27;s name");
  });
});

describe("the wizard", () => {
  const src = read(WIZARD);
  const canNext = src.slice(
    src.indexOf("const canNext"),
    src.indexOf("})();", src.indexOf("const canNext")),
  );

  it("refuses Continue on Dogs for a residential client with no named dog", () => {
    // It used to be `if (current === "Dogs") return true;`.
    expect(canNext).not.toMatch(/current === "Dogs"\)\s*return true/);
    expect(canNext).toMatch(/current === "Dogs"\)\s*return !needsDog/);
    expect(src).toMatch(/const needsDog = needsANamedDog\(accountType, dogs\)/);
  });
  it("shows the inline alert on the Dogs step once Continue was pressed", () => {
    const dogsStep = src.slice(
      src.indexOf('{current === "Dogs" && ('),
      src.indexOf('{current === "Plan" && ('),
    );
    expect(dogsStep).toMatch(/attempted && needsDog && <NeedsANamedDogAlert/);
    expect(dogsStep).toMatch(/aria-invalid=\{attempted && needsDog/);
  });
  it("refuses Create client too, so no path reaches the server with no dog", () => {
    // Create sends the owner back to Dogs with the alert, rather than going
    // grey: on a groom lead Dogs is the last step, and a greyed button there
    // could never show why.
    const nav = src.slice(src.indexOf("{/* Nav */}"));
    const create = nav.slice(nav.indexOf('<div className="flex flex-col items-end'));
    expect(create).toMatch(
      /if \(needsDog\) \{\s*setAttempted\(true\);\s*setStep\(steps\.indexOf\("Dogs"\)\);\s*return;\s*\}\s*mutation\.mutate\(\);/,
    );
  });
  it("no longer tells a residential owner the dogs can all wait", () => {
    expect(src).not.toMatch(/Name them now\s+or later/);
  });
});

// ── The server ──────────────────────────────────────────────────────────────
const touched = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b = {
      middleware: () => b,
      inputValidator: (fn: typeof validate) => ((validate = fn), b),
      handler:
        (fn: (a: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({
            data: validate(args?.data),
            context: {
              userId: "user-1",
              supabase: {
                from(table: string) {
                  touched.calls.push(`from:${table}`);
                  throw new Error("reached the database");
                },
                rpc(name: string) {
                  touched.calls.push(`rpc:${name}`);
                  throw new Error("reached the database");
                },
              },
            },
          }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      touched.calls.push(`admin:${table}`);
      throw new Error("reached the database");
    },
  },
}));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => {
    touched.calls.push("resolveCaller");
    throw new Error("reached the database");
  },
  requirePermission: async () => {
    touched.calls.push("requirePermission");
    throw new Error("reached the database");
  },
}));

describe("the server", async () => {
  const { onboardClient } = await import("@/lib/clients.functions");
  const call = (data: unknown) =>
    (onboardClient as unknown as (a: { data: unknown }) => Promise<unknown>)({ data });
  const base = {
    displayName: "Jane Doe",
    street: "1 Main St",
    city: "Detroit",
    region: "MI",
    postalCode: "48201",
    subscription: { frequency: "weekly", priceCents: 4000, dogCount: 1 },
  };

  it("refuses a residential client with no dog before touching the database", async () => {
    touched.calls = [];
    await expect(call({ ...base, accountType: "residential" })).rejects.toThrow(
      SERVER_NEEDS_A_NAMED_DOG,
    );
    await expect(call({ ...base, accountType: "residential", dogs: [] })).rejects.toThrow(
      SERVER_NEEDS_A_NAMED_DOG,
    );
    await expect(
      call({ ...base, accountType: "residential", dogs: [{ name: "  " }] }),
    ).rejects.toThrow(SERVER_NEEDS_A_NAMED_DOG);
    expect(touched.calls).toEqual([]);
  });
  it("lets a residential client with a named dog through to the database", async () => {
    touched.calls = [];
    await expect(
      call({ ...base, accountType: "residential", dogs: [{ name: "Bailey" }] }),
    ).rejects.toThrow("reached the database");
    expect(touched.calls.length).toBeGreaterThan(0);
  });
  it("lets a commercial / HOA client with no dog through to the database", async () => {
    touched.calls = [];
    await expect(
      call({
        ...base,
        accountType: "commercial",
        subscription: { frequency: "weekly", priceCents: 4000, unitCount: 1 },
      }),
    ).rejects.toThrow("reached the database");
    expect(touched.calls.length).toBeGreaterThan(0);
  });
});
