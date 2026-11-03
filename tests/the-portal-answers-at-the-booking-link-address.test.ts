// R2-48: a training business saved its booking link as `steady-paws`; its
// portal address had been set to `steady-paws-in-home-training`. The settings
// page says "The form accepts either", but /portal/steady-paws said "Company
// not found". The portal sign-in now resolves the booking-link address too,
// with the portal address winning a tie.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  orgs: [] as Array<Record<string, unknown>>,
  lookups: [] as Array<[string, string]>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = () => {
    let col = "";
    let val = "";
    const q: any = {
      select: () => q,
      eq: (c: string, v: string) => {
        col = c;
        val = v;
        return q;
      },
      maybeSingle: () => {
        h.lookups.push([col, val]);
        return Promise.resolve({ data: h.orgs.find((o) => o[col] === val) ?? null });
      },
    };
    return q;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/account-lock.server", () => ({
  lockForOrg: async () => ({ locked: false }),
}));

import { orgBrandingBySlug } from "@/lib/portal-auth.server";

const STEADY = {
  id: "org-steady",
  name: "Steady Paws In-Home Training",
  slug: "steady-paws",
  portal_slug: "steady-paws-in-home-training",
  logo_url: null,
  brand_color: null,
  timezone: "America/Denver",
};

beforeEach(() => {
  h.orgs = [STEADY];
  h.lookups = [];
});

describe("the portal sign-in finds a business by either address", () => {
  it("by its portal address", async () => {
    const org = await orgBrandingBySlug("steady-paws-in-home-training");
    expect(org?.organizationId).toBe("org-steady");
    expect(h.lookups).toEqual([["portal_slug", "steady-paws-in-home-training"]]);
  });

  it("by its booking-link address, and hands back the portal address to redirect to", async () => {
    const org = await orgBrandingBySlug("steady-paws");
    expect(org?.organizationId).toBe("org-steady");
    expect(org?.orgSlug).toBe("steady-paws-in-home-training");
    expect(h.lookups).toEqual([
      ["portal_slug", "steady-paws"],
      ["slug", "steady-paws"],
    ]);
  });

  it("prefers the business whose PORTAL address it is on a tie", async () => {
    h.orgs = [
      { ...STEADY, id: "org-link-owner", slug: "paws", portal_slug: "other" },
      { ...STEADY, id: "org-portal-owner", slug: null, portal_slug: "paws" },
    ];
    expect((await orgBrandingBySlug("paws"))?.organizationId).toBe("org-portal-owner");
  });

  it("still says not found for an address nobody has", async () => {
    expect(await orgBrandingBySlug("nobody-here")).toBeNull();
  });
});
