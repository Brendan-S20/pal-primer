import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/lib/billing.functions", () =>
  Object.fromEntries(
    [
      "getBillingStatus",
      "refreshBillingStatus",
      "listPlatformInvoices",
      "cancelBillingSubscription",
      "resumeBillingSubscription",
      "listSubscriptionItems",
      "createPlanSubscription",
      "listOrgPaymentMethods",
      "createOrgSetupIntent",
      "finalizeOrgPaymentMethod",
      "setDefaultOrgPaymentMethod",
      "removeOrgPaymentMethod",
      "listPlatformPlans",
    ].map((name) => [name, vi.fn()]),
  ),
);
vi.mock("@/lib/platform-addons.functions", () => ({
  listPlatformAddons: vi.fn(),
  subscribePlatformAddon: vi.fn(),
  cancelPlatformAddon: vi.fn(),
}));
vi.mock("@/lib/founding-offer.functions", () => ({ getFoundingOffer: vi.fn() }));
vi.mock("@/lib/native", () => ({ platform: () => "web" }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock("@/components/billing/ExportDataCard", () => ({ ExportDataCard: () => null }));

import { Route } from "@/routes/_authenticated/settings.billing";

const PAST = "2026-08-16T12:00:00Z";
const FUTURE = "2026-11-16T12:00:00Z";
const plans = [
  { name: "Launch", included_seats: 1, max_team_size: 3, price_cents: 7900, oldSeats: 3 },
  { name: "Growth", included_seats: 5, max_team_size: 15, price_cents: 19900, oldSeats: 10 },
  { name: "Scale", included_seats: 20, max_team_size: null, price_cents: 44900, oldSeats: 30 },
].map((p) => ({
  ...p,
  id: p.name,
  slug: p.name.toLowerCase(),
  annual_price_cents: p.price_cents * 10,
  price_per_seat_cents: 1500,
  is_free: false,
  description: `Includes ${p.oldSeats} employees; $10/mo per additional active employee.`,
}));

type Subscription = {
  subscriptionId: string | null;
  currentPeriodEnd: string | null;
  planInterval?: "month" | "year";
  cancelAtPeriodEnd?: boolean;
};

function renderBilling({
  subscription,
  subscribed = true,
  addonStatus = "coming_soon",
}: {
  subscription?: Subscription;
  subscribed?: boolean;
  addonStatus?: "active" | "coming_soon";
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["billing-status"], {
    planName: "Enterprise",
    planSlug: "enterprise",
    billingStatus: "active",
    isPaidTier: true,
    currentPeriodEnd: PAST,
    monthlyEstimateCents: null,
  });
  if (subscription)
    client.setQueryData(["billing-subscription-items"], { items: [], ...subscription });
  client.setQueryData(["platform-plans"], { plans, enabledUsers: 1 });
  client.setQueryData(["founding-offer"], { visible: false });
  client.setQueryData(["org-payment-methods"], { methods: [] });
  client.setQueryData(["platform-invoices"], { invoices: [] });
  client.setQueryData(["platform-addons"], {
    canSubscribe: true,
    addons: [
      { id: "ai", slug: "ai-receptionist", name: "AI Receptionist", price_cents: 9900 },
      { id: "sms", slug: "managed-sms", name: "Managed texting", price_cents: 2900 },
    ].map((a) => ({
      ...a,
      billing_interval: "month",
      status: addonStatus,
      subscribed,
      description: "Coming soon. Answers your clients' messages.",
    })),
  });
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Route.options.component as ComponentType),
      ),
    )
      .replace(/<[^>]*>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
  } finally {
    client.clear();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("billing cards use the checkout catalog", () => {
  it.each(["month", "year"] as const)(
    "shows one employee allowance and extra price for %s",
    (planInterval) => {
      const text = renderBilling({
        subscription: { subscriptionId: "sub_1", currentPeriodEnd: FUTURE, planInterval },
      });
      for (const count of [1, 5, 20]) {
        expect(text).toContain(`${count} active employee${count === 1 ? "" : "s"} included`);
      }
      expect(text.match(/per extra person/g)).toHaveLength(3);
      expect(
        text.match(
          planInterval === "year" ? /\$150\/yr per extra person/g : /\$15\/mo per extra person/g,
        ),
      ).toHaveLength(3);
      expect(text).not.toContain("per additional active employee");
      expect(text).not.toContain("$10/mo");
    },
  );
});

describe("renewal dates require a future Stripe subscription period", () => {
  it.each([
    undefined,
    { subscriptionId: null, currentPeriodEnd: FUTURE },
    { subscriptionId: "sub_1", currentPeriodEnd: PAST },
    { subscriptionId: "sub_1", currentPeriodEnd: "2026-10-12T12:00:00Z" },
    { subscriptionId: "sub_1", currentPeriodEnd: "invalid" },
    { subscriptionId: "sub_1", currentPeriodEnd: null },
  ])("omits a stale or inapplicable renewal (%j)", (subscription) => {
    const text = renderBilling({ subscription });
    expect(text).not.toContain("Renews ");
    expect(text).not.toContain("Bills ");
    expect(text).not.toContain("Aug 16");
  });

  it("uses the future Stripe date instead of the saved past date", () => {
    const text = renderBilling({
      subscription: { subscriptionId: "sub_1", currentPeriodEnd: FUTURE },
    });
    expect(text).toMatch(/Renews .*Nov 16/);
    expect(text).toMatch(/Bills .*Nov 16/);
    expect(text).not.toContain("Aug 16");
  });

  it("keeps scheduled cancellation distinct from renewal", () => {
    const text = renderBilling({
      subscription: { subscriptionId: "sub_1", currentPeriodEnd: FUTURE, cancelAtPeriodEnd: true },
    });
    expect(text).toMatch(/Cancels .*Nov 16/);
    expect(text).not.toContain("Renews ");
  });
});

describe("add-on status is exclusive", () => {
  it.each(["active", "coming_soon"] as const)(
    "shows subscribed held add-ons as Coming soon with catalog status %s",
    (addonStatus) => {
      const text = renderBilling({ addonStatus });
      expect(text).toContain("AI Receptionist Coming soon");
      expect(text).toContain("Managed texting Coming soon");
      expect(text.match(/Remove from plan/g)).toHaveLength(2);
      expect(text).toContain("Answers your clients' messages.");
      expect(text).not.toContain("AI Receptionist Active");
      expect(text).not.toContain("Managed texting Active");
      expect(text).not.toContain("Add to my plan");
    },
  );

  it("shows unsubscribed held add-ons as Coming soon", () => {
    const text = renderBilling({ subscribed: false });
    expect(text).toContain("AI Receptionist Coming soon");
    expect(text).toContain("Managed texting Coming soon");
    expect(text).not.toContain("AI Receptionist Active");
    expect(text).not.toContain("Managed texting Active");
    expect(text).not.toContain("Coming soon.");
    expect(text).not.toContain("Remove from plan");
    expect(text).not.toContain("Add to my plan");
  });
});
