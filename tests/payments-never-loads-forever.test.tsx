// /payments said "Loading balance…" and "Loading payouts…" and then never said
// anything else (#436). Nothing on that load path had a deadline: the embedded
// Stripe panels wait for an event connect-js sends, and when connect-js is the
// thing that failed (CORS from connect-js.stripe.com, a blocker, no network)
// nothing sends it. The balance headline was an un-timed query, and when it
// did fail it drew nothing, so a phone got an empty Money tab and no reason.
//
// Every wait on the page now ends, and ends in words. This file pins each
// piece of that without a DOM (the repo has no DOM renderer): the card as a
// reducer, the headline as a pure decision, the deadline helper with fake
// timers, a server render for the first paint, and the wiring in the source.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectCard } from "@/components/payments/ConnectCard";
import {
  INITIAL_CONNECT_CARD,
  connectCardReducer,
  type ConnectCardEvent,
  CONNECT_PANEL_TIMEOUT_MS,
  PAYMENTS_FETCH_TIMEOUT_MS,
  STRIPE_DID_NOT_ANSWER,
  STRIPE_HAD_A_PROBLEM,
  TRY_AGAIN,
  ownerSentenceFor,
  balanceSummaryState,
  withTimeout,
} from "@/lib/payments-load";

const root = join(import.meta.dirname, "..");
const page = readFileSync(join(root, "src/routes/_authenticated/payments.tsx"), "utf8");
const card = readFileSync(join(root, "src/components/payments/ConnectCard.tsx"), "utf8");
const server = readFileSync(join(root, "src/lib/stripe-connect.functions.ts"), "utf8");

const run = (...events: ConnectCardEvent[]) =>
  events.reduce(connectCardReducer, INITIAL_CONNECT_CARD);

