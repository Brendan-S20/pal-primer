// Two setup-progress faults from QA row 42/44, held by rendering the pieces.
//
//   * The /setup bar on a phone was filled by the step you were ON, so it read
//     full on the last step while the line above said "3 of 6 done".
//   * The dashboard's Get started card stayed full size at the top for a
//     business already serving clients, pushing the day below the fold. Once
//     the clients step is done it folds to one line under the KPIs.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/dashboard" } }),
}));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@/lib/onboarding.functions", () => ({
  getOnboardingStatus: vi.fn(),
  dismissOnboarding: vi.fn(),
}));

import { OnboardingChecklist, checklistPlacement } from "@/components/OnboardingChecklist";
import { setupProgressPct } from "@/lib/setup-progress";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const ids = ["business", "zones", "clients", "staff", "dump_site", "payouts"];
const stepsWith = (done: string[]) =>
  ids.map((id) => ({
    id,
    done: done.includes(id),
    label: `Step ${id}`,
    description: "",
    to: "/x",
    cta: "Do it",
  }));

function render(node: ReactNode, steps: ReturnType<typeof stepsWith>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["my-org"], { organization: { id: "org", role: "owner" } });
  qc.setQueryData(["onboarding-status"], {
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    dismissed: false,
    steps,
  });
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("setupProgressPct", () => {
  it("3 of 6 done is half, wherever the person is in the list", () => {
    expect(setupProgressPct(stepsWith(["business", "zones", "staff"]))).toBe(50);
  });

  it("is full only when every step is done", () => {
    expect(setupProgressPct(stepsWith(ids))).toBe(100);
    const many = Array.from({ length: 200 }, (_, i) => ({ done: i > 0 }));
    expect(setupProgressPct(many)).toBeLessThan(100);
  });

  it("is empty for nothing", () => {
    expect(setupProgressPct([])).toBe(0);
    expect(setupProgressPct(stepsWith([]))).toBe(0);
  });

  it("drives the /setup bar, not the step index", () => {
    const setup = read("src/routes/_authenticated/setup.tsx");
    expect(setup).toMatch(/<Progress value=\{setupProgressPct\(steps\)\} \/>/);
    expect(setup).not.toMatch(/\(index \+ 1\) \/ steps\.length/);
  });
});

describe("the dashboard checklist folds once there is a client", () => {
  it("sits at the top until the clients step is done", () => {
    expect(checklistPlacement(stepsWith(["business"]))).toBe("top");
    expect(checklistPlacement(stepsWith(["business", "clients"]))).toBe("below-kpis");
  });

  it("with no client: the full card at the top, nothing under the KPIs", () => {
    const steps = stepsWith(["business", "zones"]);
    expect(render(<OnboardingChecklist />, steps)).toContain("Get started");
    expect(render(<OnboardingChecklist placement="below-kpis" />, steps)).toBe("");
  });

  it("with a client: one line under the KPIs, nothing at the top", () => {
    const steps = stepsWith(["business", "zones", "clients"]);
    expect(render(<OnboardingChecklist />, steps)).toBe("");
    const html = render(<OnboardingChecklist placement="below-kpis" />, steps);
    expect(html).toContain("Setup: 3 of 6 steps done.");
    expect(html).toContain("Finish setup");
    expect(html).not.toContain("<li");
    expect(html).toContain('aria-label="Dismiss the setup checklist"');
    expect(html).toMatch(/touch:min-h-11/);
  });

  it("the dashboard has both slots, the folded one after the KPI grid", () => {
    const dash = read("src/routes/_authenticated/dashboard.tsx");
    const top = dash.indexOf("<OnboardingChecklist />");
    const kpis = dash.indexOf('label="Active clients"');
    const below = dash.indexOf('<OnboardingChecklist placement="below-kpis" />');
    expect(top).toBeGreaterThan(-1);
    expect(kpis).toBeGreaterThan(top);
    expect(below).toBeGreaterThan(kpis);
  });
});
