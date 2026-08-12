import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_LOCATION_ROLE,
  LOCATION_MEMBER_ROLES,
  MAX_LOCATION_MEMBERS,
  ROLE_LABEL,
  filledMembers,
  locationProblem,
  type LocationMemberInput,
} from "@/lib/provision-location";
import { TRIAL_DAYS } from "@/lib/trial";

// BUILD-6. The rules for opening a franchise location live in three layers —
// this module, a zod schema, and provision_franchise_location. What is worth
// pinning is not "does the form validate" but the two places where a silent
// disagreement between those layers costs something real:
//
//   1. A location that ends up with no owner is an organization NOBODY in the
//      product can reach, including the franchise that created it, and there is
//      no repair path short of a platform admin.
//   2. A location that starts without a trial is free forever — the whole
//      reason 20260731160000 exists.

const SQL = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260731160000_a-provisioned-location-is-a-real-account.sql",
  ),
  "utf8",
);

const m = (email: string, role: LocationMemberInput["role"] = "tech"): LocationMemberInput => ({
  email,
  role,
});
const owner = m("boss@example.com", "owner");

describe("a location must have an owner", () => {
  it("refuses a list of staff with nobody in charge", () => {
    expect(locationProblem("North Austin", [m("a@example.com"), m("b@example.com")])).toMatch(
      /owner/i,
    );
  });

  it("refuses an empty list", () => {
    expect(locationProblem("North Austin", [])).not.toBeNull();
    expect(locationProblem("North Austin", [m("")])).not.toBeNull();
  });

  it("accepts one owner and nobody else", () => {
    // The common case: the franchise opens a location and the operator hires
    // their own crew. Demanding more people would be inventing a requirement.
    expect(locationProblem("North Austin", [owner])).toBeNull();
  });

  it("is the same rule the database enforces", () => {
    // If the SQL guard is ever removed, this module would happily let a form
    // through that creates an unreachable organization.
    expect(SQL).toMatch(/WHERE e\.value->>'role' = 'owner'/);
    expect(SQL).toMatch(/Name someone as the owner of this location/);
  });
});

describe("a location starts a trial like any other account", () => {
  it("sets trialing and an end date in the INSERT", () => {
    // Not an UPDATE afterwards: organizations.plan_status defaults to 'free',
    // so any window between the two is an org that reads as free.
    expect(SQL).toMatch(
      /INSERT INTO public\.organizations \(name, timezone, plan_status, trial_ends_at\)/,
    );
    expect(SQL).toMatch(/'trialing'::public\.org_plan_status/);
  });

  it("uses the same 14 days the marketing site sells", () => {
    // Third copy of this constant (app, bootstrap's SQL, this SQL). A drift
    // means a franchise location gets a different trial than a direct signup
    // for no reason anyone chose.
    const found = SQL.match(/_trial_days\s+constant\s+int\s*:=\s*(\d+)/);
    expect(found).not.toBeNull();
    expect(Number(found![1])).toBe(TRIAL_DAYS);
  });
});

describe("duplicate addresses are refused, not merged", () => {
  it("catches the same person twice under different roles", () => {
    // Merging would silently demote the owner to tech and then fail the owner
    // check for a reason nobody could see. Verified against the live function
    // before shipping.
    expect(
      locationProblem("North Austin", [m("Boss@Example.com", "owner"), m("boss@example.com")]),
    ).toMatch(/more than once/i);
  });

  it("is case- and whitespace-insensitive, like the database", () => {
    expect(locationProblem("N", [owner, m("  A@Ex.com "), m("a@ex.com")])).toMatch(
      /more than once/i,
    );
    expect(SQL).toMatch(/lower\(btrim\(m\.value->>'email'\)\)/);
    expect(SQL).toMatch(/listed more than once/);
  });
});

describe("what the form sends", () => {
  it("drops blank rows and normalises the rest", () => {
    expect(filledMembers([m("  Boss@Example.com ", "owner"), m("   "), m("T@x.io")])).toEqual([
      { email: "boss@example.com", role: "owner" },
      { email: "t@x.io", role: "tech" },
    ]);
  });

  it("wants a name", () => {
    expect(locationProblem("   ", [owner])).toMatch(/name/i);
  });

  it("catches an address that obviously is not one", () => {
    expect(locationProblem("N", [owner, m("nope")])).toMatch(/email address/i);
  });

  it("caps the list", () => {
    const many = [
      owner,
      ...Array.from({ length: MAX_LOCATION_MEMBERS }, (_, i) => m(`t${i}@x.io`)),
    ];
    expect(locationProblem("N", many)).toMatch(new RegExp(String(MAX_LOCATION_MEMBERS)));
  });
});

describe("platform access cannot be granted through a staff list", () => {
  it("is not an offerable role", () => {
    expect(LOCATION_MEMBER_ROLES as readonly string[]).not.toContain(FORBIDDEN_LOCATION_ROLE);
  });

  it("is refused by the database independently", () => {
    // The zod enum already makes it unreachable from the app; this asserts the
    // RPC — which is granted to `authenticated` and therefore callable
    // directly — refuses it too.
    expect(SQL).toMatch(/A location cannot be given platform-admin access/);
  });

  it("labels every role it does offer", () => {
    for (const role of LOCATION_MEMBER_ROLES) expect(ROLE_LABEL[role]).toBeTruthy();
  });
});
