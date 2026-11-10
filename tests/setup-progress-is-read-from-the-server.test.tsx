// Onboarding audit, 2026-11-09, D5 and D9: setup progress has one source.
//
// D5: on a fresh device, after five of six steps, every page carried the
// banner "Set up your business in 6 short steps. About five minutes, all of
// it skippable. [Start setup]" above the dashboard's "Setup: 5 of 6 steps
// done. [Finish setup]". The banner decided "started" from a localStorage
// key written only where /setup had been opened.
//
// D9: right after saving the first client, the client page said "Setup: 2 of
// 6 done. Next: Add or import clients". The new-client form never told the
// onboarding status it had changed, the banner held a 30-second-fresh copy,
// and even with fresh data its "Next" was the REMEMBERED step, which was the
// one just finished.

import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const device = vi.hoisted(() => ({ remembered: null as string | null }));

vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-start")>()),
  useServerFn: (f: unknown) => f,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => () => undefined,
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/dashboard" } }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getUser: vi.fn(), updateUser: vi.fn() } },
  isImpersonationTab: () => false,
}));
vi.mock("@/lib/onboarding.functions", () => ({
  getOnboardingStatus: vi.fn(),
  dismissOnboarding: vi.fn(),
}));
vi.mock("@/hooks/useMyRole", async (orig) => ({
  ...(await orig<typeof import("@/hooks/useMyRole")>()),
  useMyRole: () => ({ role: "owner", isLoading: false }),
}));
vi.mock("@/lib/setup-guide", async (orig) => ({
  ...(await orig<typeof import("@/lib/setup-guide")>()),
  // A device that has never opened /setup unless a test says otherwise.
  useSetupGuide: () => ({ phase: "open", userId: "owner-1" }),
  readRememberedStep: () => device.remembered,
}));

import { SetupGuideBanner } from "@/components/SetupGuideBanner";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { setupBanner } from "@/lib/setup-guide";

const IDS = ["business", "zones", "clients", "staff", "dump_site", "payouts"] as const;
const LABELS: Record<(typeof IDS)[number], string> = {
  business: "Your business details",
  zones: "Your service area and price",
  clients: "Add or import clients",
  staff: "Who runs the route",
  dump_site: "Where the day ends",
  payouts: "Get paid",
};

function status(doneIds: readonly string[]) {
  const steps = IDS.map((id) => ({
    id,
    label: LABELS[id],
    description: "",
    done: doneIds.includes(id),
    to: "/setup",
    cta: "Do it",
  }));
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    dismissed: false,
    emailVerified: true,
  };
}

function render(node: ReactNode, doneIds: readonly string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["onboarding-status"], status(doneIds));
  qc.setQueryData(["my-org"], { organization: { id: "org", role: "owner" } });
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("D5: the banner reads progress from getOnboardingStatus, not the device", () => {
  const fiveDone = ["business", "zones", "clients", "staff", "dump_site"];

  it("never says Start setup once a step is done, on a device that never opened /setup", () => {
    device.remembered = null;
    const banner = text(render(<SetupGuideBanner />, fiveDone));
    expect(banner).not.toMatch(/Start setup/);
    expect(banner).not.toMatch(/Set up your business in 6 short steps/);
    expect(banner).toMatch(/Continue setup \(5 of 6\)/);
    expect(banner).toMatch(/Setup: 5 of 6 done\./);
    expect(banner).toMatch(/Next: Get paid/);
  });

  it("agrees with the dashboard checklist on the same answer", () => {
    device.remembered = null;
    const banner = text(render(<SetupGuideBanner />, fiveDone));
    const checklist = text(render(<OnboardingChecklist placement="below-kpis" />, fiveDone));
    expect(checklist).toMatch(/Setup: 5 of 6 steps done\./);
    expect(banner).toMatch(/5 of 6/);
  });

  it("says Start setup only when nothing is done and nothing was started", () => {
    device.remembered = null;
    expect(text(render(<SetupGuideBanner />, []))).toMatch(/Start setup/);
    expect(setupBanner(status([]).steps, null).cta).toBe("Start setup");
    expect(setupBanner(status(["business"]).steps, null).cta).toBe("Continue setup (1 of 6)");
  });
});

describe("D9: a finished step leaves the banner as soon as it is finished", () => {
  it("does not offer the step just finished as Next, even though the device remembers it", () => {
    // The owner left /setup at the clients step for /clients/new, and saved.
    device.remembered = "clients";
    const banner = text(render(<SetupGuideBanner />, ["business", "zones", "clients"]));
    expect(banner).toMatch(/Setup: 3 of 6 done\./);
    expect(banner).not.toMatch(/Next: Add or import clients/);
    expect(banner).toMatch(/Next: Who runs the route/);
  });

  it("still resumes at a remembered step that is open", () => {
    expect(setupBanner(status(["business"]).steps, "staff").step).toBe("staff");
  });

  const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  it("the new-client form refreshes the onboarding status when it saves", () => {
    const form = src("src/routes/_authenticated/clients.new.tsx");
    const onSuccess = form.slice(
      form.indexOf("onSuccess: ({"),
      form.indexOf("onError:", form.indexOf("onSuccess: ({")),
    );
    expect(onSuccess, "the onboardClient mutation's onSuccess was not found").toMatch(
      /draft\.clear\(\)/,
    );
    // afterClientBookChanged resets the status, which is invalidating and
    // more: the stale copy is dropped rather than shown during the refetch
    // (#790; tests/a-first-client-does-not-paint-as-zero.test.tsx).
    expect(onSuccess).toMatch(/invalidateOnboardingStatus\(qc\)|afterClientBookChanged\(qc\)/);
  });

  it("the setup surfaces share one query, which nothing holds fresh for 30 seconds", () => {
    for (const f of [
      "src/components/AppSidebar.tsx",
      "src/components/SetupGuideBanner.tsx",
      "src/components/OnboardingChecklist.tsx",
      "src/routes/_authenticated/setup.tsx",
    ]) {
      const s = src(f);
      expect(s, f).toMatch(/useOnboardingStatus\(/);
      expect(s, `${f} declares its own onboarding-status query`).not.toMatch(
        /queryKey:\s*\["onboarding-status"\]/,
      );
    }
    const hook = src("src/hooks/useOnboardingStatus.ts");
    const stale = Number(/staleTime:\s*([\d_]+)/.exec(hook)?.[1].replace(/_/g, ""));
    expect(stale).toBeLessThanOrEqual(5_000);
  });

  it("every mutation that finishes a step on /setup's staff step refreshes the status", () => {
    const setup = src("src/routes/_authenticated/setup.tsx");
    const staff = setup.slice(
      setup.indexOf("function StaffPanel"),
      setup.indexOf("return (", setup.indexOf("function StaffPanel")),
    );
    // Both "That's me" and "Invite" finish the step; each says so itself
    // rather than relying on the caller's onSaved.
    // Spelled either as the helper or, inside stepSave, as the key in its
    // refresh list.
    expect(
      staff.match(/invalidateOnboardingStatus\(qc\)|refresh: \[ONBOARDING_STATUS_KEY/g)?.length ??
        0,
    ).toBeGreaterThanOrEqual(2);
  });
});
