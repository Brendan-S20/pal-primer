import { describe, expect, it } from "vitest";
import { hasPermission, ROLE_PERMISSIONS, type Permission } from "@/lib/permissions";

/**
 * The capability matrix IS the security policy — these tests pin it so a
 * future edit that widens a role's grants fails loudly. Each case maps to a
 * QA finding from HoundStack_ClaudeCode_Tasks.md finding #1/#47.
 */
describe("ROLE_PERMISSIONS matrix", () => {
  // Finding #1 — Dispatcher must not edit zone pricing.
  it("denies dispatcher manage_pricing", () => {
    expect(hasPermission("dispatcher", "manage_pricing")).toBe(false);
  });

  // Finding #1 — Dispatcher must not generate/void invoices or add-ons via the Billing tab.
  it("denies dispatcher manage_client_billing", () => {
    expect(hasPermission("dispatcher", "manage_client_billing")).toBe(false);
  });

  // Finding #47 — Dispatcher must not see financial KPIs (dashboard, reports, analytics).
  it("denies dispatcher view_financials", () => {
    expect(hasPermission("dispatcher", "view_financials")).toBe(false);
  });

  // Dispatcher legitimately needs the client directory for dispatch.
  it("allows dispatcher view_client_directory", () => {
    expect(hasPermission("dispatcher", "view_client_directory")).toBe(true);
  });

  // Finding #1 — Technician must not see other clients' names/addresses.
  it("denies tech view_client_directory", () => {
    expect(hasPermission("tech", "view_client_directory")).toBe(false);
  });

  // Finding #1 — Technician must not set DNA fines or mark samples billed.
  it("denies tech manage_dna_billing", () => {
    expect(hasPermission("tech", "manage_dna_billing")).toBe(false);
  });

  it("denies tech manage_client_billing and view_financials", () => {
    expect(hasPermission("tech", "manage_client_billing")).toBe(false);
    expect(hasPermission("tech", "view_financials")).toBe(false);
  });

  // Finding #1 — Technician KEEPS the capped/confirmed field add-on flow.
  it("allows tech record_field_addons", () => {
    expect(hasPermission("tech", "record_field_addons")).toBe(true);
  });

  it("grants owner every permission", () => {
    for (const p of ROLE_PERMISSIONS.owner) {
      expect(hasPermission("owner", p)).toBe(true);
    }
    expect(ROLE_PERMISSIONS.owner.length).toBeGreaterThanOrEqual(14);
  });

  // Finding #1 close-out — office_manager differs from owner by exactly the
  // intended boundary: the org's own SaaS billing and Franchise.
  it("office_manager = owner minus manage_org_billing and manage_franchise", () => {
    const ownerSet = new Set(ROLE_PERMISSIONS.owner);
    const omSet = new Set(ROLE_PERMISSIONS.office_manager);
    const missing = [...ownerSet].filter((p) => !omSet.has(p as Permission));
    expect(missing.sort()).toEqual(["manage_franchise", "manage_org_billing"]);
  });

  it("denies everything for a null role", () => {
    expect(hasPermission(null, "record_field_addons")).toBe(false);
    expect(hasPermission(undefined, "manage_pricing")).toBe(false);
  });
});
