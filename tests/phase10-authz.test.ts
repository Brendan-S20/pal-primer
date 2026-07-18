import { describe, expect, it } from "vitest";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import type { AppRole } from "@/hooks/useMyRole";

/**
 * Phase 10 (server-side authorization sweep, I7 / section E). The sweep audited
 * every exported createServerFn; these pin the gates ADDED this phase to close
 * gaps where a below-role token could reach office / financial / settings data.
 * Each block names the server fn(s) that now call requirePermission(_,_,<cap>)
 * and asserts a wrong-role principal is rejected AT THAT GATE (the same
 * server-side check the fn runs — not a router redirect), and that the intended
 * roles still pass.
 *
 * Gaps fixed this phase and their caps:
 *  - promotions.upsertPromoCode / deletePromoCode / createGiftCard /
 *    voidGiftCard, skip-rules.upsertSkipRule, blackouts.addBlackout /
 *    deleteBlackout, accounting-oauth.startAccountingOAuth,
 *    org.recordSmsConsent  → manage_settings (owner/office_manager only)
 *  - users.setStaffAddresses → manage_users
 *  - churn.scoreChurnHeuristic / listAtRiskClients / sendWinBack → view_financials
 *  - messages.listMessageThreads / listClientMessages / sendSmsToClient,
 *    reviews.getReferralStats → view_client_directory (dispatcher/office/owner;
 *    techs rejected)
 *  - neighbors.seedNeighborsForClient → view_client_directory (reads a client's
 *    property address to canvass around it), but the individual-lead writes
 *    (add/update/deleteNeighborLead) require only org membership: door-to-door
 *    canvassing is a FIELD activity techs perform in Walk mode, so those pass
 *    for tech and reject only a caller with no org.
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

const ORG = "00000000-0000-0000-0000-00000000000a";
const sbFor = (role: AppRole) => stubSupabase({ organization_id: ORG, role });

async function rejects(role: AppRole, cap: Parameters<typeof requirePermission>[2]) {
  await expect(requirePermission(sbFor(role), "u", cap)).rejects.toThrow("Not authorized");
}
async function allows(role: AppRole, cap: Parameters<typeof requirePermission>[2]) {
  await expect(requirePermission(sbFor(role), "u", cap)).resolves.toEqual({ orgId: ORG, role });
}

describe("settings-write fns reject tech AND dispatcher (manage_settings)", () => {
  it("rejects tech and dispatcher; allows owner and office_manager", async () => {
    await rejects("tech", "manage_settings");
    await rejects("dispatcher", "manage_settings");
    await allows("owner", "manage_settings");
    await allows("office_manager", "manage_settings");
  });
});

describe("users.setStaffAddresses now matches setStaffRouting (manage_users)", () => {
  it("rejects dispatcher and tech; allows owner/office_manager", async () => {
    await rejects("dispatcher", "manage_users");
    await rejects("tech", "manage_users");
    await allows("owner", "manage_users");
    await allows("office_manager", "manage_users");
  });
});

describe("churn fns are financial (view_financials)", () => {
  it("rejects dispatcher and tech; allows owner/office_manager", async () => {
    await rejects("dispatcher", "view_financials");
    await rejects("tech", "view_financials");
    await allows("owner", "view_financials");
    await allows("office_manager", "view_financials");
  });
});

describe("client-directory reads reject techs but keep dispatcher (view_client_directory)", () => {
  it("rejects tech; still allows dispatcher/office_manager/owner", async () => {
    await rejects("tech", "view_client_directory");
    await allows("dispatcher", "view_client_directory");
    await allows("office_manager", "view_client_directory");
    await allows("owner", "view_client_directory");
  });
});

describe("neighbor leads: seed is directory-gated, individual writes are field work", () => {
  // seedNeighborsForClient reads a client's property address, so it stays on
  // view_client_directory and rejects techs.
  it("seed rejects tech, allows dispatcher and up", async () => {
    await rejects("tech", "view_client_directory");
    await allows("dispatcher", "view_client_directory");
  });

  // add/update/deleteNeighborLead only resolveCaller() — org membership. A tech
  // in Walk mode CAN log/update/remove a door; the only rejection is a caller
  // with no organization at all.
  it("individual-lead writes resolve for a tech (org membership only)", async () => {
    await expect(resolveCaller(sbFor("tech"), "u")).resolves.toEqual({ orgId: ORG, role: "tech" });
  });

  it("individual-lead writes reject a caller with no org", async () => {
    await expect(resolveCaller(stubSupabase(null), "u")).rejects.toThrow("No organization for user");
  });
});
