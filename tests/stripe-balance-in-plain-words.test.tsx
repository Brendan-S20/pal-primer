// @vitest-environment happy-dom
//
// #922. /payments, Money tab, the Riverbend demo owner, every day Nov 12-16:
//
//   "Couldn't load your balance. Only Stripe Connect platforms can work with
//    other accounts. If you specified a client_id parameter, make sure it is
//    correct. If you need to setup a Stripe Connect platform, you can do so at
//    https://dashboard.stripe.com/account/applications/settings."
//
// above a Balance and Payouts that rendered fine.
//
// THE CAUSE. getStripeBalanceSummary built its client from STRIPE_SECRET_KEY,
// HoundStack's own SaaS-billing Stripe account. The tenant's connected account
// belongs to the Connect PLATFORM (STRIPE_CONNECT_SECRET_KEY), which is the key
// the Account Session behind Balance and Payouts already used. Acting as
// `{ stripeAccount }` from an account that is not its platform is exactly the
// request Stripe answers with that sentence. So: the headline goes through
// connectStripe() like every other Connect call.
//
// THE SECOND FAULT, whatever the cause: Stripe's text was printed to an owner.
// It is now logged on the server and the owner reads BALANCE_UNAVAILABLE, with
// Try again, in one card in the slot the figures take.
//
// And the dashboard's Connect instance is created once per mount
// (useConnectInstance), never re-initialised while one is alive.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BalanceSummary } from "@/components/payments/BalanceSummary";
import {
  BALANCE_UNAVAILABLE,
  DASHBOARD_UNAVAILABLE,
  STRIPE_DID_NOT_ANSWER,
  dashboardErrorMessage,
  type BalanceSummaryData,
} from "@/lib/payments-load";
import { loadBalanceSummary, type BalanceStripe } from "@/lib/stripe-balance-summary.server";
import { useConnectInstance } from "@/lib/use-connect-instance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source with comments removed, so a sentence ABOUT a key is not a use of it. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// The Stripe error the smokes saw, shaped like a StripeError. `raw` and
// `headers` stand in for what a real error object can carry about the request;
// none of it may reach the log or the page.
const STRIPE_TEXT =
  "Only Stripe Connect platforms can work with other accounts. If you specified a client_id " +
  "parameter, make sure it is correct. If you need to setup a Stripe Connect platform, you " +
  "can do so at https://dashboard.stripe.com/account/applications/settings.";
function stripeError() {
  return Object.assign(new Error(STRIPE_TEXT), {
    type: "StripePermissionError",
    code: undefined,
    statusCode: 403,
    requestId: "req_test_922",
    headers: { authorization: "Bearer sk_test_must_never_be_logged" },
    raw: { headers: { authorization: "Bearer sk_test_must_never_be_logged" } },
  });
}

const ACCT = { accountId: "acct_1TestRiverbend", chargesEnabled: true, collectedByParent: false };

function fakeStripe(over: Partial<BalanceStripe> = {}) {
  const calls: Array<{ what: string; opts: Record<string, unknown> }> = [];
  const s: BalanceStripe = {
    balance: {
      retrieve: async (_p, opts) => {
        calls.push({ what: "balance", opts });
        return {
          available: [
            { amount: 12_500, currency: "usd" },
            { amount: 500, currency: "usd" },
          ],
          pending: [{ amount: 3_000, currency: "usd" }],
        };
      },
    },
    payouts: {
      list: async (_p, opts) => {
        calls.push({ what: "payouts", opts });
        return {
          data: [{ amount: 9_000, currency: "usd", status: "paid", arrival_date: 1_763_000_000 }],
        };
      },
    },
    ...over,
  };
  return { stripe: s, calls };
}

// ── The server half ─────────────────────────────────────────────────────

