import { describe, expect, it } from "vitest";
import { loadAccounts, unattachedCount } from "@/lib/platform-directory.functions";

// /platform/users listed 12 people while auth.users held 22, under the heading
// "Showing 1–12 of 12 users."
//
// The ten it left out are not a bug in the query — the page's population is and
// always was "users with an organization membership", which is the right thing
// for a directory to list. The fault was the count calling them users, next to a
// search that says "Every tenant was searched, so this is not a paging artefact"
// when somebody fails to find the account they came for. Nine of the ten are
// abandoned signups; the tenth is the platform admin, who holds zero user_roles
// rows BY DESIGN and so can never appear here however hard anybody looks.
//
// The number is now stated. What these tests are really about is the three ways
// it could be stated WRONGLY, because a confidently wrong count is worse than
// the silence it replaced.
describe("unattachedCount refuses to answer when it cannot", () => {
  const base = { exhausted: true, membershipsComplete: true, filtered: false, accounts: 22, members: 12 };

  it("answers when the scan saw everything", () => {
    expect(unattachedCount(base)).toBe(10);
  });

  it("is null, not zero, when the account scan stopped early", () => {
    // Above ACCOUNT_PAGE_SIZE the loader pages only far enough to resolve the
    // members it needs, so `accounts` is a floor and the subtraction is
    // meaningless. Zero would read as "everyone has a workspace".
    expect(unattachedCount({ ...base, exhausted: false })).toBeNull();
  });

  it("is null when the membership scan hit its ceiling", () => {
    // `members` short makes the difference too BIG — it would invent unattached
    // accounts out of members nobody read.
    expect(unattachedCount({ ...base, membershipsComplete: false })).toBeNull();
  });

  it("is null under an org or role filter", () => {
    // The trap this whole function exists for. loadMemberships is called WITH
    // the filters, so `members` is the filtered population: filter to one org
    // with 3 members and 22 − 3 = 19 would be rendered as "19 accounts hold no
    // role", of which 9 are simply members of a different organization.
    expect(unattachedCount({ ...base, filtered: true, members: 3 })).toBeNull();
  });

  it("never goes negative", () => {
    // Defensive: a member whose auth account was hard-deleted would make
    // members exceed accounts, and "-1 other accounts" is nonsense on a screen.
    expect(unattachedCount({ ...base, accounts: 5, members: 12 })).toBe(0);
  });
});

type FakeCalls = { listPages: number[] };
function fakeAuthAdmin(totalAccounts: number, perPageSeen: FakeCalls) {
  return {
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          perPageSeen.listPages.push(page);
          const start = (page - 1) * perPage;
          const end = Math.min(start + perPage, totalAccounts);
          const users = [];
          for (let i = start; i < end; i++) {
            users.push({ id: `acct-${i}`, email: `acct-${i}@example.test`, last_sign_in_at: null, created_at: null });
          }
          return { data: { users }, error: null };
        },
        getUserById: async (uid: string) => ({
          data: { user: { id: uid, email: `${uid}@example.test`, last_sign_in_at: null, created_at: null } },
          error: null,
        }),
      },
    },
  };
}

describe("loadAccounts reports whether it reached the end", () => {
  it("is exhausted on a directory smaller than one page, and holds every account", async () => {
    // Production today: 22 accounts, 12 of them members. One page ends it, so
    // byId holds all 22 and the subtraction is free — no extra round trip.
    const calls: FakeCalls = { listPages: [] };
    const members = Array.from({ length: 12 }, (_, i) => `acct-${i}`);
    const r = await loadAccounts(fakeAuthAdmin(22, calls), members);
    expect(r.exhausted).toBe(true);
    expect(r.byId.size).toBe(22);
    expect(r.complete).toBe(true);
    expect(calls.listPages).toEqual([1]);
    expect(unattachedCount({
      exhausted: r.exhausted,
      membershipsComplete: true,
      filtered: false,
      accounts: r.byId.size,
      members: members.length,
    })).toBe(10);
  });

  it("is not exhausted when a full page comes back, so no count is offered", async () => {
    // A full first page means there may be more; with few members the loader
    // stops there and resolves the rest individually, so byId is NOT a census.
    const calls: FakeCalls = { listPages: [] };
    const r = await loadAccounts(fakeAuthAdmin(1500, calls), ["acct-0", "acct-1"]);
    expect(r.exhausted).toBe(false);
    expect(unattachedCount({
      exhausted: r.exhausted,
      membershipsComplete: true,
      filtered: false,
      accounts: r.byId.size,
      members: 2,
    })).toBeNull();
  });
});
