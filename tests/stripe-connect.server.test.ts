import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ row: null as any }));

vi.mock("@/integrations/supabase/client.server", () => {
  const p: any = {
    select: () => p,
    eq: () => p,
    maybeSingle: () => Promise.resolve({ data: h.row }),
  };
  return { supabaseAdmin: { from: () => p } };
});

import { resolveOrgStripeAccount, requireOrgStripeAccount } from "@/lib/stripe-connect.server";

const ORG = "342d4d1e-56f7-4b6e-ad40-524d370e1a36";

beforeEach(() => { h.row = null; });
afterEach(() => vi.clearAllMocks());

describe("resolveOrgStripeAccount", () => {
  it("returns null when no account is connected", async () => {
    h.row = { stripe_connect_account_id: null, stripe_connect_charges_enabled: false };
    expect(await resolveOrgStripeAccount(ORG)).toBeNull();
  });

  it("returns the account + charge-readiness when connected", async () => {
    h.row = { stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true };
    expect(await resolveOrgStripeAccount(ORG)).toEqual({ accountId: "acct_1", chargesEnabled: true });
  });
});

describe("requireOrgStripeAccount", () => {
  it("throws a connect prompt when no account", async () => {
    h.row = { stripe_connect_account_id: null };
    await expect(requireOrgStripeAccount(ORG)).rejects.toThrow(/Settings → Payments/);
  });

  it("throws when charges aren't enabled yet", async () => {
    h.row = { stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: false };
    await expect(requireOrgStripeAccount(ORG)).rejects.toThrow(/can't accept charges yet/);
  });

  it("returns the account when charge-ready", async () => {
    h.row = { stripe_connect_account_id: "acct_1", stripe_connect_charges_enabled: true };
    expect(await requireOrgStripeAccount(ORG)).toEqual({ accountId: "acct_1", chargesEnabled: true });
  });
});
