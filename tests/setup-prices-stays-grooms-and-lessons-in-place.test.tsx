// @vitest-environment happy-dom
//
// #959: setup asks a sitter, a groomer and a trainer for their prices on
// /setup, the way #769 asks a walker, with no trip to Settings, Services.
//
// The acceptance criteria, as behaviour. Each form is the real one
// (SetupLinePrices.tsx) in a DOM, writing into one in-memory business through
// fakes of the server functions it calls -- the stay write is the REAL
// setSetupStayPrices handler over a fake table, so its all-or-nothing refusal
// is the server's own -- and the real loadOnboardingStatus then reads that
// same business back, the way the checklist does. Nothing between the form
// and "done" but the write.
//
//   1. Sitter-only, groomer-only, trainer-only and mixed: priced on /setup.
//   2. Sitting: done only when Drop-in, Overnight stay and House sit are
//      saved on purpose; the seeded starters prefill.
//   3. Grooming: done only with a priced size AND vaccines/buffer reviewed.
//   4. Training: done only with a priced package AND a skill.
//   5. Settings, Services and the Plan step read the same prices.
//   6. Each line alone, one mixed org, a refused partial save each.
//   7. The walk form is untouched (pinned in a-walker-sets-up-as-a-walker).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG = "org-959";
const DROP_IN = "aaaaaaaa-0000-4000-8000-000000000959";
const OVERNIGHT = "aaaaaaaa-0000-4000-8000-000000000960";
const HOUSE_SIT = "aaaaaaaa-0000-4000-8000-000000000961";
const GROOM = "aaaaaaaa-0000-4000-8000-000000000962";
const LESSON = "aaaaaaaa-0000-4000-8000-000000000963";
const PACKAGE = "aaaaaaaa-0000-4000-8000-000000000964";

type Row = {
  id: string;
  organization_id: string;
  name: string;
  service_line: string;
  price_unit: string;
  base_price_cents: number | null;
  extra_pet_cents: number;
  default_duration_min: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const world = vi.hoisted(() => ({
  services: [] as Row[],
  sizeRules: [] as Array<{
    id: string;
    service_id: string;
    size: string;
    coat_type: string | null;
    duration_min: number;
    price_cents: number;
  }>,
  org: {
    groom_setup_reviewed_at: null as string | null,
    vaccine_rule: "warn",
    required: ["rabies"],
    buffer: 15,
  },
  packages: [] as Array<{
    id: string;
    organization_id: string;
    service_id: string;
    name: string;
    sessions_count: number;
    price_cents: number;
    expires_after_days: number | null;
    active: boolean;
  }>,
  skills: [] as Array<{ id: string; name: string; sort_order: number; active: boolean }>,
  toast: { success: vi.fn(), error: vi.fn() },
  writes: [] as string[],
  clock: 0,
  /** Saved zones (#958): every non-waste line also needs a service area. */
  zones: 0,
}));
const { toast } = world;

vi.mock("sonner", () => ({ toast: world.toast }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: (v: (d: unknown) => unknown) => {
      (builder as { v?: unknown }).v = v;
      return builder;
    },
    handler: (fn: (a: unknown) => unknown) => {
      const v = (builder as { v?: (d: unknown) => unknown }).v;
      return (a: { data?: unknown; context?: unknown }) =>
        fn({ ...a, data: v ? v(a.data) : a.data });
    },
  };
  return {
    useServerFn: (f: unknown) => f,
    createServerFn: () => builder,
    createServerOnlyFn: (fn: unknown) => fn,
  };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: "org-959", role: "owner" }),
  resolveCaller: async () => ({ orgId: "org-959", role: "owner" }),
}));
vi.mock("@/components/client-detail/ServicePicker", () => ({
  useOrgServices: () => ({ services: world.services, isLoading: false }),
}));

