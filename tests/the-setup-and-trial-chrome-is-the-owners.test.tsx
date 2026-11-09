// R2-51: an office manager got a "5 short steps" setup prompt beside the
// owner's six, with a different done-count for the same business, and every
// non-tech role saw "14 days left… Ask an owner to set up billing" on every
// page, about a quarter of a 390px screen. Both are the owner's chrome now.
// An ended trial is still shown to everyone, because adding clients is paused
// for them too and the notice says why.

import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AppRole } from "@/hooks/useMyRole";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/dashboard" } }),
}));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@/lib/trial.functions", () => ({ getTrialState: vi.fn() }));
vi.mock("@/lib/onboarding.functions", () => ({
  getOnboardingStatus: vi.fn(),
  dismissOnboarding: vi.fn(),
}));

import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { shownToRole } from "@/components/TrialBanner";
import { canRunSetup, promptsSetup } from "@/lib/setup-guide";

const steps = ["business", "zones", "clients", "staff", "dump_site", "payouts"].map((id) => ({
  id,
  done: id === "business",
  label: `Step ${id}`,
  description: "",
  to: "/x",
  cta: "Do it",
}));

function checklistAs(role: AppRole) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["my-org"], { organization: { id: "org", role } });
  qc.setQueryData(["onboarding-status"], {
    completed: 1,
    total: steps.length,
    dismissed: false,
    steps,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <OnboardingChecklist />
    </QueryClientProvider>,
  );
}

describe("the setup prompt", () => {
  it("is the owner's", () => {
    expect(promptsSetup("owner")).toBe(true);
    for (const r of ["office_manager", "dispatcher", "tech"] as AppRole[]) {
      expect(promptsSetup(r), r).toBe(false);
    }
  });

  it("does not take /setup away from an office manager who opens it", () => {
    expect(canRunSetup("office_manager")).toBe(true);
  });

  it("draws the Get started card for the owner only", () => {
    expect(checklistAs("owner")).not.toBe("");
    expect(checklistAs("office_manager")).toBe("");
    expect(checklistAs("dispatcher")).toBe("");
  });
});

describe("the trial notice", () => {
  const trialing = { phase: "trialing" as const };

  it("counts down for the person who can set up billing", () => {
    expect(shownToRole({ ...trialing, canManageBilling: true })).toBe(true);
  });

  it("does not count down on every page for someone who can't", () => {
    expect(shownToRole({ ...trialing, canManageBilling: false })).toBe(false);
  });

  it("is shown to everyone once the trial or plan has ended", () => {
    expect(shownToRole({ phase: "expired", canManageBilling: false })).toBe(true);
    expect(shownToRole({ phase: "lapsed", canManageBilling: false })).toBe(true);
  });

  it("is never shown to a paid business", () => {
    expect(shownToRole({ phase: "paid", canManageBilling: true })).toBe(false);
    expect(shownToRole({ phase: "none", canManageBilling: true })).toBe(false);
  });
});