describe("an embedded Stripe panel always leaves 'Loading'", () => {
  it("starts loading", () => {
    expect(INITIAL_CONNECT_CARD.state).toBe("loading");
  });

  it("Stripe never says anything: the deadline turns it into a visible error", () => {
    // The #436 case exactly. No loaderStart, no loadError, only time passing.
    const s = run({ type: "deadline" });
    expect(s.state).toBe("error");
    expect(s.message).toBe(STRIPE_DID_NOT_ANSWER);
  });

  it("a panel that rendered is never overwritten by a late deadline", () => {
    const s = run({ type: "loaderStart" }, { type: "deadline" });
    expect(s.state).toBe("ready");
  });

  it("Stripe's own error shows the fixed owner sentence, and a late deadline keeps it", () => {
    // Product review on #563: raw Stripe text is for the console, not the
    // owner. ConnectCard logs it; the card reads a sentence we wrote.
    const s = run({ type: "loadError" }, { type: "deadline" });
    expect(s).toMatchObject({ state: "error", message: STRIPE_HAD_A_PROBLEM });
    expect(card).toMatch(/console\.error\([\s\S]{0,80}e\?\.error\?\.message/);
  });

  it("Try again goes back to loading, remounts the panel, and the deadline applies again", () => {
    const s1 = run({ type: "deadline" }, { type: "retry" });
    expect(s1).toMatchObject({ state: "loading", message: null, attempt: 1 });
    const s2 = connectCardReducer(s1, { type: "deadline" });
    expect(s2.state).toBe("error");
    const s3 = run({ type: "deadline" }, { type: "retry" }, { type: "loaderStart" });
    expect(s3).toMatchObject({ state: "ready", attempt: 1 });
  });

  it("first paint is the loading line, with the panel mounted (hidden) so Stripe can start", () => {
    let handed = false;
    const html = renderToStaticMarkup(
      <ConnectCard title="Payouts">
        {(h) => {
          handed = typeof h.onLoaderStart === "function" && typeof h.onLoadError === "function";
          return <span data-panel="payouts" />;
        }}
      </ConnectCard>,
    );
    expect(html).toContain("Loading payouts…");
    expect(html).toContain('data-panel="payouts"');
    expect(handed).toBe(true);
  });

  it("the card arms the deadline while loading, and the default is finite", () => {
    expect(CONNECT_PANEL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(CONNECT_PANEL_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(card).toMatch(
      /if \(state !== "loading"\) return;\s*const t = setTimeout\(\(\) => dispatch\(\{ type: "deadline" \}\), timeoutMs\);/,
    );
    expect(card).toMatch(/timeoutMs = CONNECT_PANEL_TIMEOUT_MS/);
  });

  it("the page uses the shared card, not a private copy without the deadline", () => {
    expect(page).toMatch(/import \{ ConnectCard \} from "@\/components\/payments\/ConnectCard"/);
    expect(page).not.toMatch(/function ConnectCard\(/);
  });
});

describe("the balance headline says what happened", () => {
  const base = { isPending: false, isError: false };

  it("loading only while a request is in flight", () => {
    expect(balanceSummaryState({ isPending: true, isError: false }).kind).toBe("loading");
  });

  it("a thrown or timed-out request is a visible error, not nothing", () => {
    const v = balanceSummaryState({
      ...base,
      isError: true,
      error: new Error(STRIPE_DID_NOT_ANSWER),
    });
    expect(v).toEqual({
      kind: "error",
      message: STRIPE_DID_NOT_ANSWER,
      detail: STRIPE_DID_NOT_ANSWER,
    });
  });

  it("an error with no message still says something", () => {
    expect(balanceSummaryState({ ...base, isError: true, error: {} })).toEqual({
      kind: "error",
      message: STRIPE_HAD_A_PROBLEM,
      detail: "unknown error",
    });
  });

  it("Stripe answering with an error is shown, where it used to be swallowed", () => {
    const v = balanceSummaryState({
      ...base,
      data: { connected: true, error: "Stripe is not configured on the server" },
    });
    // The owner reads our sentence; the server's text is kept for the console.
    expect(v).toEqual({
      kind: "error",
      message: STRIPE_HAD_A_PROBLEM,
      detail: "Stripe is not configured on the server",
    });
  });

  it("no live account draws nothing here: the page already says how to connect", () => {
    expect(balanceSummaryState({ ...base, data: { connected: false } }).kind).toBe("not-connected");
  });

  it("a brand-new account with $0.00 and no payouts is ready, not loading", () => {
    // The Oct 24 retest's state: $0.00 and the empty payouts state.
    const v = balanceSummaryState({
      ...base,
      data: {
        connected: true,
        available: [{ amount: 0, currency: "usd" }],
        pending: [],
        lastPayout: null,
      },
    });
    expect(v.kind).toBe("ready");
  });

  it("the page wires the query through the deadline and shows the error with a retry", () => {
    expect(page).toMatch(
      /queryKey: \["stripe-balance"\][\s\S]{0,400}withTimeout\([\s\S]{0,120}PAYMENTS_FETCH_TIMEOUT_MS/,
    );
    expect(page).toMatch(/const view = balanceSummaryState\(q\)/);
    expect(page).toMatch(/view\.kind === "error"[\s\S]{0,600}Couldn't load your balance/);
    // The old silent branch.
    expect(page).not.toMatch(/if \(!d \|\| !d\.connected \|\| d\.error\) return null;/);
  });
});

describe("what the owner reads (product review on #563)", () => {
  it("raw server or Stripe text never reaches the owner", () => {
    expect(ownerSentenceFor("Invalid API Key provided: sk_test_****")).toBe(STRIPE_HAD_A_PROBLEM);
    expect(ownerSentenceFor(undefined)).toBe(STRIPE_HAD_A_PROBLEM);
    expect(ownerSentenceFor(STRIPE_DID_NOT_ANSWER)).toBe(STRIPE_DID_NOT_ANSWER);
    // The status branch used to interpolate q.error.message straight in.
    expect(page).not.toMatch(/Couldn't check your Stripe account: \{/);
    expect(page).toMatch(
      /Couldn't check your Stripe account\. \{ownerSentenceFor\(statusError\)\}/,
    );
    expect(page).toMatch(/console\.error\("\[payments\] Stripe status read failed:"/);
    expect(page).toMatch(/console\.error\("\[payments\] Stripe balance read failed:"/);
  });

  it("every retry button this PR added says the same thing", () => {
    expect(TRY_AGAIN).toBe("Try again");
    expect(card).toMatch(/\{TRY_AGAIN\}/);
    expect(card).not.toMatch(/>\s*Retry\s*</);
    expect(page.match(/"Retrying…" : TRY_AGAIN/g) ?? []).toHaveLength(2);
  });
});

describe("the dashboard and the status read have an end too", () => {
  it("both Account Session calls are under the deadline", () => {
    const calls = page.match(/withTimeout\(\s*sessionFn\(\),\s*PAYMENTS_FETCH_TIMEOUT_MS/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(page).not.toMatch(/await sessionFn\(\)/);
  });

  it("a failed status read is an error, not 'No Stripe account connected yet'", () => {
    // Order matters: the error branch has to come before the not-connected one,
    // or a live account reads as none and is offered "Set up payments".
    const err = page.indexOf(") : q.isError ? (");
    const none = page.indexOf(") : !cfg?.connected ? (");
    expect(err).toBeGreaterThan(-1);
    expect(none).toBeGreaterThan(err);
    expect(page).toMatch(/Couldn't check your Stripe account/);
  });

  it("the server gives each Stripe call a deadline and answers a missing key", () => {
    const fn = server.slice(server.indexOf("export const getStripeBalanceSummary"));
    expect(fn).toMatch(/timeout: 10_000/);
    expect(fn).toMatch(/stripe\.balance\.retrieve\(\{\}, opts\)/);
    expect(fn).toMatch(/stripe\.payouts\.list\(\{ limit: 1 \}, opts\)/);
    expect(fn).not.toMatch(/throw new Error\("Stripe is not configured on the server"\)/);
  });
});

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a promise that never settles rejects at the deadline with the message", async () => {
    const p = withTimeout(new Promise<never>(() => {}), PAYMENTS_FETCH_TIMEOUT_MS, "nope");
    const assertion = expect(p).rejects.toThrow("nope");
    await vi.advanceTimersByTimeAsync(PAYMENTS_FETCH_TIMEOUT_MS);
    await assertion;
  });

  it("a fast answer wins and leaves no timer behind", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "nope")).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast failure keeps its own reason", async () => {
    await expect(withTimeout(Promise.reject(new Error("401")), 1000, "nope")).rejects.toThrow(
      "401",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