describe("the balance headline asks Stripe as the Connect platform (#922 cause)", () => {
  it("reads the connected account through connectStripe, with the account in the options", async () => {
    const { stripe, calls } = fakeStripe();
    const connectStripe = vi.fn(async () => stripe);
    const r = await loadBalanceSummary("org_riverbend", {
      resolveAccount: async () => ACCT,
      connectStripe,
      log: () => {},
    });
    expect(connectStripe).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.opts.stripeAccount)).toEqual([ACCT.accountId, ACCT.accountId]);
    expect(r).toEqual({
      connected: true,
      available: [{ currency: "usd", amount: 13_000 }],
      pending: [{ currency: "usd", amount: 3_000 }],
      lastPayout: {
        amount: 9_000,
        currency: "usd",
        status: "paid",
        arrivalDate: 1_763_000_000_000,
      },
    });
  });

  it("the server function and its helper never build a client from STRIPE_SECRET_KEY", () => {
    // The defect, at the line that had it. STRIPE_SECRET_KEY is SaaS billing.
    const fns = code("src/lib/stripe-connect.functions.ts");
    // The last export in the file, so it runs to the end.
    const fn = fns.slice(fns.indexOf("export const getStripeBalanceSummary"));
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).toMatch(/connectStripe/);
    expect(fn).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(fn).not.toMatch(/makeStripe\(/);
    const helper = code("src/lib/stripe-balance-summary.server.ts");
    expect(helper).not.toMatch(/process\.env/);
  });

  it("uses the franchise-aware account, the same one the Account Session draws", () => {
    const fns = code("src/lib/stripe-connect.functions.ts");
    const fn = fns.slice(fns.indexOf("export const getStripeBalanceSummary"));
    expect(fn).toMatch(/resolveAccount: resolveOrgStripeAccount/);
  });

  it("no live account: nothing to show, and Stripe is never asked", async () => {
    const connectStripe = vi.fn();
    for (const acct of [null, { ...ACCT, chargesEnabled: false }]) {
      const r = await loadBalanceSummary("org", {
        resolveAccount: async () => acct,
        connectStripe,
        log: () => {},
      });
      expect(r).toEqual({ connected: false });
    }
    expect(connectStripe).not.toHaveBeenCalled();
  });
});