// The stay write: the REAL handler, given a supabase over world.services.
vi.mock("@/lib/setup-stay-prices.functions", async (importOriginal) => {
  const real = (await importOriginal()) as {
    setSetupStayPrices: (a: unknown) => Promise<unknown>;
  };
  const table = () => {
    const eqs: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    const rows = () =>
      world.services.filter((s) =>
        Object.entries(eqs).every(([k, v]) => (s as Record<string, unknown>)[k] === v),
      );
    q.select = () => q;
    q.update = (p: Record<string, unknown>) => {
      patch = p;
      return q;
    };
    q.eq = (k: string, v: unknown) => {
      eqs[k === "organization_id" ? "organization_id" : k] = v;
      return q;
    };
    q.then = (res: (v: unknown) => unknown) => {
      const hit = rows();
      if (patch) {
        world.writes.push("services");
        for (const s of hit) Object.assign(s, patch, { updated_at: `t${++world.clock}` });
      }
      return Promise.resolve({ data: hit.map((s) => ({ id: s.id })), error: null }).then(res);
    };
    return q;
  };
  return {
    setSetupStayPrices: (a: { data: unknown }) =>
      real.setSetupStayPrices({
        data: a.data,
        context: { supabase: { from: () => table() }, userId: "owner" },
      }),
  };
});

vi.mock("@/lib/groom.functions", () => ({
  listServiceSizeRules: async ({ data }: { data: { serviceId: string } }) => ({
    rules: world.sizeRules.filter((r) => r.service_id === data.serviceId),
  }),
  upsertServiceSizeRule: async ({ data }: { data: Record<string, any> }) => {
    world.writes.push("service_size_rules");
    const found = world.sizeRules.find(
      (r) => r.service_id === data.serviceId && r.size === data.size && r.coat_type === null,
    );
    const row = {
      id: found?.id ?? `rule-${data.size}`,
      service_id: data.serviceId,
      size: data.size,
      coat_type: null,
      duration_min: data.durationMin,
      price_cents: data.priceCents,
    };
    if (found) Object.assign(found, row);
    else world.sizeRules.push(row);
    return { id: row.id };
  },
}));
vi.mock("@/lib/vaccines.functions", () => ({
  getVaccineSettings: async () => ({
    enabled: true,
    rule: world.org.vaccine_rule,
    required: world.org.required,
    today: "2026-11-16",
    bufferMin: world.org.buffer,
  }),
  setVaccineSettings: async ({ data }: { data: Record<string, any> }) => {
    world.writes.push("organizations");
    world.org.vaccine_rule = data.rule;
    world.org.required = data.required;
    world.org.buffer = data.bufferMin;
    if (data.setupReviewed) world.org.groom_setup_reviewed_at = "2026-11-16T12:00:00Z";
    return { ok: true };
  },
}));
vi.mock("@/lib/training-packages.functions", () => ({
  ensureTrainingCatalog: async () => ({ ok: true }),
  listServicePackages: async () => ({ packages: world.packages }),
  saveServicePackage: async ({ data }: { data: Record<string, any> }) => {
    world.writes.push("service_packages");
    const p = world.packages.find((x) => x.id === data.id)!;
    Object.assign(p, { sessions_count: data.sessionsCount, price_cents: data.priceCents });
    return { id: p.id };
  },
  setServicePackageActive: async ({ data }: { data: { id: string; active: boolean } }) => {
    world.writes.push("service_packages.active");
    world.packages.find((x) => x.id === data.id)!.active = data.active;
    return { ok: true };
  },
}));
vi.mock("@/lib/training-progress.functions", () => ({
  listTrainingSkills: async () => ({ skills: world.skills }),
  saveTrainingSkill: async ({ data }: { data: { name: string } }) => {
    world.writes.push("training_skills");
    const id = `skill-${world.skills.length + 1}`;
    world.skills.push({ id, name: data.name, sort_order: world.skills.length, active: true });
    return { id };
  },
}));

import { GroomSetupForm, StayPricesForm, TrainingSetupForm } from "@/components/SetupLinePrices";
import { setSetupStayPrices } from "@/lib/setup-stay-prices.functions";
import { loadOnboardingStatus, type OnboardingStep } from "@/lib/onboarding.functions";
import { servicePriceCents } from "@/lib/services";
import { STAYS_MISSING, staysSavedForSetup } from "@/lib/setup-line-prices";
import type { ServiceLine } from "@/lib/service-lines";

// ── The business, as signup leaves it ─────────────────────────────────────

const service = (
  id: string,
  name: string,
  line: string,
  unit: string,
  cents: number | null,
  minutes: number | null,
): Row => ({
  id,
  organization_id: ORG,
  name,
  service_line: line,
  price_unit: unit,
  base_price_cents: cents,
  extra_pet_cents: 0,
  default_duration_min: minutes,
  active: true,
  created_at: "t0",
  updated_at: "t0",
});

