import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file was failing for weeks and nobody knew, because `npm test` was a
// hand-typed list of 48 filenames and this was not one of them. BUILD-6 added
// `collectedByParent` to the return shape; the two assertions below went stale
// the same day and CI stayed green. The list is gone now — `vitest run` finds
// its own files — and the assertions are fixed.
//
// While fixing them: the BUILD-6 branch itself had no test at all. The half
// that was covered is the ordinary one; the half that decides WHOSE BANK
// ACCOUNT a customer's money lands in was the half nobody exercised.

const h = vi.hoisted(() => ({ rows: [] as any[] }));

// The account lock is its own test
// (a-trial-that-ended-suspends-the-account-for-everyone.test.tsx). Here it is
// open, so the row queue below answers only the Stripe account lookups.
vi.mock("@/lib/account-lock.server", () => ({ refuseChargesIfLocked: async () => {} }));

vi.mock("@/integrations/supabase/client.server", () => {
  // A queue rather than a single row: resolving a franchise location reads the
  // location and then its parent, and a mock that answers both with the same
  // row cannot tell the two branches apart.
  const p: any = {
    select: () => p,
    eq: () => p,
    maybeSingle: () => Promise.resolve({ data: h.rows.shift() ?? null }),
  };
  return { supabaseAdmin: { from: () => p } };
});

import { resolveOrgStripeAccount, requireOrgStripeAccount } from "@/lib/stripe-connect.server";

const ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";
const FRANCHISE = "0b1f2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

beforeEach(() => {
  h.rows = [];
});
afterEach(() => vi.clearAllMocks());

describe("an ordinary org charges into its own account", () => {
  it("returns null when no account is connected", async () => {
    h.rows = [{ stripe_connect_account_id: null, stripe_connect_charges_enabled: false }];
    expect(await resolveOrgStripeAccount(ORG)).toBeNull();
  });

  it("returns the account, charge-readiness, and that this is its own money", async () => {
    h.rows = [{ stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true }];
    expect(await resolveOrgStripeAccount(ORG)).toEqual({
      accountId: "acct_1",
      chargesEnabled: true,
      collectedByParent: false,
    });
  });
});

describe("BUILD-6: a location whose franchise collects", () => {
  it("charges into the FRANCHISE's account, not the location's", async () => {
    // The location has a perfectly good account of its own. It must not be used
    // — the owner's model is that the franchise collects and remits the share.
    h.rows = [
      {
        stripe_connect_account_id: "acct_location",
        stripe_connect_charges_enabled: true,
        parent_organization_id: FRANCHISE,
        payments_collected_by_parent: true,
      },
      { stripe_connect_account_id: "acct_franchise", stripe_connect_charges_enabled: true },
    ];
    expect(await resolveOrgStripeAccount(ORG)).toEqual({
      accountId: "acct_franchise",
      chargesEnabled: true,
      collectedByParent: true,
    });
  });

  it("refuses rather than falling back to the location when the franchise has no account", async () => {
    // The expensive case, and the reason this branch needed a test. A silent
    // fallback here bills the customer into the FRANCHISEE's bank account when
    // the money was supposed to go to the franchise — money in the wrong bank,
    // discovered at reconciliation if ever.
    h.rows = [
      {
        stripe_connect_account_id: "acct_location",
        stripe_connect_charges_enabled: true,
        parent_organization_id: FRANCHISE,
        payments_collected_by_parent: true,
      },
      { stripe_connect_account_id: null, stripe_connect_charges_enabled: false },
    ];
    expect(await resolveOrgStripeAccount(ORG)).toBeNull();
  });

  it("uses the location's own account when the flag is set but there is no parent", async () => {
    // Both halves of the condition are required. A stray flag on a standalone
    // org must not send the resolver looking for a parent that isn't there.
    h.rows = [
      {
        stripe_connect_account_id: "acct_location",
        stripe_connect_charges_enabled: true,
        parent_organization_id: null,
        payments_collected_by_parent: true,
      },
    ];
    expect(await resolveOrgStripeAccount(ORG)).toEqual({
      accountId: "acct_location",
      chargesEnabled: true,
      collectedByParent: false,
    });
  });

  it("uses the location's own account when it has a parent but collects for itself", async () => {
    h.rows = [
      {
        stripe_connect_account_id: "acct_location",
        stripe_connect_charges_enabled: true,
        parent_organization_id: FRANCHISE,
        payments_collected_by_parent: false,
      },
    ];
    expect(await resolveOrgStripeAccount(ORG)).toEqual({
      accountId: "acct_location",
      chargesEnabled: true,
      collectedByParent: false,
    });
  });
});

describe("requireOrgStripeAccount", () => {
  it("throws a connect prompt when no account", async () => {
    h.rows = [{ stripe_connect_account_id: null }];
    await expect(requireOrgStripeAccount(ORG)).rejects.toThrow(/on the Payments page/);
  });

  it("throws when charges aren't enabled yet", async () => {
    h.rows = [{ stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: false }];
    await expect(requireOrgStripeAccount(ORG)).rejects.toThrow(/can't accept charges yet/);
  });

  it("returns the account when charge-ready", async () => {
    h.rows = [{ stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true }];
    expect(await requireOrgStripeAccount(ORG)).toEqual({
      accountId: "acct_1",
      chargesEnabled: true,
      collectedByParent: false,
    });
  });
});
