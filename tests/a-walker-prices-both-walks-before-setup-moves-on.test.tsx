// @vitest-environment happy-dom
//
// #769, acceptance 1 and 4, as behaviour: a walker-only business and one
// that scoops AND walks cannot finish the prices step until the 30-minute
// and the 60-minute walk have a price (the drop-in may stay blank), and a
// walking signup reaches walksDone from /setup alone, with no trip to
// Settings, Services.
//
// #797 shipped the form (SetupWalkPrices.tsx) and the done rule
// (walksPricedForSetup); the Product live check of 2026-11-10 could only
// run the scoop-only path. This drives the real form, in a DOM, against a
// fake of setSetupWalkPrices that writes into the same in-memory services
// the form reads, then hands those services to the real loadOnboardingStatus,
// the way the server would read them back: the chain a live walker signup
// takes, with nothing between the form and "done" but the write.
//
// tests/a-walker-sets-up-as-a-walker.test.ts has the pure rules and the
// source pins; tests/viewports/a-business-that-does-not-scoop.spec.ts has the
// same refusal in a browser at four widths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Walk = {
  id: string;
  organization_id: string;
  name: string;
  service_line: string;
  default_duration_min: number | null;
  base_price_cents: number | null;
  active: boolean;
};

/** Signup's three walks, unpriced (DEFAULT_SERVICE_SEEDS.dog_walking), and
 *  the fakes around them. Hoisted, because vi.mock factories are. */
const ORG = "org-walker";
const WALK_30 = "aaaaaaaa-0000-4000-8000-000000000030";
const WALK_60 = "aaaaaaaa-0000-4000-8000-000000000060";
const DROP_IN = "aaaaaaaa-0000-4000-8000-000000000020";
const world = vi.hoisted(() => ({
  services: [] as Array<{
    id: string;
    organization_id: string;
    name: string;
    service_line: string;
    default_duration_min: number | null;
    base_price_cents: number | null;
    active: boolean;
  }>,
  toast: { success: vi.fn(), error: vi.fn() },
  /** The write, as setup-walk-prices.functions.ts does it: base_price_cents
   *  and nothing else, on this business's active walks. */
  setSetupWalkPrices: vi.fn(
    async ({ data }: { data: { prices: { id: string; cents: number | null }[] } }) => {
      for (const p of data.prices) {
        const walk = world.services.find(
          (s) =>
            s.id === p.id && s.organization_id === "org-walker" && s.service_line === "dog_walking",
        );
        if (!walk) throw new Error("That walk was not found.");
        walk.base_price_cents = p.cents;
      }
      return { ok: true };
    },
  ),
}));
const { toast, setSetupWalkPrices } = world;
const freshWalks = (): Walk[] =>
  [
    ["30-minute walk", WALK_30, 30],
    ["60-minute walk", WALK_60, 60],
    ["Drop-in visit (20 min)", DROP_IN, 20],
  ].map(([name, id, min]) => ({
    id: id as string,
    organization_id: ORG,
    name: name as string,
    service_line: "dog_walking",
    default_duration_min: min as number,
    base_price_cents: null,
    active: true,
  }));

vi.mock("sonner", () => ({ toast: world.toast }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@tanstack/react-start", () => {
  const builder = {
    middleware: () => builder,
    inputValidator: () => builder,
    handler: (fn: unknown) => fn,
  };
  return {
    useServerFn: (f: unknown) => f,
    createServerFn: () => builder,
    createServerOnlyFn: (fn: unknown) => fn,
  };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/components/client-detail/ServicePicker", () => ({
  useOrgServices: () => ({ services: world.services, isLoading: false }),
}));
vi.mock("@/lib/setup-walk-prices.functions", () => ({
  setSetupWalkPrices: world.setSetupWalkPrices,
}));

import { WalkPricesForm } from "@/components/SetupWalkPrices";
import { loadOnboardingStatus, type OnboardingStep } from "@/lib/onboarding.functions";
import type { ServiceLine } from "@/lib/service-lines";

// ── The server's reading of what the form wrote ───────────────────────────

function context(lines: ServiceLine[], counts: Record<string, number> = {}) {
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
        if (table === "user_roles") return { data: { organization_id: ORG } };
        if (table === "organizations") {
          if (cols === "service_lines") return { data: { service_lines: lines } };
          return { data: { contact_address: "1 Main St" } };
        }
        if (table === "services" && eqs.service_line === "dog_walking")
          return { data: world.services.filter((s) => s.active) };
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

async function priceStep(lines: ServiceLine[], counts = {}): Promise<OnboardingStep> {
  const load = loadOnboardingStatus as unknown as (
    c: unknown,
  ) => Promise<{ steps: OnboardingStep[] }>;
  const { steps } = await load(context(lines, counts));
  return steps.find((s) => s.id === "zones")!;
}

// ── The form, in a DOM ────────────────────────────────────────────────────

let host: HTMLElement;
let root: Root | null = null;
let qc: QueryClient;

async function open(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  qc = new QueryClient();
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  });
}

const field = (id: string) => host.querySelector<HTMLInputElement>(`#setup-walk-${id}`)!;
const labelOf = (id: string) => host.querySelector(`label[for="setup-walk-${id}"]`)!.textContent;