function freshBusiness() {
  world.clock = 0;
  world.zones = 0;
  world.writes = [];
  // The sitting starters (migration 20261024081200), created with prices.
  world.services = [
    service(DROP_IN, "Drop-in", "pet_sitting", "visit", 2500, 30),
    service(OVERNIGHT, "Overnight stay", "pet_sitting", "night", 7500, null),
    service(HOUSE_SIT, "House sit", "pet_sitting", "night", 10000, null),
    service(GROOM, "Bath and tidy (60 min)", "mobile_grooming", "visit", 5000, 60),
    service(LESSON, "Private lesson (60 min)", "training", "visit", null, 60),
  ];
  world.sizeRules = [];
  world.org = {
    groom_setup_reviewed_at: null,
    vaccine_rule: "warn",
    required: ["rabies"],
    buffer: 15,
  };
  // ensureTrainingDefaults: the package inactive at $0, no skills yet here.
  world.packages = [
    {
      id: PACKAGE,
      organization_id: ORG,
      service_id: LESSON,
      name: "6-session package",
      sessions_count: 6,
      price_cents: 0,
      expires_after_days: 90,
      active: false,
    },
  ];
  world.skills = [];
}

// ── The server reading it back, as loadOnboardingStatus does ──────────────

function context(lines: ServiceLine[]) {
  const supabase = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      const eqs: Record<string, unknown> = {};
      const gts: Record<string, number> = {};
      q.not = () => q;
      q.gt = (k: string, v: number) => {
        gts[k] = v;
        return q;
      };
      q.eq = (k: string, v: unknown) => {
        eqs[k] = v;
        return q;
      };
      q.select = (c: string) => {
        cols = c;
        return q;
      };
      const answer = () => {
        if (table === "user_roles") return { data: { organization_id: ORG } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: lines } };
          if (cols === "groom_setup_reviewed_at")
            return { data: { groom_setup_reviewed_at: world.org.groom_setup_reviewed_at } };
          return { data: { contact_address: "1 Main St" } };
        }
        if (table === "services" && eqs.service_line)
          return {
            data: world.services.filter((s) => s.service_line === eqs.service_line && s.active),
          };
        if (table === "service_size_rules") {
          const active = new Set(world.services.filter((s) => s.active).map((s) => s.id));
          return {
            count: world.sizeRules.filter(
              (r) => active.has(r.service_id) && r.price_cents > (gts.price_cents ?? -1),
            ).length,
          };
        }
        if (table === "service_packages")
          return { count: world.packages.filter((p) => p.active && p.price_cents > 0).length };
        if (table === "zones") return { count: world.zones };
        if (table === "training_skills")
          return { count: world.skills.filter((s) => s.active).length };
        return { count: 0 };
      };
      q.maybeSingle = async () => answer();
      q.single = async () => answer();
      q.then = (res: (v: unknown) => unknown) => Promise.resolve(answer()).then(res);
      return q;
    },
  };
  return { supabase, userId: "owner" } as never;
}

/** #959 with #958: the line's own part is done once its prices are saved,
 *  and the whole step once a service area (a zone) exists as well. */
async function expectDoneOnceAnAreaExists(lines: ServiceLine[], part: string) {
  const before = await priceStep(lines);
  expect(before.parts?.find((p) => p.id === part)?.done).toBe(true);
  expect(before.parts?.find((p) => p.id === "area")?.done).toBe(false);
  expect(before.done).toBe(false);
  world.zones = 1;
  expect((await priceStep(lines)).done).toBe(true);
}

async function priceStep(lines: ServiceLine[]): Promise<OnboardingStep> {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[] }>;
  const { steps } = await load(context(lines));
  return steps.find((s) => s.id === "zones")!;
}

// ── The forms, in a DOM ───────────────────────────────────────────────────

let host: HTMLElement;
let root: Root | null = null;

async function open(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  });
  await settle();
}

