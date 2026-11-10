// Brendan, 2026-11-09 (on #748): once a trial has ended with no active
// subscription the account is suspended. Non-owners see the banner
// ("This account's trial has ended. Ask the owner to subscribe.") and cannot
// run the account; the business takes no payments; the owner still reaches
// billing to subscribe. Enforced on the server, not only in the UI.
//
// The four cases asked for, one describe each:
//   owner during trial · owner after trial · non-owner after trial · paying.
//
// The account lock itself (NP-12) is tested in
// a-locked-account-reaches-the-plan-picker-and-nothing-else.test.ts; this file
// is about who sees what, and about payments that arrive WITHOUT a staff token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("@/components/PageShell", () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { AccountLockedShell } from "@/components/AccountLockedShell";
import { nonOwnerEndedNotice, shownToRole } from "@/components/TrialBanner";
import {
  BUSINESS_PAYMENTS_PAUSED_MESSAGE,
  PAYMENTS_LOCKED_MESSAGE,
  accountLockFor,
  nonOwnerLockedNotice,
  pathOpenWhenLocked,
  type AccountLock,
} from "@/lib/account-lock";
import {
  forgetAccountLocks,
  refuseChargesIfLocked,
  refuseIfLocked,
} from "@/lib/account-lock.server";
import { trialStateFor } from "@/lib/trial";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NOW = new Date("2026-11-09T12:00:00Z");

const org = {
  plan_status: "trialing",
  billing_status: "free",
  trial_ends_at: "2026-11-20T00:00:00Z",
  stripe_subscription_id: null,
  created_at: "2026-11-06T00:00:00Z",
  is_comped: false,
  current_period_end: null,
  suspended_at: null,
};
const trialing = org;
const ended = { ...org, trial_ends_at: "2026-11-01T00:00:00Z", created_at: "2026-10-18T00:00:00Z" };
const paying = {
  ...ended,
  plan_status: "active",
  billing_status: "active",
  stripe_subscription_id: "sub_1",
};

const stateOf = (o: typeof org) =>
  trialStateFor(
    {
      planStatus: o.plan_status,
      billingStatus: o.billing_status,
      trialEndsAt: o.trial_ends_at,
      hasSubscription: !!o.stripe_subscription_id,
      createdAt: o.created_at,
    },
    NOW,
  );

// A staff call, as the server-function middleware sees it.
const bearer = `Bearer x.${Buffer.from(JSON.stringify({ sub: "user-1" })).toString("base64url")}.y`;
const fn = (file: string, name: string) => ({ filename: file, name });
const ACTIONS = [
  fn("src/lib/routes.functions.ts", "optimizeRoute"),
  fn("src/lib/visits.functions.ts", "completeVisit"),
  fn("src/lib/invoices.functions.ts", "createManualInvoice"),
  // Take payment, on the invoice and on a visit.
  fn("src/lib/invoices.functions.ts", "createInvoicePaymentIntent"),
  fn("src/lib/invoices.functions.ts", "chargeAutopayForInvoice"),
];
const BILLING = fn("src/lib/billing.functions.ts", "createPlanCheckout");

const staffCall = (lock: AccountLock, meta: { filename: string; name: string }) =>
  refuseIfLocked({ authorization: bearer, meta, now: NOW, lookup: async () => ({ lock }) });

const shell = (lock: Extract<AccountLock, { locked: true }>, canChoosePlan: boolean) =>
  renderToStaticMarkup(
    <AccountLockedShell reason={lock.reason} canChoosePlan={canChoosePlan} onSignOut={() => {}}>
      <p>BILLING PAGE</p>
      <button>Take payment</button>
    </AccountLockedShell>,
  );

beforeEach(() => forgetAccountLocks());

describe("owner during the trial", () => {
  it("is not locked, sees the countdown, and every action and payment is allowed", async () => {
    const lock = accountLockFor(trialing, NOW);
    expect(lock.locked).toBe(false);
    expect(shownToRole({ phase: stateOf(trialing).phase, canManageBilling: true })).toBe(true);
    for (const a of ACTIONS) await expect(staffCall(lock, a)).resolves.toBeUndefined();
    await expect(
      refuseChargesIfLocked("org-1", { lookup: async () => lock }),
    ).resolves.toBeUndefined();
  });

  it("a non-owner is not shown the owner's countdown while the trial runs", () => {
    expect(shownToRole({ phase: stateOf(trialing).phase, canManageBilling: false })).toBe(false);
    expect(nonOwnerEndedNotice(stateOf(trialing).phase)).toBeNull();
  });
});

