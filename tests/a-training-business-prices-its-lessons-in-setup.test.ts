// Signup seeds a training business's 6-session package inactive at $0, and
// nothing told the owner to price it, so no client could ever be sold one
// (product review of #476, "no setup step for training"). The guided setup is
// capped at six steps (tests/every-setup-step-has-somewhere-to-go.test.ts), so
// rather than a seventh, the price step asks a training business for its
// lesson price and skill list as well, the way the day's-end step already
// asks a business without pet waste a different question.

import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return { createServerFn: () => builder, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { loadOnboardingStatus, type OnboardingStep } from "@/lib/onboarding.functions";

type Counts = Record<string, number>;

function context(lines: string[], counts: Counts) {
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      for (const m of ["eq", "gt", "not"]) q[m] = () => q;
      q.select = (c: string) => {
        cols = c;
        return q;
      };
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: "org-a" } };
        if (table === "organizations")
          return cols === "service_lines"
            ? { data: { service_lines: lines } }
            : { data: { contact_address: "1 Main St" } };
        return { count: counts[table] ?? 0 };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
  return { supabase, userId: "owner" } as never;
}

async function priceStep(lines: string[], counts: Counts): Promise<OnboardingStep> {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[] }>;
  const { steps } = await load(context(lines, counts));
  return steps.find((s) => s.id === "zones")!;
}

describe("the price step at a training business", () => {
  it("stays open until the lesson package is priced and a skill exists", async () => {
    const step = await priceStep(["training"], { zones: 1 });
    expect(step.done).toBe(false);
    expect(step.training).toEqual({ areaDone: true, done: false });
    expect(step.alt).toEqual({
      to: "/settings/services",
      cta: "Price lessons",
      gate: "/settings/services",
    });
    expect(step.description).toMatch(/lesson package/);
  });

  it("is done when the area, a priced package and a skill all exist", async () => {
    const step = await priceStep(["training"], {
      zones: 1,
      service_packages: 1,
      training_skills: 5,
    });
    expect(step.done).toBe(true);
  });

  it("is unchanged for a business that does not run training", async () => {
    const step = await priceStep(["pet_waste"], { zones: 1 });
    expect(step.done).toBe(true);
    expect(step.training).toBeUndefined();
    expect(step.alt).toBeUndefined();
    expect(step.description).not.toMatch(/lesson/);
  });
});