async function settle() {
  // Queries resolve on timers as well as microtasks.
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const input = (id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;

async function type(id: string, value: string) {
  await act(async () => {
    const el = input(id);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(selector: string) {
  await act(async () => {
    host
      .querySelector(`form[${selector}]`)!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const alertText = () => host.querySelector("[data-setup-line-error]")?.textContent ?? null;

beforeEach(() => {
  freshBusiness();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

// ── 2. Sitting ────────────────────────────────────────────────────────────

describe("#959 a sitter-only business", () => {
  const SITTER: ServiceLine[] = ["pet_sitting"];

  it("is asked on /setup, and the seeded starters do not count as chosen", async () => {
    const step = await priceStep(SITTER);
    expect(step.to).toBe("/setup");
    expect(step.cta).toBe("Price stays");
    expect(step.done).toBe(false);
  });

  it("prefills the three stays with the starters, each required, priced per visit or night", async () => {
    await open(<StayPricesForm done={false} onSaved={() => {}} />);
    expect(input(`setup-stay-${DROP_IN}`).value).toBe("25.00");
    expect(input(`setup-stay-${OVERNIGHT}`).value).toBe("75.00");
    expect(input(`setup-stay-${HOUSE_SIT}`).value).toBe("100.00");
    for (const id of [DROP_IN, OVERNIGHT, HOUSE_SIT])
      expect(input(`setup-stay-${id}`).required).toBe(true);
    expect(host.querySelector(`label[for="setup-stay-${OVERNIGHT}"]`)!.textContent).toBe(
      "Overnight stay ($ per night)",
    );
    expect(host.querySelector(`label[for="setup-stay-${DROP_IN}"]`)!.textContent).toBe(
      "Drop-in ($ per visit)",
    );
  });

  it("refuses a partial save: one stay cleared, nothing written, the step stays open", async () => {
    const onSaved = vi.fn();
    await open(<StayPricesForm done={false} onSaved={onSaved} />);
    await type(`setup-stay-${OVERNIGHT}`, "");
    await submit("data-setup-stay-prices");
    expect(alertText()).toBe("Enter a price for Overnight stay.");
    expect(toast.error).toHaveBeenCalledWith("Enter a price for Overnight stay.");
    expect(world.writes).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect((await priceStep(SITTER)).done).toBe(false);
  });

  it("the server refuses a save that leaves a stay out, before writing any", async () => {
    await expect(
      (setSetupStayPrices as unknown as (a: unknown) => Promise<unknown>)({
        data: {
          prices: [
            { id: DROP_IN, cents: 3000 },
            { id: OVERNIGHT, cents: 8000 },
          ],
        },
      }),
    ).rejects.toThrow(STAYS_MISSING);
    expect(world.writes).toEqual([]);
    expect((await priceStep(SITTER)).done).toBe(false);
  });

  it("saving all three, starters kept or changed, finishes the step with no Settings detour", async () => {
    const onSaved = vi.fn();
    await open(<StayPricesForm done={false} onSaved={onSaved} />);
    await type(`setup-stay-${DROP_IN}`, "30");
    await submit("data-setup-stay-prices");
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Stay prices saved");
    expect(onSaved).toHaveBeenCalledTimes(1);
    const cents = Object.fromEntries(world.services.map((s) => [s.id, s.base_price_cents]));
    expect([cents[DROP_IN], cents[OVERNIGHT], cents[HOUSE_SIT]]).toEqual([3000, 7500, 10000]);
    await expectDoneOnceAnAreaExists(SITTER, "stays");

    // 5. The rows Settings, Services lists and the Plan step quotes from.
    for (const id of [DROP_IN, OVERNIGHT, HOUSE_SIT]) {
      const s = world.services.find((x) => x.id === id)!;
      expect(servicePriceCents(s as never, { pets: 1, nights: 1 })).not.toBeNull();
    }
    expect(input(`setup-stay-${DROP_IN}`).value).toBe("30.00");
  });

  it("one stay saved in Settings no longer ticks the part while the others quote the starter", () => {
    expect(
      staysSavedForSetup([
        { base_price_cents: 2500, created_at: "t0", updated_at: "t1" },
        { base_price_cents: 7500, created_at: "t0", updated_at: "t0" },
      ]),
    ).toBe(false);
    expect(staysSavedForSetup([])).toBe(false);
  });
});

// ── 3. Grooming ───────────────────────────────────────────────────────────

describe("#959 a groomer-only business", () => {
  const GROOMER: ServiceLine[] = ["mobile_grooming"];

  it("is asked on /setup", async () => {
    const step = await priceStep(GROOMER);
    expect(step.to).toBe("/setup");
    expect(step.done).toBe(false);
  });

  it("refuses a save with an empty size grid: nothing is written, not even the review", async () => {
    const onSaved = vi.fn();
    await open(<GroomSetupForm done={false} onSaved={onSaved} />);
    expect(host.querySelectorAll("[data-setup-size]")).toHaveLength(4);
    // The groom's own length prefills each size's minutes.
    expect(input("setup-size-small-minutes").value).toBe("60");
    await submit("data-setup-groom");
    expect(alertText()).toBe("Enter a price for at least one size.");
    expect(world.writes).toEqual([]);
    expect(world.org.groom_setup_reviewed_at).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("vaccines reviewed alone does not finish it", async () => {
    world.org.groom_setup_reviewed_at = "2026-11-16T12:00:00Z";
    expect((await priceStep(GROOMER)).done).toBe(false);
  });

  it("a priced size and the review, saved together, finish it", async () => {
    const onSaved = vi.fn();
    await open(<GroomSetupForm done={false} onSaved={onSaved} />);
    await type("setup-size-medium-price", "65");
    await type("setup-size-medium-minutes", "75");
    await type("setup-groom-buffer", "20");
    await submit("data-setup-groom");
    expect(toast.error).not.toHaveBeenCalled();
    expect(world.writes).toEqual(["service_size_rules", "organizations"]);
    expect(world.sizeRules).toEqual([
      expect.objectContaining({ size: "medium", price_cents: 6500, duration_min: 75 }),
    ]);
    expect(world.org.buffer).toBe(20);
    expect(world.org.groom_setup_reviewed_at).not.toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(1);
    await expectDoneOnceAnAreaExists(GROOMER, "grooms");
  });
});

// ── 4. Training ───────────────────────────────────────────────────────────

describe("#959 a trainer-only business", () => {
  const TRAINER: ServiceLine[] = ["training"];

  it("is asked on /setup", async () => {
    const step = await priceStep(TRAINER);
    expect(step.to).toBe("/setup");
    expect(step.done).toBe(false);
  });

  it("refuses a price with no skill, and a skill with no price; nothing is written", async () => {
    const onSaved = vi.fn();
    await open(<TrainingSetupForm done={false} onSaved={onSaved} />);
    expect(input("setup-package-sessions").value).toBe("6");
    await type("setup-package-price", "300");
    await submit("data-setup-training");
    expect(alertText()).toBe("Add one skill a trainer scores, like Sit.");
    await type("setup-package-price", "");
    await type("setup-new-skill", "Loose-leash walking");
    await submit("data-setup-training");
    expect(alertText()).toBe("Enter what the lesson package costs.");
    expect(world.writes).toEqual([]);
    expect(onSaved).not.toHaveBeenCalled();
    expect((await priceStep(TRAINER)).done).toBe(false);
  });

  it("a priced package and a skill finish it, and the package is on sale", async () => {
    const onSaved = vi.fn();
    await open(<TrainingSetupForm done={false} onSaved={onSaved} />);
    await type("setup-package-price", "300");
    await type("setup-new-skill", "Loose-leash walking");
    await submit("data-setup-training");
    expect(toast.error).not.toHaveBeenCalled();
    expect(world.packages[0]).toMatchObject({ price_cents: 30000, active: true });
    expect(world.skills.map((s) => s.name)).toEqual(["Loose-leash walking"]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    await expectDoneOnceAnAreaExists(TRAINER, "lessons");
  });

  it("a business with skills already is not made to add another", async () => {
    world.skills = [{ id: "s1", name: "Sit", sort_order: 0, active: true }];
    await open(<TrainingSetupForm done={false} onSaved={() => {}} />);
    expect(input("setup-new-skill").required).toBe(false);
    await type("setup-package-price", "250");
    await submit("data-setup-training");
    expect(world.writes).toEqual(["service_packages", "service_packages.active"]);
    await expectDoneOnceAnAreaExists(TRAINER, "lessons");
  });
});

// ── 1 and 6. One business that sits, grooms and trains ────────────────────

describe("#959 a mixed business", () => {
  const MIXED: ServiceLine[] = ["pet_sitting", "mobile_grooming", "training"];

  it("has a part per line, finished one form at a time, all on /setup", async () => {
    let step = await priceStep(MIXED);
    expect(step.to).toBe("/setup");
    // #958 asks the service area first; #959 prices the three inline.
    expect(step.parts?.map((p) => [p.id, p.done])).toEqual([
      ["area", false],
      ["stays", false],
      ["grooms", false],
      ["lessons", false],
    ]);

    // A refused partial save first: a blank House sit writes nothing.
    await open(<StayPricesForm done={false} onSaved={() => {}} saveLabel="Save stay prices" />);
    await type(`setup-stay-${HOUSE_SIT}`, "");
    await submit("data-setup-stay-prices");
    expect(world.writes).toEqual([]);
    expect((await priceStep(MIXED)).parts!.every((p) => !p.done)).toBe(true);

    await type(`setup-stay-${HOUSE_SIT}`, "110");
    await submit("data-setup-stay-prices");
    act(() => root?.unmount());
    step = await priceStep(MIXED);
    expect(step.parts?.map((p) => p.done)).toEqual([false, true, false, false]);
    expect(step.done).toBe(false);

    await open(<GroomSetupForm done={false} onSaved={() => {}} saveLabel="Save grooming setup" />);
    await type("setup-size-large-price", "80");
    await submit("data-setup-groom");
    act(() => root?.unmount());
    step = await priceStep(MIXED);
    expect(step.parts?.map((p) => p.done)).toEqual([false, true, true, false]);

    await open(<TrainingSetupForm done={false} onSaved={() => {}} saveLabel="Save lessons" />);
    await type("setup-package-price", "300");
    await type("setup-new-skill", "Recall");
    await submit("data-setup-training");
    step = await priceStep(MIXED);
    expect(step.parts?.map((p) => p.done)).toEqual([false, true, true, true]);
    // Every price saved, and the step still waits on the area (#958).
    expect(step.done).toBe(false);
    world.zones = 1;
    step = await priceStep(MIXED);
    expect(step.parts?.every((p) => p.done)).toBe(true);
    expect(step.done).toBe(true);
  });
});

// ── The page draws them, and nothing sends a person to Settings to finish ──

describe("#959 /setup draws each form, not a Settings button", () => {
  const page = readFileSync("src/routes/_authenticated/setup.tsx", "utf8");
  const pricing = page.slice(
    page.indexOf("function PricingPanel("),
    page.indexOf("function BusinessPanel("),
  );
  const prices = page.slice(
    page.indexOf("function PricesPanel("),
    page.indexOf("function ServiceAreaPanel("),
  );

  it("for a business with one of the three lines", () => {
    expect(pricing).toMatch(/return <GroomSetupForm done=\{step\.done\} onSaved=\{onSaved\} \/>/);
    expect(pricing).toMatch(/return <StayPricesForm done=\{step\.done\} onSaved=\{onSaved\} \/>/);
    expect(pricing).toMatch(
      /return <TrainingSetupForm done=\{step\.done\} onSaved=\{onSaved\} \/>/,
    );
    expect(pricing).not.toMatch(/Review grooming prices, vaccines and buffer/);
  });

  it("for each part of a mixed business, saved without leaving the step", () => {
    expect(page).toMatch(/INLINE_PARTS[^=]*= \["area", "walks", "stays", "grooms", "lessons"\]/);
    for (const [form, part] of [
      ["StayPricesForm", "stays"],
      ["GroomSetupForm", "grooms"],
      ["TrainingSetupForm", "lessons"],
    ]) {
      expect(prices).toMatch(new RegExp(`data-setup-price-form="${part}"`));
      expect(prices).toMatch(new RegExp(`<${form}[\\s\\S]*?onSaved=\\{partSaved\\}`));
    }
    expect(prices).not.toMatch(/onSaved=\{onSaved\}/);
  });

  it("each form's only Settings link is for the extras setup does not ask", async () => {
    await open(<StayPricesForm done={false} onSaved={() => {}} />);
    expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "/settings/services",
    ]);
    expect(host.textContent).toMatch(/holiday dates and the deposit refund window are in/);
  });
});
