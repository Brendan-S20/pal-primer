import { describe, expect, it } from "vitest";
import {
  auditActorLabel,
  auditRowMatches,
  auditSearchTerms,
  impersonationDetail,
} from "@/lib/platform-audit";

// BUG-14 — the impersonation audit trail. Two defects lived here:
//
//   1. The row DISPLAYED the impersonated user's email but the filter did not
//      search it, so looking up "everything we did as bob@…" returned nothing
//      against text visibly on screen.
//   2. Sessions ended by closing the tab produced no stop event at all. Live
//      data: 22 sessions entered, 1 exit recorded. The nightly sweep now closes
//      them — WITHOUT inventing a duration nobody measured.

const enterRow = {
  action: "enter_impersonation",
  organization_name: "Bark Ave Scoopers",
  actor_email: "admin@houndstack.com",
  actor_user_id: "11111111-1111-1111-1111-111111111111",
  after_json: {
    target_user_id: "22222222-2222-2222-2222-222222222222",
    target_email: "bob@barkave.example",
  },
};

const exitedRow = {
  ...enterRow,
  action: "stop_impersonation",
  after_json: { ...enterRow.after_json, duration_seconds: 754 },
};

const sweptRow = {
  ...enterRow,
  action: "stop_impersonation",
  after_json: {
    ...enterRow.after_json,
    ended_reason: "expired",
    duration_seconds: null,
    session_ended_at: "2026-07-28T18:00:00.000Z",
  },
};

describe("audit filter (BUG-14)", () => {
  it("finds a row by the impersonated user it displays", () => {
    // The defect, stated directly.
    expect(auditRowMatches(enterRow, "bob@barkave")).toBe(true);
  });

  it("finds a row by target user id, for events that carry no email", () => {
    const idOnly = {
      ...enterRow,
      after_json: { target_user_id: "22222222-2222-2222-2222-222222222222" },
    };
    expect(auditRowMatches(idOnly, "22222222")).toBe(true);
  });

  it("still matches action, org, and actor", () => {
    expect(auditRowMatches(enterRow, "impersonation")).toBe(true);
    expect(auditRowMatches(enterRow, "bark ave")).toBe(true);
    expect(auditRowMatches(enterRow, "admin@houndstack")).toBe(true);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(auditRowMatches(enterRow, "  BOB@BarkAve  ")).toBe(true);
  });

  it("an empty filter keeps every row", () => {
    expect(auditRowMatches(enterRow, "")).toBe(true);
    expect(auditRowMatches(enterRow, "   ")).toBe(true);
  });

  it("does not match text that appears nowhere on the row", () => {
    expect(auditRowMatches(enterRow, "carol@elsewhere")).toBe(false);
  });

  it("survives a row whose after_json is null or not an object", () => {
    expect(auditRowMatches({ ...enterRow, after_json: null }, "bark ave")).toBe(true);
    expect(auditRowMatches({ ...enterRow, after_json: "oops" }, "bob@")).toBe(false);
    expect(auditSearchTerms({ ...enterRow, after_json: 42 })).not.toContain(undefined);
  });

  it("searches exactly what the row renders — the property that keeps them in step", () => {
    const rendered = impersonationDetail(enterRow)!;
    // Whatever the inline summary shows about the target must be findable.
    expect(rendered).toContain("bob@barkave.example");
    expect(auditRowMatches(enterRow, "bob@barkave.example")).toBe(true);
  });
});

describe("impersonation detail (BUG-14)", () => {
  it("reports a measured duration when the operator clicked Exit", () => {
    expect(impersonationDetail(exitedRow)).toBe("as bob@barkave.example · for 12m 34s");
  });

  it("does NOT invent a duration for a session closed by the sweep", () => {
    const detail = impersonationDetail(sweptRow)!;
    expect(detail).toContain("as bob@barkave.example");
    expect(detail).toContain("ended at the time limit, no exit recorded");
    // The window was an hour; claiming the operator was in there for an hour
    // would be asserting something nobody observed.
    expect(detail).not.toMatch(/\d+m/);
  });

  it("shows just the target for start/enter events, which have no end yet", () => {
    expect(impersonationDetail(enterRow)).toBe("as bob@barkave.example");
  });

  it("renders sub-minute durations without a leading '0m'", () => {
    const quick = { ...exitedRow, after_json: { ...exitedRow.after_json, duration_seconds: 9 } };
    expect(impersonationDetail(quick)).toBe("as bob@barkave.example · for 9s");
  });

  it("returns null for non-impersonation actions", () => {
    expect(
      impersonationDetail({ action: "update_plan", after_json: { target_email: "x" } }),
    ).toBeNull();
  });

  it("returns null rather than an empty fragment when there is nothing to say", () => {
    expect(impersonationDetail({ action: "start_impersonation", after_json: {} })).toBeNull();
    expect(impersonationDetail({ action: "start_impersonation", after_json: null })).toBeNull();
  });
});

// ── Who to credit a row to, once the actor stopped always being a person ────
//
// `platform_admin_audit.actor_user_id` was NOT NULL, and that held while every
// row was a platform admin doing something deliberate. The platform Stripe
// webhook now files `billing_status_change` — the event "Converted this month"
// counts — and a webhook has no actor. Both routes rendered
// `actor_user_id.slice(0, 8)` directly, which a null crashes on, so the label
// moved here to be decided once.
describe("auditActorLabel", () => {
  it("prefers the email, which is what a reader recognises", () => {
    expect(
      auditActorLabel({ actor_email: "admin@houndstack.com", actor_user_id: "8b1f2c3d-…" }),
    ).toBe("admin@houndstack.com");
  });

  it("falls back to a short id when the email lookup failed", () => {
    // getUserById is best-effort and capped at 50 per page; a miss must still
    // identify the actor rather than blame the billing system for their act.
    expect(auditActorLabel({ actor_email: null, actor_user_id: "8b1f2c3d-9999" })).toBe("8b1f2c3d");
  });

  it("names the billing system when nobody did it", () => {
    expect(auditActorLabel({ actor_email: null, actor_user_id: null })).toBe("the billing system");
  });

  it("does not read an empty string as an actor", () => {
    // Not a case the database can produce today. Pinned because "by " with
    // nothing after it is the one output this must never render, and `??`
    // — the obvious way to write this chain — produces exactly that.
    expect(auditActorLabel({ actor_email: "", actor_user_id: null })).toBe("the billing system");
    expect(auditActorLabel({ actor_email: "", actor_user_id: "8b1f2c3d-9999" })).toBe("8b1f2c3d");
  });
});
