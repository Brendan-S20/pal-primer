// Onboarding audit, 2026-11-09, D3: during the free trial, /onboarding's
// plan picker marked Launch "Current plan" (badge AND a disabled button)
// directly under "14 days left in your free trial ... Nothing is charged
// automatically and no card is on file." Nothing had been bought. The org's
// plan slug is the plan the TRIAL runs on, and PlanPicker treated any match
// with it as the plan being paid for; the missing interval (only a paid
// subscription has one) defaulted to "month", so the monthly card matched.
//
// A plan is "current" only while it is paid for. On a trial the same card says
// it is the trial's plan, and can still be chosen: choosing it is how the
// trial becomes a subscription.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-start")>()),
  useServerFn: (f: unknown) => f,
}));
vi.mock("@/lib/native", async (orig) => ({
  ...(await orig<typeof import("@/lib/native")>()),
  platform: () => "web",
}));
vi.mock("@/lib/billing.functions", () => ({
  listPlatformPlans: vi.fn(),
  createPlanSubscription: vi.fn(),
  refreshBillingStatus: vi.fn(),
}));
vi.mock("@/lib/founding-offer.functions", () => ({ getFoundingOffer: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { PlanPicker } from "@/components/billing/PlanPicker";

const plan = (slug: string, name: string, cents: number) => ({
  id: `plan-${slug}`,
  slug,
  name,
  price_cents: cents,
  annual_price_cents: cents * 10,
  included_seats: 2,
  price_per_seat_cents: 1500,
  max_team_size: 10,
  is_free: false,
  is_enterprise: false,
  features: [],
});

function render(props: Partial<Parameters<typeof PlanPicker>[0]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["platform-plans"], {
    plans: [plan("launch", "Launch", 4900), plan("crew", "Crew", 9900)],
    enabledUsers: 1,
  });
  qc.setQueryData(["founding-offer"], { visible: false, left: 0 });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <PlanPicker currentSlug="launch" onSelect={() => undefined} {...props} />
    </QueryClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("D3: the trial's plan is not the current plan", () => {
  it("says Included in your trial, not Current plan, while nothing is paid", () => {
    const html = render({ currentInterval: null, paid: false });
    expect(text(html)).not.toMatch(/Current plan/);
    expect(text(html)).toMatch(/Included in your trial/);
  });

  it("leaves the trial's plan choosable: buying it is how the trial ends", () => {
    const html = render({ currentInterval: null, paid: false });
    // No card's button is disabled for being current.
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Current plan/);
    expect((text(html).match(/Choose plan/g) ?? []).length).toBe(2);
  });

  it("still marks the plan a paying business is on as Current plan", () => {
    const html = render({ currentInterval: "month", paid: true });
    expect(text(html)).toMatch(/Current plan/);
    expect(text(html)).not.toMatch(/Included in your trial/);
  });

  it("is told by both callers whether the plan is paid for", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const f of [
      "src/routes/_authenticated/onboarding.tsx",
      "src/routes/_authenticated/settings.billing.tsx",
    ]) {
      const src = readFileSync(resolve(__dirname, "..", f), "utf8");
      const picker = src.slice(
        src.indexOf("<PlanPicker"),
        src.indexOf("/>", src.indexOf("<PlanPicker")),
      );
      expect(picker, f).toMatch(/paid=\{[^}]*isPaidTier/);
    }
  });
});