describe("owner after the trial has ended", () => {
  const lock = accountLockFor(ended, NOW) as Extract<AccountLock, { locked: true }>;

  it("is locked as a trial that ended", () => {
    expect(lock).toMatchObject({ locked: true, reason: "trial_ended" });
  });

  it("still reaches Plan & billing to subscribe, on the page and on the server", async () => {
    expect(pathOpenWhenLocked("/settings/billing")).toBe(true);
    await expect(staffCall(lock, BILLING)).resolves.toBeUndefined();
    const html = shell(lock, true);
    expect(html).toContain("BILLING PAGE");
    expect(html).toContain("Your free trial has ended");
  });

  it("cannot run routes, visits, invoicing or Take payment", async () => {
    for (const a of ACTIONS) await expect(staffCall(lock, a)).rejects.toThrow(/locked/i);
    expect(pathOpenWhenLocked("/routes")).toBe(false);
    expect(pathOpenWhenLocked("/invoices")).toBe(false);
  });
});

describe("non-owner after the trial has ended", () => {
  const lock = accountLockFor(ended, NOW) as Extract<AccountLock, { locked: true }>;

  it("sees the one-line banner, and nothing of the workspace beneath it", () => {
    const html = shell(lock, false);
    expect(html).toContain("This account&#x27;s trial has ended. Ask the owner to subscribe.");
    expect(html).not.toContain("BILLING PAGE");
    expect(html).not.toContain("Take payment");
    // Not the owner's instruction, which they cannot follow.
    expect(html).not.toContain("Choose a plan");
  });

  it("says plan, not trial, when a paid plan is what ended", () => {
    expect(nonOwnerLockedNotice("plan_ended")).toBe(
      "This account's plan has ended. Ask the owner to subscribe.",
    );
    expect(nonOwnerEndedNotice("lapsed")).toBe(nonOwnerLockedNotice("plan_ended"));
  });

  it("the trial banner speaks the same words where an ended trial is not locked", () => {
    expect(shownToRole({ phase: "expired", canManageBilling: false })).toBe(true);
    expect(nonOwnerEndedNotice("expired")).toBe(
      "This account's trial has ended. Ask the owner to subscribe.",
    );
  });

  it("is refused every action on the server, not only hidden in the UI", async () => {
    for (const a of ACTIONS) await expect(staffCall(lock, a)).rejects.toThrow(/locked/i);
  });
});

describe("the business takes no payments while locked", () => {
  const lock = accountLockFor(ended, NOW);

  it("refuses a charge for staff and for a customer, in words for each", async () => {
    await expect(refuseChargesIfLocked("org-1", { lookup: async () => lock })).rejects.toThrow(
      PAYMENTS_LOCKED_MESSAGE,
    );
    await expect(
      refuseChargesIfLocked("org-1", { audience: "customer", lookup: async () => lock }),
    ).rejects.toThrow(BUSINESS_PAYMENTS_PAUSED_MESSAGE);
    // A customer is not told about the business's own bill.
    expect(BUSINESS_PAYMENTS_PAUSED_MESSAGE).not.toMatch(/trial|plan|subscri|HoundStack/i);
  });

  it("does not stop every business being paid when the lookup fails", async () => {
    await expect(
      refuseChargesIfLocked("org-1", {
        lookup: async () => {
          throw new Error("db down");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("is checked by requireOrgStripeAccount, before any account is looked up", () => {
    const src = read("src/lib/stripe-connect.server.ts");
    const body = src.slice(src.indexOf("export async function requireOrgStripeAccount"));
    const guard = body.indexOf("await refuseChargesIfLocked(orgId");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("resolveOrgStripeAccount(orgId)"));
  });

  it("covers the payments that arrive with no staff token", () => {
    // The public invoice link, the booking link's prepay and the portal all
    // charge through requireOrgStripeAccount.
    const invoices = read("src/lib/invoices.functions.ts");
    const pub = invoices.slice(invoices.indexOf("export const createPublicInvoicePaymentIntent"));
    expect(pub).toMatch(
      /requireOrgStripeAccount\(invoice\.organization_id, \{ audience: "customer" \}\)/,
    );
    expect(read("src/lib/signup.functions.ts")).toMatch(
      /requireOrgStripeAccount\(q\.organization_id/,
    );
    // Nightly autopay resolves the account itself, so it asks the lock itself.
    const nightly = read("src/routes/api/public/hooks/nightly.ts");
    const autopay = nightly.slice(nightly.indexOf("async function runAutopayForOrg"));
    expect(autopay.slice(0, autopay.indexOf("paymentIntents.create"))).toMatch(
      /lockForOrg\(orgId\)/,
    );
  });
});

describe("an active subscription", () => {
  it("is normal: not locked, no banner, every action and payment allowed", async () => {
    const lock = accountLockFor(paying, NOW);
    expect(lock.locked).toBe(false);
    expect(stateOf(paying).phase).toBe("paid");
    expect(shownToRole({ phase: "paid", canManageBilling: true })).toBe(false);
    expect(shownToRole({ phase: "paid", canManageBilling: false })).toBe(false);
    for (const a of ACTIONS) await expect(staffCall(lock, a)).resolves.toBeUndefined();
    await expect(
      refuseChargesIfLocked("org-1", { audience: "customer", lookup: async () => lock }),
    ).resolves.toBeUndefined();
  });
});
