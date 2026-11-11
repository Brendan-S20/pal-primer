/* eslint-disable @typescript-eslint/no-explicit-any -- module mocks stand in for router, server-fn and Supabase types */
// #848: after trial_ends_at passed, the account lock sent the owner to
// /settings/billing under "Your free trial has ended", and the same page said
// "Free trial" and "Pick a plan below before it ends". plan_status stays
// 'trialing' by design; the page now reads the phase trialStateFor derives,
// through getOrgBillingState, the same derivation the account lock uses.
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

let currentPlatform = "web";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: any) => ({ options }),
  Link: ({ children }: any) => createElement("a", null, children),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ navigate: vi.fn() }),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: any) => fn,
  useServerFn: (f: any) => f,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: () => b,
      validator: () => b,
      handler: () => vi.fn(async () => ({})),
    };
    return b;
  },
  createMiddleware: () => ({ server: () => ({}) }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/native", async (orig) => ({
  ...(await orig<typeof import("@/lib/native")>()),
  platform: () => currentPlatform,
}));

import { Route } from "@/routes/_authenticated/settings.billing";
import { getOrgBillingState } from "@/lib/billing-state.server";
import { accountLockFor } from "@/lib/account-lock";

const DAY = 86_400_000;

function org(trialEndsAt: string) {
  return {
    id: "org-1",
    name: "Expired Trial Co",
    active_client_count: 5,
    billing_status: null,
    plan_status: "trialing",
    plan_id: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_end: null,
    suspended_at: null,
    grace_expires_at: null,
    trial_ends_at: trialEndsAt,
    created_at: "2026-10-20T12:00:00Z",
  };
}

// Just enough of the query builder for getOrgBillingState's two reads.
function fakeSupabase(row: ReturnType<typeof org>) {
  return {
    from() {
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () => Promise.resolve({ data: [], error: null }),
        single: () => Promise.resolve({ data: row, error: null }),
      };
      return q;
    },
  };
}

let qc: QueryClient;
beforeEach(() => {
  vi.stubGlobal("React", React);
  currentPlatform = "web";
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
});

/** Render Plan & billing with getBillingStatus answering for this org. */
async function renderBillingPage(row: ReturnType<typeof org>) {
  const s = await getOrgBillingState(fakeSupabase(row), row.id);
  qc.setQueryData(["billing-status"], {
    planName: s.planName,
    billingStatus: s.billingStatus,
    trialPhase: s.trialPhase,
    isPaidTier: s.isPaidTier,
    monthlyEstimateCents: s.monthlyEstimateCents,
    teamSizeRange: s.teamSizeRange,
    includedSeats: s.includedSeats,
  });
  qc.setQueryData(["billing-subscription-items"], { items: [] });
  const Page = (Route as any).options.component;
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(Page)),
  );
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

describe("an expired trialing org on the billing page (#848)", () => {
  const expired = org(new Date(Date.now() - 2 * DAY).toISOString());

  it("derives expired from trial_ends_at while plan_status stays trialing, as the lock does", async () => {
    const s = await getOrgBillingState(fakeSupabase(expired), "org-1");
    expect(s.billingStatus).toBe("trialing");
    expect(s.trialPhase).toBe("expired");
    expect(accountLockFor(expired)).toMatchObject({ locked: true, reason: "trial_ended" });
  });

  it("web: shows Trial ended and tells the owner to choose a plan", async () => {
    const text = await renderBillingPage(expired);
    expect(text).toMatch(/Trial ended/);
    expect(text).toMatch(/Your free trial has ended and your account is locked\. Choose a plan/);
    expect(text).not.toMatch(/Free trial|before it ends/);
  });

  it("native: shows the ended wording with no purchase path", async () => {
    currentPlatform = "ios";
    const text = await renderBillingPage(expired);
    expect(text).toMatch(/Trial ended/);
    expect(text).toMatch(/Your free trial has ended/);
    expect(text).not.toMatch(/Free trial|before it ends/);
    expect(text).not.toMatch(/choose a plan|pick a plan|Choose plan|subscribe\b/i);
  });

  it("a trial that is still running reads Free trial, as before", async () => {
    const running = org(new Date(Date.now() + 5 * DAY).toISOString());
    const text = await renderBillingPage(running);
    expect(text).toMatch(/Free trial/);
    expect(text).not.toMatch(/Trial ended/);
  });
});
