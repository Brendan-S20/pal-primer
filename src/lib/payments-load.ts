// Every wait on the Payments page has an end (#436).
//
// The page said "Loading balance…" and "Loading payouts…" and then never said
// anything else. Nothing on the load path had a deadline:
//
//   - The embedded Stripe panels leave their loading state on `onLoaderStart`
//     or `onLoadError`. If connect-js never arrives (a CORS failure from
//     connect-js.stripe.com, a content blocker, a dead network), neither
//     fires, and the card waits forever.
//   - The Account Session that the panels need was an un-timed server call.
//   - The balance headline was an un-timed query, and when it did fail it
//     rendered nothing at all, so a phone (where it is the ONLY balance) got an
//     empty tab and no reason.
//
// So: one deadline per wait, and each one ends in words the owner can act on.

/** How long an embedded Stripe panel gets to start rendering before the card
 *  says it could not load. Stripe's own loader appears well inside a few
 *  seconds on a slow phone connection; twenty is generous on purpose, because
 *  a false "couldn't load" on the money page is its own kind of alarm. */
export const CONNECT_PANEL_TIMEOUT_MS = 20_000;

/** How long one of our own server calls on this page (the balance headline,
 *  the Account Session) may take. The server gives Stripe 10s per request
 *  with one retry, so this is the outer bound on top of that. */
export const PAYMENTS_FETCH_TIMEOUT_MS = 25_000;

/** What the owner reads when Stripe did not answer in time. Says what to try,
 *  because "timed out" alone is a diagnosis, not an instruction. */
export const STRIPE_DID_NOT_ANSWER =
  "Stripe didn't respond. Check your connection (or any ad or content blocker) and try again.";

/** What the owner reads for any other failure. A fixed sentence, never the
 *  raw text: Stripe's and the server's messages are written for developers
 *  ("Invalid API Key provided", "No such account") and are logged to the
 *  console instead, where support can still find them. */
export const STRIPE_HAD_A_PROBLEM =
  "Stripe returned an error. Try again in a moment, and contact support if it keeps happening.";

/** The one label every retry button on this page uses. */
export const TRY_AGAIN = "Try again";

/** The sentence an owner reads for a raw failure message: the deadline's own
 *  sentence when it was the deadline, the fixed one for anything else. */
export function ownerSentenceFor(raw: string | null | undefined): string {
  return raw === STRIPE_DID_NOT_ANSWER ? STRIPE_DID_NOT_ANSWER : STRIPE_HAD_A_PROBLEM;
}

/** Reject with `message` if `p` has not settled within `ms`. The timer is
 *  cleared either way, so a fast answer leaves nothing behind. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

export type ConnectCardState = {
  state: "loading" | "ready" | "error";
  message: string | null;
  /** Bumped on Try again; keys the panel so Stripe's component remounts. */
  attempt: number;
};

export type ConnectCardEvent =
  { type: "loaderStart" } | { type: "loadError" } | { type: "deadline" } | { type: "retry" };

export const INITIAL_CONNECT_CARD: ConnectCardState = {
  state: "loading",
  message: null,
  attempt: 0,
};

/** The card's whole lifecycle. Pure, so tests/payments-never-loads-forever
 *  can walk it without a DOM. The rule it exists for: "loading" always has a
 *  way out that does not depend on Stripe saying anything. */
export function connectCardReducer(s: ConnectCardState, e: ConnectCardEvent): ConnectCardState {
  switch (e.type) {
    case "loaderStart":
      return s.state === "loading" ? { ...s, state: "ready", message: null } : s;
    case "loadError":
      // Stripe's own text goes to the console (ConnectCard logs it); the
      // owner reads the fixed sentence.
      return { ...s, state: "error", message: STRIPE_HAD_A_PROBLEM };
    case "deadline":
      // Only a card still waiting times out. One that rendered, or already
      // failed with Stripe's own error, keeps what it has.
      return s.state === "loading" ? { ...s, state: "error", message: STRIPE_DID_NOT_ANSWER } : s;
    case "retry":
      return { state: "loading", message: null, attempt: s.attempt + 1 };
  }
}

export type BalanceSummaryData =
  | { connected: false }
  | {
      connected: true;
      error?: string;
      available?: Array<{ amount: number; currency: string }>;
      pending?: Array<{ amount: number; currency: string }>;
      lastPayout?: unknown;
    };

/**
 * Which of four things the balance headline should draw. Pure so the decision
 * is tested without a browser, and so "loading" can only be reached while a
 * request is actually in flight.
 *
 *   loading        a request is in flight (and has a deadline: see above)
 *   error          the request failed, timed out, or Stripe answered with an
 *                  error. Visible, with a retry. Never silent. `message` is
 *                  the owner's sentence; `detail` is the raw text, for the
 *                  console only.
 *   not-connected  no live Stripe account, so there is no balance to show.
 *                  The page around it already says how to connect.
 *   ready          a balance, including a new account's $0.00.
 */
export function balanceSummaryState(q: {
  isPending: boolean;
  isError: boolean;
  error?: unknown;
  data?: BalanceSummaryData | null;
}):
  | { kind: "loading" }
  | { kind: "error"; message: string; detail: string }
  | { kind: "not-connected" }
  | { kind: "ready" } {
  if (q.isError) {
    const raw = q.error instanceof Error && q.error.message ? q.error.message : "unknown error";
    return { kind: "error", message: ownerSentenceFor(raw), detail: raw };
  }
  if (q.isPending) return { kind: "loading" };
  const d = q.data;
  if (!d || !d.connected) return { kind: "not-connected" };
  if (d.error) return { kind: "error", message: ownerSentenceFor(d.error), detail: d.error };
  return { kind: "ready" };
}
