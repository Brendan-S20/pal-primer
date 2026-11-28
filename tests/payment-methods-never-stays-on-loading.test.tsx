// @vitest-environment happy-dom
//
// #1063. The client Billing tab's "Payment methods" sat on "Loading…". Nothing
// under that request had a time limit, so one that never settled had no end.
// Every outcome must now be cards, the empty state, or an error with Retry.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-start")>()),
  useServerFn: (f: unknown) => f,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: {} },
  isImpersonationTab: () => false,
}));
vi.mock("@/lib/payment-methods.functions", () => ({
  listClientPaymentMethods: h.list,
  setDefaultPaymentMethod: vi.fn(),
  removePaymentMethod: vi.fn(),
  createSetupIntentForClient: vi.fn(),
  finalizeCardSetupForClient: vi.fn(),
}));

import {
  PaymentMethodsPanel,
  PAYMENT_METHODS_DEADLINE_MS,
} from "@/components/client-detail/BillingTab";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  h.list.mockReset();
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const text = () => host!.textContent ?? "";
const retryButton = () =>
  [...host!.querySelectorAll("button")].find((b) => b.textContent === "Retry");

async function mount() {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(PaymentMethodsPanel, { clientId: "c-1" }),
      ),
    ),
  );
  await wait(1);
}

const NO_PROFILE = { methods: [], hasCustomer: false };

describe("Payment methods always leaves Loading", () => {
  it("shows an error and Retry when the call never answers, and Retry recovers", async () => {
    h.list.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(NO_PROFILE);
    await mount();
    await wait(PAYMENT_METHODS_DEADLINE_MS - 100);
    expect(text()).toContain("Loading…");
    await wait(200);
    expect(text()).not.toContain("Loading…");
    expect(text()).toContain("Couldn't load payment methods. This is taking longer than expected");
    expect(text()).not.toContain("No cards on file");

    await act(async () => retryButton()!.click());
    await wait(1);
    expect(text()).toContain("No cards on file (no billing profile yet)");
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("shows the failure and Retry at once when the call fails", async () => {
    h.list.mockRejectedValue(new Error("Stripe is not connected"));
    await mount();
    expect(text()).toContain("Couldn't load payment methods. Stripe is not connected");
    expect(retryButton()).toBeTruthy();
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("does not claim 'No cards on file' while the query is paused with no answer", async () => {
    onlineManager.setOnline(false);
    await mount();
    expect(text()).not.toContain("No cards on file");
    expect(retryButton()).toBeTruthy();
  });

  it("shows the empty state for a client with no billing profile", async () => {
    h.list.mockResolvedValue(NO_PROFILE);
    await mount();
    expect(text()).toContain("No cards on file (no billing profile yet)");
    expect(retryButton()).toBeUndefined();
  });

  it("lists the cards", async () => {
    h.list.mockResolvedValue({
      hasCustomer: true,
      methods: [
        { id: "pm_1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2099, isDefault: true },
      ],
    });
    await mount();
    expect(text()).toContain("····4242");
  });
});
