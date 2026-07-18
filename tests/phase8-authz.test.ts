import { describe, expect, it } from "vitest";
import { requirePermission } from "@/lib/authz.server";
import type { AppRole } from "@/hooks/useMyRole";

/**
 * Phase 8 (role security, I7): negative authorization for the server-side gates
 * introduced this phase. Each server fn calls `requirePermission(_, _, <cap>)`;
 * these pin that a WRONG-role principal is rejected at that gate — the same
 * server-side gate the fn runs, not a router redirect.
 *
 *  - DNA compliance registry reads (listDnaMatches / listRegisteredDogs /
 *    listAllDogsForDna / listDnaFormOptions) require `view_client_directory`,
 *    which a technician lacks → tech rejected (H1).
 *  - Client billing data fns (getClientBillingSummary) require
 *    `manage_client_billing`, which a dispatcher lacks → dispatcher rejected (H4).
 *  - The sign-in code reveal (readPortalVerificationCode) requires
 *    `reveal_signin_code`, which only owner/office_manager hold → dispatcher AND
 *    tech rejected (G2).
 */
function stubSupabase(row: { organization_id: string; role: AppRole } | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  };
}

const ORG = "00000000-0000-0000-0000-000000000009";
const sbFor = (role: AppRole) => stubSupabase({ organization_id: ORG, role });

describe("H1 — technician cannot read the DNA compliance registry", () => {
  it("rejects a tech at the view_client_directory gate the DNA read fns use", async () => {
    await expect(
      requirePermission(sbFor("tech"), "u", "view_client_directory"),
    ).rejects.toThrow("Not authorized");
  });

  it("still allows a dispatcher/office_manager/owner to read the registry", async () => {
    for (const role of ["dispatcher", "office_manager", "owner"] as const) {
      await expect(
        requirePermission(sbFor(role), "u", "view_client_directory"),
      ).resolves.toEqual({ orgId: ORG, role });
    }
  });

  it("keeps the tech's sample-logging capability (record_field_addons)", async () => {
    await expect(
      requirePermission(sbFor("tech"), "u", "record_field_addons"),
    ).resolves.toEqual({ orgId: ORG, role: "tech" });
  });
});

describe("H4 — dispatcher cannot read client billing via the data fn", () => {
  it("rejects a dispatcher at the manage_client_billing gate getClientBillingSummary uses", async () => {
    await expect(
      requirePermission(sbFor("dispatcher"), "u", "manage_client_billing"),
    ).rejects.toThrow("Not authorized");
  });

  it("rejects a dispatcher from financial KPIs (view_financials) too", async () => {
    await expect(
      requirePermission(sbFor("dispatcher"), "u", "view_financials"),
    ).rejects.toThrow("Not authorized");
  });

  it("still allows an office_manager to read client billing", async () => {
    await expect(
      requirePermission(sbFor("office_manager"), "u", "manage_client_billing"),
    ).resolves.toEqual({ orgId: ORG, role: "office_manager" });
  });
});

describe("G2 — only owner/office_manager can reveal a sign-in code", () => {
  it("rejects a dispatcher at the reveal_signin_code gate", async () => {
    await expect(
      requirePermission(sbFor("dispatcher"), "u", "reveal_signin_code"),
    ).rejects.toThrow("Not authorized");
  });

  it("rejects a tech at the reveal_signin_code gate", async () => {
    await expect(
      requirePermission(sbFor("tech"), "u", "reveal_signin_code"),
    ).rejects.toThrow("Not authorized");
  });

  it("allows owner and office_manager", async () => {
    for (const role of ["owner", "office_manager"] as const) {
      await expect(
        requirePermission(sbFor(role), "u", "reveal_signin_code"),
      ).resolves.toEqual({ orgId: ORG, role });
    }
  });
});
