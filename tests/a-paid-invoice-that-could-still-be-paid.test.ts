import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Marking an invoice paid out of band -- a cheque, cash at the door -- says the
// money is collected. It does NOT, on its own, stop the customer paying again.
//
// `bulkMarkInvoicesPaid` mints nothing, but the pay page already did: the
// PaymentIntent on the connected account stays confirmable until somebody
// cancels it, and the client may have that tab open. The function tries to
// cancel it and deliberately does not throw, so a Stripe outage cannot block
// recording a cheque. That trade is right.
//
// What was wrong is what happened next. The cancel lived in a try/catch that
// only logged, and then `ok++` ran regardless -- so a run where the intent
// survived reported exactly the same "Marked 12 paid" as a clean one. The
// office had no way to know, and the consequence is spelled out in the
// function's own comment: the Stripe webhook's guard is `inv.status !== "paid"`,
// this invoice now IS paid, so a second charge is skipped entirely. No payments
// row, no receipt, no activity entry, no refund. The money leaves the
// customer's account and exists nowhere in this system.
//
// So the failure is now COUNTED and RETURNED, and both call sites say so. These
// invoices are still `ok` -- they are genuinely paid, and calling them failures
// would be a different lie -- which is exactly why the signal needs its own
// name rather than being folded into `failed`.

const FN = readFileSync(join(process.cwd(), "src/lib/invoices.functions.ts"), "utf8");
const PAGE = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/invoices.index.tsx"),
  "utf8",
);

/** `bulkMarkInvoicesPaid`'s body, comments stripped so prose cannot satisfy a check. */
function markPaidBody(): string {
  const code = FN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const start = code.indexOf("export const bulkMarkInvoicesPaid =");
  expect(start, "bulkMarkInvoicesPaid is not exported").toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const next = rest.indexOf("\nexport const ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("a surviving payment intent is reported, not logged", () => {
  const body = markPaidBody();

  it("records the invoice whose intent could not be cancelled", () => {
    expect(body).toMatch(/intentStillLive\.push\(/);
  });

  it("returns that list to the caller", () => {
    expect(body).toMatch(/return \{[^}]*intentStillLive[^}]*\}/);
  });

  it("still counts the invoice as paid, because it is", () => {
    // The mutation this guards: "fixing" this by moving ok++ into an else, or
    // incrementing `failed`. The invoice IS paid -- the row is correct and the
    // money was collected. Calling it a failure would send the office chasing a
    // payment it already has, and would hide the real problem behind a wrong one.
    expect(body).toMatch(/intentStillLive\.push\([^)]*\);\s*\}\s*ok\+\+;/);
    expect(body).not.toMatch(/intentStillLive\.push\([^)]*\);\s*failed\+\+/);
  });

  it("does not throw on a cancellation failure", () => {
    // The other direction. Throwing would mean a Stripe outage blocks recording
    // a cheque that is already in the till.
    const guarded = body.slice(body.indexOf("syncInvoicePaymentIntentAmount"));
    expect(guarded).toMatch(/catch\s*\(/);
    expect(guarded.slice(0, guarded.indexOf("ok++"))).not.toMatch(/\bthrow\b/);
  });
});

describe("and both call sites tell somebody", () => {
  it("the bulk action warns, separately from its skipped count", () => {
    expect(PAGE).toMatch(/r\.intentStillLive\?\.length/);
    expect(PAGE).toMatch(/still have a live payment link|still \$\{n === 1 \? "has" : "have"\} a live payment link/);
  });

  it("the single-row action warns too", () => {
    // A one-invoice mark-paid goes through the same server fn with one id. It
    // would be easy to wire the warning only into the bulk path and leave the
    // per-row button silent, which is the one people actually press.
    const rowBlock = PAGE.slice(PAGE.indexOf("const rowPaidM"));
    expect(rowBlock.slice(0, rowBlock.indexOf("const rowVoidM"))).toMatch(
      /intentStillLive/,
    );
  });

  it("says what to do about it, not just that it happened", () => {
    // "Cancel it in Stripe" is the whole point: the office has a window in
    // which it can still stop the second charge, and a warning that does not
    // name the action wastes it.
    expect(PAGE).toMatch(/Cancel .{0,20}in Stripe/);
  });

  it("holds the warning on screen longer than a default toast", () => {
    const i = PAGE.indexOf("live payment link");
    expect(i).toBeGreaterThan(-1);
    expect(PAGE.slice(i, i + 400)).toMatch(/duration:\s*15000/);
  });
});