describe("a Stripe refusal is logged on the server and said in plain words (#922)", () => {
  it("Stripe's error: the owner gets BALANCE_UNAVAILABLE, the log gets Stripe's reason", async () => {
    const log = vi.fn();
    const { stripe } = fakeStripe({
      balance: {
        retrieve: async () => {
          throw stripeError();
        },
      },
    });
    const r = await loadBalanceSummary("org_riverbend", {
      resolveAccount: async () => ACCT,
      connectStripe: async () => stripe,
      log,
    });
    expect(r).toEqual({ connected: true, error: BALANCE_UNAVAILABLE });
    expect(JSON.stringify(r)).not.toMatch(/Connect platform|client_id|dashboard\.stripe\.com/);

    expect(log).toHaveBeenCalledTimes(1);
    const [msg, detail] = log.mock.calls[0];
    expect(msg).toMatch(/stripe-balance/);
    expect(detail).toMatchObject({
      orgId: "org_riverbend",
      type: "StripePermissionError",
      statusCode: 403,
      requestId: "req_test_922",
      message: STRIPE_TEXT,
    });
    // The account is identified, not printed whole, and nothing that rode
    // along on the error object (headers, raw) is logged.
    expect(detail.account).toBe("acct_…bend");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/sk_(test|live)_/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(ACCT.accountId);
  });

  it("no Connect key on the server: the same plain answer, and a log line", async () => {
    const log = vi.fn();
    const r = await loadBalanceSummary("org", {
      resolveAccount: async () => ACCT,
      connectStripe: async () => {
        throw new Error("Stripe Connect is not configured. Contact support.");
      },
      log,
    });
    expect(r).toEqual({ connected: true, error: BALANCE_UNAVAILABLE });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("the Account Session's refusal is logged and replaced the same way", () => {
    const fns = code("src/lib/stripe-connect.functions.ts");
    const fn = fns.slice(
      fns.indexOf("export const createStripeAccountSession"),
      fns.indexOf("export const refreshStripeConnect"),
    );
    expect(fn).toMatch(
      /accountSessions\s*\.create\(sessionParams\)\s*\.catch\([\s\S]{0,600}console\.error\([\s\S]{0,600}throw new Error\(DASHBOARD_UNAVAILABLE\)/,
    );
    // And the page prints that message alone, not prefixed with Stripe's.
    const page = code("src/routes/_authenticated/payments.tsx");
    expect(page).not.toMatch(/Couldn't load the payment dashboard: \{err\}/);
    expect(page).toMatch(/\{dashboardErrorMessage\(err\)\}/);
    expect(DASHBOARD_UNAVAILABLE).not.toMatch(/Stripe Connect platform|client_id/);
  });

  it("the dashboard card passes through only our own sentences", () => {
    expect(dashboardErrorMessage(STRIPE_TEXT)).toBe(DASHBOARD_UNAVAILABLE);
    expect(dashboardErrorMessage("Cannot read properties of null (reading 'publishableKey')")).toBe(
      DASHBOARD_UNAVAILABLE,
    );
    expect(dashboardErrorMessage(null)).toBe(DASHBOARD_UNAVAILABLE);
    expect(dashboardErrorMessage(STRIPE_DID_NOT_ANSWER)).toBe(STRIPE_DID_NOT_ANSWER);
    const verify =
      "Verify your email address to unlock payments. Check your inbox or resend the link from the Payments page.";
    expect(dashboardErrorMessage(verify)).toBe(verify);
  });
});

// ── The card ────────────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

function renderSummary(fetchSummary: () => Promise<BalanceSummaryData>) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(BalanceSummary, { fetchSummary }),
      ),
    ),
  );
}

describe("the balance card", () => {
  it("error: one card, plain words, Try again, and no Stripe text anywhere in the DOM", async () => {
    // What the server now returns for the Nov 12-16 failure.
    const fetchSummary = vi.fn(
      async (): Promise<BalanceSummaryData> => ({ connected: true, error: BALANCE_UNAVAILABLE }),
    );
    renderSummary(fetchSummary);
    await flush();

    const alerts = host.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(host.textContent).toContain(
      "We can't show your Stripe balance right now. Payments and payouts aren't affected.",
    );
    expect(host.textContent).not.toMatch(
      /Only Stripe Connect|client_id|dashboard\.stripe\.com|Couldn't load your balance/,
    );
    // The card stands in for the figures; it does not draw them as well.
    expect(host.textContent).not.toMatch(/Available now|Still clearing/);
    const btn = [...host.querySelectorAll("button")].find((b) => /Try again/.test(b.textContent!));
    expect(btn, "no Try again button").toBeTruthy();
  });

  it("even a thrown error carrying Stripe's text renders only our sentence", async () => {
    const fetchSummary = vi.fn(async (): Promise<BalanceSummaryData> => {
      throw stripeError();
    });
    renderSummary(fetchSummary);
    await flush();
    await flush();
    expect(host.textContent).toContain(BALANCE_UNAVAILABLE);
    expect(host.innerHTML).not.toMatch(/Only Stripe Connect|client_id|dashboard\.stripe\.com/);
  });

  it("Try again asks again, and a good answer replaces the card with the figures", async () => {
    let fail = true;
    const fetchSummary = vi.fn(
      async (): Promise<BalanceSummaryData> =>
        fail
          ? { connected: true, error: BALANCE_UNAVAILABLE }
          : {
              connected: true,
              available: [{ amount: 12_500, currency: "usd" }],
              pending: [],
              lastPayout: null,
            },
    );
    renderSummary(fetchSummary);
    await flush();
    expect(fetchSummary).toHaveBeenCalledTimes(1);

    fail = false;
    const btn = [...host.querySelectorAll("button")].find((b) => /Try again/.test(b.textContent!))!;
    await act(async () => btn.click());
    await flush();

    expect(fetchSummary).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Available now");
    expect(host.textContent).toContain("$125.00");
  });

  it("happy path: the figures, and no error card", async () => {
    renderSummary(async () => ({
      connected: true,
      available: [{ amount: 0, currency: "usd" }],
      pending: [{ amount: 204, currency: "usd" }],
      lastPayout: null,
    }));
    await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Available now");
    expect(host.textContent).toContain("Still clearing");
    expect(host.textContent).not.toContain(BALANCE_UNAVAILABLE);
  });

  it("the Money tab draws the headline once, above ONE Balance and ONE Payouts", () => {
    const page = read("src/routes/_authenticated/payments.tsx");
    const money = page.slice(
      page.indexOf('<TabsContent value="money"'),
      page.indexOf("</TabsContent>", page.indexOf('<TabsContent value="money"')),
    );
    expect(money.match(/<BalanceSummary\b/g)).toHaveLength(1);
    expect(money.match(/title="Balance"/g)).toHaveLength(1);
    expect(money.match(/title="Payouts"/g)).toHaveLength(1);
    expect(money.indexOf("<BalanceSummary")).toBeLessThan(money.indexOf('title="Balance"'));
    // Nothing else in the tab renders an error of its own about the balance.
    expect(money).not.toMatch(/role="alert"/);
  });
});

// ── One Connect instance per mount ──────────────────────────────────────

type Inst = { id: number; logout: ReturnType<typeof vi.fn> };

function Probe(props: {
  enabled: boolean;
  reloadKey: number;
  create: () => Promise<Inst>;
  seen: Array<Inst | null>;
}) {
  const { instance } = useConnectInstance<Inst>(props);
  props.seen.push(instance);
  return null;
}

describe("the Connect instance is created once per mount (#922 console noise)", () => {
  it("StrictMode's double effect, re-renders and a Try again with a live instance make ONE", async () => {
    let n = 0;
    const made: Inst[] = [];
    const create = vi.fn(async () => {
      const inst = { id: ++n, logout: vi.fn() };
      made.push(inst);
      return inst;
    });
    const seen: Array<Inst | null> = [];
    const at = (reloadKey: number) =>
      act(() =>
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(Probe, { enabled: true, reloadKey, create, seen }),
          ),
        ),
      );
    at(0);
    await flush();
    at(0);
    at(1); // Try again while one is alive.
    await flush();
    at(2);
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(made[0]);
  });

  it("not enabled (narrow screen, live account): nothing is created", async () => {
    const create = vi.fn(async () => ({ id: 1, logout: vi.fn() }));
    act(() =>
      root.render(createElement(Probe, { enabled: false, reloadKey: 0, create, seen: [] })),
    );
    await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it("after a failure, Try again creates one; unmount logs it out", async () => {
    let attempt = 0;
    const inst: Inst = { id: 1, logout: vi.fn() };
    const create = vi.fn(async () => {
      if (attempt++ === 0) throw new Error(DASHBOARD_UNAVAILABLE);
      return inst;
    });
    const seen: Array<Inst | null> = [];
    act(() => root.render(createElement(Probe, { enabled: true, reloadKey: 0, create, seen })));
    await flush();
    expect(seen.at(-1)).toBeNull();
    act(() => root.render(createElement(Probe, { enabled: true, reloadKey: 1, create, seen })));
    await flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toBe(inst);

    act(() => root.render(createElement("div")));
    expect(inst.logout).toHaveBeenCalledTimes(1);
  });

  it("the dashboard goes through the hook, and loadConnectAndInitialize appears once", () => {
    const page = code("src/routes/_authenticated/payments.tsx");
    expect(page).toMatch(/useConnectInstance<any>\(\{/);
    expect(page.match(/loadConnectAndInitialize\(/g)).toHaveLength(1);
    expect(page).not.toMatch(/setInstance\(inst\)/);
  });
});
