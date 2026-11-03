// #639: the demo business runs pet waste, walking, sitting, grooming and
// training, and step 2 of /setup read "Price your sitting services". The
// price step was overwritten once per line and the last one won, so walks,
// grooms, lessons and the pet waste area were never asked for. A business
// with more than one line now gets one step with a part per line; a
// business with one line still gets the step for that line alone.

import { readFileSync } from "node:fs";
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

type World = {
  counts?: Record<string, number>;
  walkPriceCents?: number;
  staySaved?: boolean;
  groomReviewed?: boolean;
};

function context(lines: string[], w: World) {
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      const eqs: Record<string, unknown> = {};
      for (const m of ["gt", "not"]) q[m] = () => q;
      q.eq = (k: string, v: unknown) => {
        eqs[k] = v;
        return q;
      };
      q.select = (c: string) => {
        cols = c;
        return q;
      };
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: "org-a" } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: lines } };
          if (cols === "groom_setup_reviewed_at")
            return { data: { groom_setup_reviewed_at: w.groomReviewed ? "2026-10-01" : null } };
          return { data: { contact_address: "1 Main St" } };
        }
        if (table === "services" && eqs.service_line === "dog_walking")
          return { data: [{ base_price_cents: w.walkPriceCents ?? 0 }] };
        if (table === "services" && eqs.service_line === "pet_sitting")
          return {
            data: [{ created_at: "a", updated_at: w.staySaved ? "b" : "a" }],
          };
        return { count: w.counts?.[table] ?? 0 };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
  return { supabase, userId: "owner" } as never;
}

async function priceStep(lines: string[], w: World = {}): Promise<OnboardingStep> {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[] }>;
  const { steps } = await load(context(lines, w));
  return steps.find((s) => s.id === "zones")!;
}

const ALL_FIVE = ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"];

describe("the price step at a business with all five lines", () => {
  it("names every line, not the last one", async () => {
    const step = await priceStep(ALL_FIVE);
    expect(step.label).toBe("Price your services");
    expect(step.label).not.toMatch(/sitting/);
    expect(step.description).toMatch(/pet waste zones, walks, stays, grooms and lessons/);
    expect(step.parts?.map((p) => p.id)).toEqual(["area", "walks", "stays", "grooms", "lessons"]);
    expect(step.to).toBe("/setup");
    expect(step.gate).toBe("/zones");
    expect(step.training).toBeUndefined();
    expect(step.alt).toBeUndefined();
    expect(step.done).toBe(false);
  });

  it("is done only when every part is", async () => {
    const all = {
      counts: { zones: 1, service_packages: 1, training_skills: 3 },
      walkPriceCents: 2500,
      staySaved: true,
      groomReviewed: true,
    };
    expect((await priceStep(ALL_FIVE, all)).done).toBe(true);
    for (const missing of [
      { ...all, counts: { ...all.counts, zones: 0 } },
      { ...all, walkPriceCents: 0 },
      { ...all, staySaved: false },
      { ...all, groomReviewed: false },
      { ...all, counts: { ...all.counts, training_skills: 0 } },
    ]) {
      expect((await priceStep(ALL_FIVE, missing)).done).toBe(false);
    }
  });

  it("marks each part by its own test", async () => {
    const step = await priceStep(ALL_FIVE, { walkPriceCents: 2500, groomReviewed: true });
    const done = Object.fromEntries(step.parts!.map((p) => [p.id, p.done]));
    expect(done).toEqual({ area: false, walks: true, stays: false, grooms: true, lessons: false });
  });
});

describe("the walks part", () => {
  it("prices walks, not drop-ins, which are sitting", async () => {
    const step = await priceStep(ALL_FIVE);
    const walks = step.parts!.find((p) => p.id === "walks")!;
    expect(walks.description).not.toMatch(/drop-in/i);
    expect(step.parts!.find((p) => p.id === "stays")!.description).toMatch(/Drop-in/);
  });
});

// Review of #666: saving the area form ran Setup's own onSaved, which marked
// the whole price step done and jumped to the next step while walks, stays,
// grooms and lessons were still open.
describe("saving the area on a step with parts", () => {
  const src = readFileSync("src/routes/_authenticated/setup.tsx", "utf8");
  const panel = src.slice(
    src.indexOf("function PricesPanel("),
    src.indexOf("function ServiceAreaPanel("),
  );

  it("does not hand the area form the advancing onSaved", () => {
    expect(panel).toMatch(/<ServiceAreaPanel[\s\S]*?onSaved=\{areaSaved\}/);
    expect(panel).not.toMatch(/onSaved=\{onSaved\}/);
  });

  it("moves on only when the refreshed step has every part done", () => {
    expect(panel).toMatch(/invalidateQueries\(\{ queryKey: \["onboarding-status"\] \}\)/);
    expect(panel).toMatch(/parts\?\.every\(\(p\) => p\.done\)\) onSaved\(\)/);
  });

  it("says Save area, not Save and continue, while other parts are open", () => {
    expect(panel).toMatch(/saveLabel=\{othersOpen \? "Save area" : undefined\}/);
  });

  it("never forces a step with parts to done on Setup's side", () => {
    expect(src).toMatch(/s\.id === current\.id && !s\.parts \? \{ \.\.\.s, done: true \} : s/);
  });
});

describe("two lines without pet waste or training", () => {
  it("asks for walks and stays and no service area", async () => {
    const step = await priceStep(["dog_walking", "pet_sitting"]);
    expect(step.parts?.map((p) => p.id)).toEqual(["walks", "stays"]);
    expect(step.description).toMatch(/walks and stays/);
    expect(step.gate).toBe("/settings/services");
  });
});

describe("a business with one line keeps the step for that line", () => {
  it.each([
    [["pet_waste"], "Your service area and price", "/setup"],
    [["dog_walking"], "Price your walks", "/settings/services"],
    [["pet_sitting"], "Price your sitting services", "/settings/services"],
    [["mobile_grooming"], "Review your grooming prices, vaccines and buffer", "/setup"],
    // R2-47: a trainer's step is the lessons, not the pet-waste area form.
    [["training"], "Price your lessons", "/settings/services"],
  ])("%j", async (lines, label, to) => {
    const step = await priceStep(lines);
    expect(step.label).toBe(label);
    expect(step.to).toBe(to);
    expect(step.parts).toBeUndefined();
  });
});