async function type(id: string, value: string) {
  await act(async () => {
    const el = field(id);
    // React listens for the native setter's change, not a plain .value write.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  await act(async () => {
    host
      .querySelector("form[data-setup-walk-prices]")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  // The mutation settles on a microtask or two.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  world.services = freshWalks();
  toast.success.mockClear();
  toast.error.mockClear();
  setSetupWalkPrices.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

const WALKER: ServiceLine[] = ["dog_walking"];
const MIXED: ServiceLine[] = ["pet_waste", "dog_walking"];

for (const [who, lines, counts, saveLabel] of [
  ["a walker-only business", WALKER, {}, undefined],
  ["a business that scoops and walks", MIXED, { zones: 1 }, "Save walk prices"],
] as const) {
  describe(`#769 ${who}`, () => {
    it("starts with every walk unpriced, and the step open", async () => {
      expect((await priceStep(lines, counts)).done).toBe(false);
    });

    it("draws the 30 and the 60 as required and the drop-in as optional", async () => {
      await open(<WalkPricesForm done={false} onSaved={() => {}} saveLabel={saveLabel} />);
      expect(field(WALK_30).required).toBe(true);
      expect(field(WALK_60).required).toBe(true);
      expect(field(DROP_IN).required).toBe(false);
      expect(labelOf(WALK_30)).toBe("30-minute walk ($)");
      expect(labelOf(WALK_60)).toBe("60-minute walk ($)");
      expect(labelOf(DROP_IN)).toBe("Drop-in visit (20 min) ($), optional");
      // The required walks come first, whatever order the list arrived in.
      const ids = [...host.querySelectorAll("input[id^=setup-walk-]")].map((i) => i.id);
      expect(ids).toEqual([
        `setup-walk-${WALK_30}`,
        `setup-walk-${WALK_60}`,
        `setup-walk-${DROP_IN}`,
      ]);
    });

    it("cannot save with the 30-minute walk alone: nothing is written and the step stays", async () => {
      const onSaved = vi.fn();
      await open(<WalkPricesForm done={false} onSaved={onSaved} saveLabel={saveLabel} />);
      await type(WALK_30, "25");
      await save();
      expect(toast.error).toHaveBeenCalledWith("Enter what a 60-minute walk costs.");
      expect(setSetupWalkPrices).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      expect((await priceStep(lines, counts)).done).toBe(false);
    });

    it("nor with the 60-minute walk alone", async () => {
      const onSaved = vi.fn();
      await open(<WalkPricesForm done={false} onSaved={onSaved} saveLabel={saveLabel} />);
      await type(WALK_60, "40");
      await save();
      expect(toast.error).toHaveBeenCalledWith("Enter what a 30-minute walk costs.");
      expect(setSetupWalkPrices).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("nor with the drop-in alone, the optional one", async () => {
      const onSaved = vi.fn();
      await open(<WalkPricesForm done={false} onSaved={onSaved} saveLabel={saveLabel} />);
      await type(DROP_IN, "18");
      await save();
      expect(toast.error).toHaveBeenCalledWith("Enter what a 30-minute walk costs.");
      expect(setSetupWalkPrices).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("saves with the 30 and the 60 priced and the drop-in blank, and the step is then done", async () => {
      const onSaved = vi.fn();
      await open(<WalkPricesForm done={false} onSaved={onSaved} saveLabel={saveLabel} />);
      await type(WALK_30, "25");
      await type(WALK_60, "40");
      await save();
      expect(toast.error).not.toHaveBeenCalled();
      expect(setSetupWalkPrices).toHaveBeenCalledTimes(1);
      expect(setSetupWalkPrices.mock.calls[0][0].data.prices).toEqual([
        { id: WALK_30, cents: 2500 },
        { id: WALK_60, cents: 4000 },
        { id: DROP_IN, cents: null },
      ]);
      expect(toast.success).toHaveBeenCalledWith("Walk prices saved");
      expect(onSaved).toHaveBeenCalledTimes(1);
      // The form shows what it wrote, from the services it reads.
      expect(field(WALK_30).value).toBe("25.00");
      expect(field(WALK_60).value).toBe("40.00");
      expect(field(DROP_IN).value).toBe("");

      // walksDone, read the way the server reads it: no Settings detour.
      const step = await priceStep(lines, counts);
      expect(step.done).toBe(true);
      expect(step.to).toBe("/setup");
      if (step.parts) {
        expect(step.parts.find((p) => p.id === "walks")?.done).toBe(true);
      }
    });

    it("the form never sends a person to Settings to finish: its only Settings link is for extras", async () => {
      await open(<WalkPricesForm done={false} onSaved={() => {}} saveLabel={saveLabel} />);
      const links = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      expect(links).toEqual(["/settings/services"]);
      expect(host.textContent).toMatch(/Extra-dog charges, lengths and new walks are in/);
      expect(host.querySelector('[data-setup-action="save-walks"]')!.textContent).toBe(
        saveLabel ?? "Save and continue",
      );
    });
  });
}

describe("#769 a drop-in priced too is quoted, and a drop-in price can be cleared", () => {
  it("writes the drop-in when given, and null when cleared", async () => {
    await open(<WalkPricesForm done={false} onSaved={() => {}} />);
    await type(WALK_30, "25");
    await type(WALK_60, "40");
    await type(DROP_IN, "18");
    await save();
    expect(world.services.find((s) => s.id === DROP_IN)!.base_price_cents).toBe(1800);
    expect((await priceStep(WALKER)).done).toBe(true);

    await type(DROP_IN, "");
    await save();
    expect(world.services.find((s) => s.id === DROP_IN)!.base_price_cents).toBeNull();
    expect((await priceStep(WALKER)).done).toBe(true);
  });

  it("a failed write is said and does not move the step on", async () => {
    const onSaved = vi.fn();
    setSetupWalkPrices.mockImplementationOnce(async () => {
      throw new Error("permission denied for table services");
    });
    await open(<WalkPricesForm done={false} onSaved={onSaved} />);
    await type(WALK_30, "25");
    await type(WALK_60, "40");
    await save();
    expect(toast.error).toHaveBeenCalledWith("permission denied for table services");
    expect(onSaved).not.toHaveBeenCalled();
    expect((await priceStep(WALKER)).done).toBe(false);
  });
});
