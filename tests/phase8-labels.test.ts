import { describe, expect, it } from "vitest";
import { humanizeAuditAction } from "@/lib/humanize";
import { YARD_SIZE_LABELS } from "@/lib/yard-size";

/**
 * Phase 8 humanized-label maps (I3 — kill raw enums in the UI): the audit log,
 * the tech field cards' yard sizes, etc. must never render snake_case tokens.
 */
describe("humanizeAuditAction (platform audit log — H2)", () => {
  it("maps impersonation event enums to product copy (no raw snake_case)", () => {
    expect(humanizeAuditAction("start_impersonation")).toBe("Started impersonation");
    expect(humanizeAuditAction("enter_impersonation")).toBe("Entered impersonation session");
    expect(humanizeAuditAction("stop_impersonation")).toBe("Ended impersonation");
  });

  it("maps other admin actions and never leaves underscores for unmapped ones", () => {
    expect(humanizeAuditAction("update_org_plan")).toBe("Updated plan");
    // Unmapped → generic humanizeEnum, still no raw underscores.
    expect(humanizeAuditAction("some_new_event")).not.toContain("_");
    expect(humanizeAuditAction(null)).toBe("-");
  });
});

describe("yard size labels (tech field card — H1)", () => {
  it("humanizes the raw tokens techs were seeing ('xlarge', 'medium')", () => {
    expect(YARD_SIZE_LABELS.xlarge).toBe("Extra large");
    expect(YARD_SIZE_LABELS.medium).toBe("Medium");
    expect(YARD_SIZE_LABELS.small).toBe("Small");
    expect(YARD_SIZE_LABELS.large).toBe("Large");
    // No label is itself a raw token.
    for (const v of Object.values(YARD_SIZE_LABELS)) {
      expect(v).not.toMatch(/^[a-z]+$/);
    }
  });
});
