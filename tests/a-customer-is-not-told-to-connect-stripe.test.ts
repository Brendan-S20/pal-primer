// R2-42: the portal's card-on-file link, for a business with no Stripe
// account, showed the customer "This business hasn't connected a Stripe
// account yet. Connect one on the Payments page." That is an instruction to
// the owner. The portal and the booking link now ask for the customer's
// wording, and the staff screens keep theirs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@/integrations/supabase/client.server", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a chainable query stub
  const p: any = {
    select: () => p,
    eq: () => p,
    maybeSingle: () => Promise.resolve({ data: h.rows.shift() ?? null }),
  };
  return { supabaseAdmin: { from: () => p } };
});

import { CUSTOMER_CARDS_UNAVAILABLE, requireOrgStripeAccount } from "@/lib/stripe-connect.server";

const ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";

beforeEach(() => {
  h.rows = [];
});
afterEach(() => vi.clearAllMocks());

describe("the customer's wording", () => {
  it("names no page and no Stripe when nothing is connected", async () => {
    h.rows = [{ stripe_connect_account_id: null }];
    const err = await requireOrgStripeAccount(ORG, { audience: "customer" }).catch((e) => e);
    expect(err.message).toBe(CUSTOMER_CARDS_UNAVAILABLE);
    expect(err.message).not.toMatch(/Stripe|Payments page|Connect one/);
  });

  it("says the same when the account can't charge yet", async () => {
    h.rows = [{ stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: false }];
    await expect(requireOrgStripeAccount(ORG, { audience: "customer" })).rejects.toThrow(
      CUSTOMER_CARDS_UNAVAILABLE,
    );
  });

  it("says the same for a franchise location, and does not ask the customer to chase the franchise", async () => {
    h.rows = [
      { payments_collected_by_parent: true, parent_organization_id: "p1" },
      { stripe_connect_account_id: null },
    ];
    await expect(requireOrgStripeAccount(ORG, { audience: "customer" })).rejects.toThrow(
      CUSTOMER_CARDS_UNAVAILABLE,
    );
  });

  it("still returns a charge-ready account", async () => {
    h.rows = [{ stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true }];
    expect(await requireOrgStripeAccount(ORG, { audience: "customer" })).toMatchObject({
      accountId: "acct_1",
    });
  });

  it("has no em dash", () => {
    expect(CUSTOMER_CARDS_UNAVAILABLE).not.toContain("—");
  });
});

describe("the owner's wording is unchanged", () => {
  it("still points staff at the Payments page", async () => {
    h.rows = [{ stripe_connect_account_id: null }];
    await expect(requireOrgStripeAccount(ORG)).rejects.toThrow(/on the Payments page/);
  });
});

describe("every customer-facing charge site asks for the customer's wording", () => {
  // portal.functions.ts is the customer portal from top to bottom, and the
  // signup charge is the booking link. Staff files are not listed.
  for (const f of ["src/lib/portal.functions.ts", "src/lib/signup.functions.ts"]) {
    it(f, () => {
      const src = readFileSync(f, "utf8");
      const calls = src.match(/await requireOrgStripeAccount\([^)]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c, c).toContain('audience: "customer"');
    });
  }
});
