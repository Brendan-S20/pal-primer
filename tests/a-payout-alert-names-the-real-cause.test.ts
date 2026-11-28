// A payout alert names the real cause (#1075). Production showed:
// "$-2.04 could not be paid out: Your account has insufficient funds to cover
// the transfer.. Payouts stay stopped until the bank details are fixed."
// A minus sign, a double period, and an owner sent to fix bank details that
// were never wrong.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  cleanStripeReason,
  payoutAlert,
  payoutDollars,
  payoutFailedBody,
} from "@/lib/payout-alert";

const LOW_BALANCE = {
  amount: -204,
  failure_code: "insufficient_funds",
  failure_message: "Your account has insufficient funds to cover the transfer.",
};

describe("payout amount", () => {
  it("never prints a minus sign", () => {
    expect(payoutDollars(-204)).toBe("$2.04");
    expect(payoutDollars(204)).toBe("$2.04");
    expect(payoutDollars(null)).toBe("$0.00");
  });
});

describe("a failed payout", () => {
  it("insufficient_funds: says the balance did not cover it, not the bank", () => {
    const body = payoutFailedBody(LOW_BALANCE);
    expect(body).toBe(
      "A $2.04 debit from your bank couldn't go through. Your HoundStack balance didn't " +
        "cover it, so nothing needs changing on the bank side. Stripe tries again once " +
        "the balance is positive. Check Payments.",
    );
    expect(body).not.toContain("-");
    expect(body).not.toContain("..");
    expect(body).not.toMatch(/bank details/i);
  });

  it("insufficient_funds on a positive payout reads as a payout", () => {
    const body = payoutFailedBody({ ...LOW_BALANCE, amount: 204 });
    expect(body.startsWith("A $2.04 payout couldn't go out to your bank.")).toBe(true);
    expect(body).not.toMatch(/bank details/i);
  });

  it("account_closed: tells the owner to fix bank details", () => {
    const body = payoutFailedBody({
      amount: 12500,
      failure_code: "account_closed",
      failure_message: "The bank account has been closed.",
    });
    expect(body).toBe(
      "A $125.00 payout couldn't go out to your bank. Payouts stay stopped until your " +
        "bank details are fixed. Check Payments.",
    );
  });

  it("any other code: Stripe's reason once, one period, and Check Payments", () => {
    const body = payoutFailedBody({
      amount: 500,
      failure_code: "could_not_process",
      failure_message: "The bank could not process this payout.",
    });
    expect(body).toBe(
      "A $5.00 payout couldn't go out to your bank. Stripe says: The bank could not " +
        "process this payout. Check Payments for the reason.",
    );
    expect(body).not.toContain("..");
    expect(body).not.toMatch(/bank details/i);
  });

  it("no code and no message still reads as a sentence", () => {
    expect(payoutFailedBody({ amount: 500 })).toBe(
      "A $5.00 payout couldn't go out to your bank. Check Payments for the reason.",
    );
  });

  it("strips Stripe's own closing punctuation", () => {
    expect(cleanStripeReason("Insufficient funds.. ")).toBe("Insufficient funds");
    expect(cleanStripeReason(undefined)).toBe("");
  });
});

describe("the alert", () => {
  it("failed keeps its type and title", () => {
    const a = payoutAlert(LOW_BALANCE, true);
    expect(a.type).toBe("payout_failed");
    expect(a.title).toBe("A payout failed");
  });

  it("paid keeps today's wording for a normal payout", () => {
    expect(payoutAlert({ amount: 204 }, false)).toEqual({
      type: "payout_paid",
      title: "$2.04 is on its way to your bank",
      body: "$2.04 has been sent to your bank account.",
    });
  });

  it("a paid debit has no minus sign either", () => {
    const a = payoutAlert({ amount: -204 }, false);
    expect(a.title).not.toContain("-");
    expect(a.body).toBe("$2.04 was debited from your bank account.");
  });

  it("the webhook builds its payout alert from this module", () => {
    const src = readFileSync("src/routes/api/public/hooks/stripe.ts", "utf8");
    expect(src).toContain('import("@/lib/payout-alert")');
    expect(src).not.toContain("Payouts stay stopped until the bank details are fixed");
  });
});
