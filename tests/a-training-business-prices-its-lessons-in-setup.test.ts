// Signup seeds a training business's 6-session package inactive at $0, and
// nothing told the owner to price it, so no client could ever be sold one
// (product review of #476, "no setup step for training"). The guided setup is
// capped at six steps (tests/every-setup-step-has-somewhere-to-go.test.ts), so
// rather than a seventh, the price step asks a training business for its
// lesson price and skill list as well, the way the day's-end step already
// asks a business without pet waste a different question.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// R2-47 (round-2 audit, train-r2-06): the step a trainer read was the
// pet-waste area form ("How far you drive / Price per visit / Each extra
// dog"), and it was done only when the area AND the lessons were, so a saved
// area left "1 of 6 done" with nothing saying why. A trainer's step is now
// the lessons alone, on Settings, Services, the way a walker's is the walks.
describe("the price step at a training business", () => {
  it("is the lessons, on Settings, Services", async () => {
    const step = await priceStep(["training"], {});
    expect(step.label).toBe("Price your lessons");
    expect(step.to).toBe("/settings/services");
    expect(step.gate).toBe("/settings/services");
    expect(step.cta).toBe("Price lessons");
    expect(step.description).toMatch(/lesson package/);
    expect(step.description).not.toMatch(/per visit/);
    expect(step.alt).toBeUndefined();
    expect(step.parts).toBeUndefined();
  });

  it("stays open until the lesson package is priced and a skill exists, area or not", async () => {
    expect((await priceStep(["training"], { zones: 1 })).done).toBe(false);
    expect((await priceStep(["training"], { service_packages: 1 })).done).toBe(false);
  });

  it("is done when a priced package and a skill exist, with no area asked for", async () => {
    const step = await priceStep(["training"], { service_packages: 1, training_skills: 5 });
    expect(step.done).toBe(true);
  });

  it("with another line, asks no area unless the business scoops", async () => {
    const walkTrain = await priceStep(["dog_walking", "training"], {});
    expect(walkTrain.parts?.map((p) => p.id)).toEqual(["walks", "lessons"]);
    const wasteTrain = await priceStep(["pet_waste", "training"], {});
    expect(wasteTrain.parts?.map((p) => p.id)).toEqual(["area", "lessons"]);
  });

  it("is unchanged for a business that does not run training", async () => {
    const step = await priceStep(["pet_waste"], { zones: 1 });
    expect(step.done).toBe(true);
    expect(step.alt).toBeUndefined();
    expect(step.description).not.toMatch(/lesson/);
  });
});

describe("pricing elsewhere ticks the checklist without waiting for its cache", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("Services, packages, skills and a saved zone each refresh it", () => {
    for (const f of [
      "src/routes/_authenticated/settings.services.tsx",
      "src/components/settings/TrainingPackagesCard.tsx",
      "src/components/settings/TrainingSkillsCard.tsx",
      "src/components/ZoneDrawer.tsx",
    ]) {
      expect(read(f), f).toMatch(/invalidateQueries\(\{ queryKey: \["onboarding-status"\] \}\)/);
    }
  });

  it("setup draws no area form for a trainer", () => {
    const setup = read("src/routes/_authenticated/setup.tsx");
    expect(setup).not.toMatch(/TrainingPriceNote/);
    expect(setup).not.toMatch(/step\.training/);
  });
});
