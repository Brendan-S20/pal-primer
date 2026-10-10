import { describe, expect, it } from "vitest";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import type { AppRole } from "@/hooks/useMyRole";

/** Minimal stub of the supabase client shape requirePermission touches. */
function stubSupabase(row: { organization_id: string; role: AppRole } | null, error?: string) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: error ? { message: error } : null }),
        }),
      }),
    }),
    // access_turned_off(): nobody here is turned off (tests/off-means-off.test.ts).
    rpc: async () => ({ data: [], error: null }),
  };
}

const ORG = "00000000-0000-0000-0000-000000000001";

describe("requirePermission (the server-side gate)", () => {
  it("rejects a dispatcher for manage_pricing", async () => {
    const sb = stubSupabase({ organization_id: ORG, role: "dispatcher" });
    await expect(requirePermission(sb, "u1", "manage_pricing")).rejects.toThrow("Not authorized");
  });

  it("rejects a dispatcher for manage_client_billing", async () => {
    const sb = stubSupabase({ organization_id: ORG, role: "dispatcher" });
    await expect(requirePermission(sb, "u1", "manage_client_billing")).rejects.toThrow(
      "Not authorized",
    );
  });

  it("rejects a tech for manage_dna_billing", async () => {
    const sb = stubSupabase({ organization_id: ORG, role: "tech" });
    await expect(requirePermission(sb, "u1", "manage_dna_billing")).rejects.toThrow(
      "Not authorized",
    );
  });

  it("allows an office_manager for manage_client_billing and returns org context", async () => {
    const sb = stubSupabase({ organization_id: ORG, role: "office_manager" });
    await expect(requirePermission(sb, "u1", "manage_client_billing")).resolves.toEqual({
      orgId: ORG,
      role: "office_manager",
    });
  });

  it("allows a tech for record_field_addons", async () => {
    const sb = stubSupabase({ organization_id: ORG, role: "tech" });
    await expect(requirePermission(sb, "u1", "record_field_addons")).resolves.toEqual({
      orgId: ORG,
      role: "tech",
    });
  });

  it("rejects a user with no organization", async () => {
    const sb = stubSupabase(null);
    await expect(requirePermission(sb, "u1", "record_field_addons")).rejects.toThrow(
      "No organization",
    );
  });

  it("propagates database errors", async () => {
    const sb = stubSupabase(null, "connection refused");
    await expect(resolveCaller(sb, "u1")).rejects.toThrow("connection refused");
  });
});
