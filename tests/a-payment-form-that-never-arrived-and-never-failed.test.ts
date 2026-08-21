// Taking a customer's money is the operational point of the field app, and the
// two surfaces that do it both had the same shape of bug: one await with no
// deadline, driving the only thing on screen.
//
// iOS QA 2026-08-20, on a real $1,425 overdue invoice: "Take payment" → the
// panel opened, showed the amount, and then sat on "Preparing secure form…"
// — disabled, no error, no timeout — for 80+ seconds. Screenshots at 20s and
// 80s were byte-identical. `intentM.isPending` is the ONLY input to that
// button's label, so a server function that never settles is indistinguishable
// from one that is still working, for ever.
//
// The saved-card SetupIntent on the same client mounted fine, which is what
// makes this worth pinning rather than dismissing as "the backend was down":
// Stripe.js, the publishable key and the connected account were all healthy,
// and the UI still had no way to say so.
//
// Both are safe to retry, which is what makes a deadline the right shape:
// createInvoicePaymentIntent reuses an existing stripe_payment_intent_id
// rather than minting a second, a SetupIntent moves no money, and neither
// confirms anything — the customer does that in the Element.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every surface that fetches a Stripe client secret before it can render a
 *  Payment Element, with the server function it waits on. */
const SECRET_FETCHERS = [
  {
    file: "src/components/StaffInvoicePayForm.tsx",
    fn: "intentFn",
    what: "the invoice payment form",
  },
  {
    file: "src/components/client-detail/BillingTab.tsx",
    fn: "createFn",
    what: "the saved-card setup form",
  },
] as const;

describe("a form that cannot arrive must be able to fail", () => {
  for (const { file, fn, what } of SECRET_FETCHERS) {
    const src = codeOnly(read(file));

    it(`${what} bounds the call it blocks on`, () => {
      expect(src, `${file} no longer imports withDeadline`).toMatch(
        /withDeadline[\s\S]{0,120}from "@\/lib\/offline\/run-or-queue"/,
      );
      // The awaited server fn is inside a deadline, not bare.
      const re = new RegExp(`withDeadline\\(\\s*${fn}\\(`);
      expect(src, `${what} awaits ${fn}() with no deadline — a hang has no UI`).toMatch(re);
    });

    it(`${what} turns the deadline into something a person can read`, () => {
      // ActionTimeout's own message is "<label> did not answer within 25000ms",
      // which is a log line, not a sentence for someone holding a card.
      expect(src).toMatch(/instanceof ActionTimeout/);
      expect(src, `${what} surfaces a raw ActionTimeout`).toMatch(/taking longer than expected/);
    });

    it(`${what} keeps the deadline finite and generous`, () => {
      const m = /_DEADLINE_MS\s*=\s*([0-9_]+)/.exec(src);
      expect(m, `${file} has no deadline constant`).toBeTruthy();
      const ms = Number(m![1].replace(/_/g, ""));
      // Long enough for several Stripe round trips on a connected account,
      // short enough that nobody is left holding a card wondering.
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(60_000);
    });
  }

  it("the invoice form offers a way forward once it has failed", () => {
    // This panel opens the card form on its OWN when there is no saved card
    // and no credit, so the person looking at the failure never pressed
    // anything and a toast may already have gone.
    const src = codeOnly(read("src/components/StaffInvoicePayForm.tsx"));
    expect(src).toMatch(/intentM\.isError/);
    expect(src, "no retry affordance after a failure").toMatch(/Try again/);
  });
});
