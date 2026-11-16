// A teammate who left is listed as "Left", with the date, and can be invited
// back (#938).
//
// Leaving (leave_business_i_was_turned_off_in, #765) deletes one user_roles
// row and keeps the staff row. Settings -> Users drew only from user_roles
// (list_org_users), so the person vanished. These pin the rule that finds
// them again, the page that draws them, and the plain sentence somebody who
// now runs their own business reads instead of "leave it first".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { leftLabel, leftTeammates } from "@/lib/team-left";
import { otherOrgReason } from "@/lib/invite-copy";

const ORG_ROW = (o: Partial<Parameters<typeof leftTeammates>[0]["staff"][number]>) => ({
  id: "s",
  user_id: null,
  display_name: null,
  email: null,
  role: "tech",
  active: false,
  created_at: "2026-01-01T00:00:00Z",
  ...o,
});

describe("who has left (#938)", () => {
  it("is a turned-off staff row whose login has no membership here, dated by staff.left", () => {
    const left = leftTeammates({
      memberUserIds: ["owner", "on", "off"],
      staff: [
        ORG_ROW({ id: "s-owner", user_id: "owner", active: true }),
        ORG_ROW({ id: "s-on", user_id: "on", active: true }),
        // Turned off but still a member: Turned off, not Left.
        ORG_ROW({ id: "s-off", user_id: "off" }),
        // Left.
        ORG_ROW({ id: "s-left", user_id: "left", display_name: "Pat", email: "pat@x.test" }),
        // Never had a login: a crew member on the board, not somebody who left.
        ORG_ROW({ id: "s-crew", user_id: null, display_name: "Crew" }),
      ],
      leftEvents: [
        { created_at: "2026-11-01T00:00:00Z", meta: { user_id: "left" } },
        { created_at: "2026-11-12T16:20:00Z", meta: { user_id: "left" } },
        { created_at: "2026-11-13T00:00:00Z", meta: { user_id: "someone-else" } },
      ],
    });
    expect(left).toEqual([
      {
        user_id: "left",
        staff_id: "s-left",
        display_name: "Pat",
        email: "pat@x.test",
        role: "tech",
        left_at: "2026-11-12T16:20:00Z",
      },
    ]);
  });

  it("is one line per person, on the newest staff row (the one an invitation turns back on)", () => {
    const left = leftTeammates({
      memberUserIds: [],
      staff: [
        ORG_ROW({ id: "old", user_id: "u", created_at: "2026-01-01T00:00:00Z" }),
        ORG_ROW({ id: "new", user_id: "u", created_at: "2026-06-01T00:00:00Z" }),
      ],
      leftEvents: [],
    });
    expect(left.map((l) => l.staff_id)).toEqual(["new"]);
    expect(left[0].left_at).toBeNull();
  });

  it("drops out the moment they are back (a membership, or an active row)", () => {
    const staff = [ORG_ROW({ id: "s", user_id: "u" })];
    const leftEvents = [{ created_at: "2026-11-12T00:00:00Z", meta: { user_id: "u" } }];
    expect(leftTeammates({ memberUserIds: ["u"], staff, leftEvents })).toEqual([]);
    expect(
      leftTeammates({
        memberUserIds: [],
        staff: [...staff, ORG_ROW({ id: "s2", user_id: "u", active: true })],
        leftEvents,
      }),
    ).toEqual([]);
  });

  it("says Left with the date, or just Left when none was recorded", () => {
    expect(leftLabel("2026-11-12T16:20:00Z")).toBe("Left Nov 12, 2026");
    expect(leftLabel(null)).toBe("Left");
    expect(leftLabel("not a date")).toBe("Left");
  });
});

describe("the Team page draws them and offers the way back (#938)", () => {
  const page = readFileSync("src/routes/_authenticated/settings.users.tsx", "utf8");
  const server = readFileSync("src/lib/users.functions.ts", "utf8");

  it("listOrgUsers returns the people who left beside the members", () => {
    expect(server).toMatch(/left:\s*await listLeftTeammates\(orgId, users\)/);
    // Read only after list_org_users has answered (the owner-or-manager
    // check), and scoped to the caller's business.
    const start = server.indexOf("async function listLeftTeammates");
    const fn = server.slice(start, server.indexOf("\n}\n", start));
    expect(fn).toMatch(/\.eq\("organization_id", orgId\)/);
    expect(fn).toMatch(/\.eq\("kind", "staff\.left"\)/);
    expect(fn).not.toMatch(/\.(insert|update|delete|upsert)\(/);
  });

  it("each is a row with Left and its date, and Invite again fills the invite form", () => {
    expect(page).toMatch(/data-left-teammate=\{u\.user_id\}/);
    expect(page).toMatch(/leftLabel\(u\.left_at\)/);
    expect(page).toMatch(/Invite again/);
    expect(page).toMatch(/setPrefill\(\{\s*email: u\.email as string,\s*role: u\.role/);
    expect(page).toMatch(/<InvitePanel prefill=\{prefill\} \/>/);
    // An invitation already out is said, not offered twice.
    expect(page).toMatch(/Invited back/);
  });
});

describe("somebody who now runs their own business reads a sentence they can act on (#938)", () => {
  it("is not told to leave a business they own", () => {
    const s = otherOrgReason("pat@x.test", "Pat's Scoops", "Acme Scoops", "owner");
    expect(s).toBe(
      "pat@x.test runs Pat's Scoops, and an account can belong to one business, so it can't join Acme Scoops as well. Nothing in Pat's Scoops has changed. To join Acme Scoops, ask them to send the invitation to a different email address.",
    );
    expect(s).not.toMatch(/leave/i);
  });

  it("a member who is not the owner still reads the leave-first sentence", () => {
    expect(otherOrgReason("pat@x.test", "Other", "Acme", "tech")).toContain("leave Other first");
    expect(otherOrgReason("pat@x.test", "Other", "Acme")).toContain("leave Other first");
  });
});
