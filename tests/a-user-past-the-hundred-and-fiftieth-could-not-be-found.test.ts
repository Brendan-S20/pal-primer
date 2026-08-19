// The 2026-08-19 owner QA, Users directory: the whole directory was 150 rows
// and there was no way to know it.
//
// ── THE FAULT ─────────────────────────────────────────────────────────────
//
// `/platform/users` asked `listPlatformUsers` for `limit: 150` and then
// filtered those 150 rows in the browser. `listPlatformUsers` already took a
// `search` parameter, but it applied it AFTER `userIds.slice(0, data.limit)`,
// so it could only ever narrow the rows it had already fetched. Both ends of
// the wire were searching the same first 150 users.
//
// The consequence is not "the list is a bit short". It is that a person who
// is not in the first 150 rows of `user_roles` CANNOT BE FOUND AT ALL — not
// by email, not by user id, not by scrolling, not by any control on the page.
// The support flow this screen exists for ("somebody emailed us from an
// address and we do not know which tenant they are in") returns "No users
// match" for them, which is indistinguishable from "that person does not have
// an account". And the screen said "Shows up to 150 users at a time", so a
// full-looking table of 150 and a truncated one looked identical.
//
// `organization_id` and `role` were never part of this: they are applied to
// the `user_roles` query, which is to say before the cap, so they could always
// reach the whole directory. That is the shape the fix had to match.
//
// ── WHY IT WAS NOT SIMPLY "WIRE UP THE SEARCH PARAMETER" ──────────────────
//
// Because the parameter was downstream of the cap. Passing the input box
// through to it would have moved the same broken filter to the server and
// looked like a fix. The cap itself had to move: off the population, onto the
// page. `selectDirectoryPage` is the order-of-operations that matters —
// narrow the whole set, sort it, and take a page LAST — and it is exported and
// pure precisely so that order can be tested rather than described.
//
// ── WHAT THE DATA LAYER PERMITS, WHICH IS WHY IT LOOKS LIKE THIS ──────────
//
// No table in `public` holds an email. `user_roles` is (user_id,
// organization_id, role); there is no profiles table and no readable copy of
// `auth.users`. The auth admin API offers `getUserById(id)` and
// `listUsers({ page, perPage })` and nothing else — `PageParams` in
// @supabase/auth-js has no filter argument. So "search emails in the
// database" is not reachable from this app at any price. What IS reachable is
// reading the accounts a page of a thousand at a time and searching the whole
// set in the server function, which is what happens now: still server-side,
// still before any cap, and honest about being a scan.
//
// Because both scans are bounded, the response carries `scan` and the screen
// renders it when either ran short. A capped answer that looks complete is the
// fault being fixed here; it would be a poor trade to close it at the top of
// the function and reopen it at the bottom.
//
// ── DELIBERATELY NOT CHANGED ──────────────────────────────────────────────
//
// The platform-admin gate, every auth admin action, and the population of the
// directory — users who hold a role in an organization. Accounts with no
// `user_roles` row were invisible here before and still are; that is a change
// to what the page MEANS, not to how much of it you can see.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  loadAccounts,
  matchesDirectorySearch,
  selectDirectoryPage,
  type PlatformUserRow,
} from "@/lib/platform-directory.functions";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");

const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const directoryFns = read("src/lib/platform-directory.functions.ts");
const directoryCode = codeOnly(directoryFns);
const usersRoute = read("src/routes/platform.users.tsx");
const usersCode = codeOnly(usersRoute);

// A directory four hundred people deep: bigger than the old 150 cap, so
// anybody from #150 on is somebody the previous screen could not reach.
// Emails sort in the same order as the index, which makes "which page is this
// person on" answerable in the test rather than a matter of trust.
const mkUser = (i: number): PlatformUserRow => ({
  user_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
  email: `user${String(i).padStart(3, "0")}@example.test`,
  last_sign_in_at: null,
  created_at: null,
  organizations: [
    { id: i < 200 ? "org-north" : "org-south", name: i < 200 ? "Northside" : "Southside", role: "tech" },
  ],
});
const DIRECTORY: PlatformUserRow[] = Array.from({ length: 400 }, (_, i) => mkUser(i));
const PAGE = 50;

describe("a person past the old cap can be found", () => {
  it("finds the four-hundredth user by email, from the first page", () => {
    // The exact case that returned nothing: #399 is not in the first 150 rows,
    // so a search applied to an already-fetched page never sees them.
    const p = selectDirectoryPage(DIRECTORY, { search: "user399@", offset: 0, limit: PAGE });
    expect(p.total).toBe(1);
    expect(p.rows.map((r) => r.email)).toEqual(["user399@example.test"]);
  });

  it("finds them by user id too", () => {
    const target = DIRECTORY[380];
    const p = selectDirectoryPage(DIRECTORY, {
      search: target.user_id.slice(-6),
      offset: 0,
      limit: PAGE,
    });
    expect(p.total).toBe(1);
    expect(p.rows[0].user_id).toBe(target.user_id);
  });

  it("finds them by organization name, across the whole directory", () => {
    // Southside is users 200-399 — entirely past the old cap.
    const p = selectDirectoryPage(DIRECTORY, { search: "southside", offset: 0, limit: PAGE });
    expect(p.total).toBe(200);
    expect(p.rows[0].email).toBe("user200@example.test");
  });

  it("counts every match, not just the ones on this page", () => {
    // 100 matches (user100…user199) in pages of 50. A `total` taken from the
    // page would say 50 and the pager would hide half the answer.
    const p = selectDirectoryPage(DIRECTORY, { search: "user1", offset: 0, limit: PAGE });
    expect(p.rows).toHaveLength(PAGE);
    expect(p.total).toBe(100);
  });

  it("searches, then pages what is left — in that order", () => {
    const second = selectDirectoryPage(DIRECTORY, { search: "southside", offset: 150, limit: PAGE });
    expect(second.total).toBe(200);
    expect(second.rows.map((r) => r.email)).toEqual(
      Array.from({ length: PAGE }, (_, i) => `user${350 + i}@example.test`),
    );
  });

  it("matches case-insensitively on email, id and org", () => {
    const row = mkUser(7);
    expect(matchesDirectorySearch(row, "USER007@EXAMPLE.TEST")).toBe(true);
    expect(matchesDirectorySearch(row, "NORTHSIDE")).toBe(true);
    expect(matchesDirectorySearch(row, row.user_id.toUpperCase())).toBe(true);
    expect(matchesDirectorySearch(row, "southside")).toBe(false);
  });
});

describe("paging reaches everybody exactly once", () => {
  it("walks all 400 users over 8 pages with no gap and no repeat", () => {
    const first = selectDirectoryPage(DIRECTORY, { search: null, offset: 0, limit: PAGE });
    expect(first.total).toBe(400);
    const pageCount = Math.ceil(first.total / PAGE);
    expect(pageCount).toBe(8);

    const seen: string[] = [];
    for (let p = 0; p < pageCount; p++) {
      const got = selectDirectoryPage(DIRECTORY, { search: null, offset: p * PAGE, limit: PAGE });
      expect(got.offset).toBe(p * PAGE);
      seen.push(...got.rows.map((r) => r.user_id));
    }
    expect(seen).toHaveLength(400);
    expect(new Set(seen).size).toBe(400);
    expect(new Set(seen)).toEqual(new Set(DIRECTORY.map((r) => r.user_id)));
  });

  it("orders the same way every call, so page 2 is not page 1 shuffled", () => {
    const a = selectDirectoryPage(DIRECTORY.slice().reverse(), { search: null, offset: 100, limit: PAGE });
    const b = selectDirectoryPage(DIRECTORY, { search: null, offset: 100, limit: PAGE });
    expect(a.rows.map((r) => r.user_id)).toEqual(b.rows.map((r) => r.user_id));
  });

  it("does not mutate the caller's array while sorting it", () => {
    const input = DIRECTORY.slice().reverse();
    const before = input.map((r) => r.user_id);
    selectDirectoryPage(input, { search: null, offset: 0, limit: PAGE });
    expect(input.map((r) => r.user_id)).toEqual(before);
  });

  it("sorts rows with no resolvable email last rather than dropping them", () => {
    const anonymous: PlatformUserRow = { ...mkUser(500), email: null };
    const p = selectDirectoryPage([anonymous, ...DIRECTORY.slice(0, 3)], {
      search: null,
      offset: 0,
      limit: PAGE,
    });
    expect(p.total).toBe(4);
    expect(p.rows[3].user_id).toBe(anonymous.user_id);
  });

  it("lands on the last page, not an empty one, when asked past the end", () => {
    // Narrowing a search while on page 9 must not read as "no matches".
    const p = selectDirectoryPage(DIRECTORY, { search: "southside", offset: 5_000, limit: PAGE });
    expect(p.total).toBe(200);
    expect(p.offset).toBe(150);
    expect(p.rows).toHaveLength(PAGE);
  });

  it("survives an empty directory without a negative offset", () => {
    const p = selectDirectoryPage([], { search: null, offset: 400, limit: PAGE });
    expect(p).toEqual({ rows: [], total: 0, offset: 0 });
  });
});

describe("the server function caps the page, not the population", () => {
  const handler = directoryCode.slice(
    directoryCode.indexOf("export const listPlatformUsers"),
    directoryCode.indexOf("// ─────────── User detail"),
  );

  it("takes an offset as well as a limit", () => {
    expect(directoryCode).toMatch(/offset: z\.number\(\)\.int\(\)\.min\(0\)/);
    expect(directoryCode).toMatch(/limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\(200\)/);
  });

  it("no longer slices the user ids before hydrating them", () => {
    // `const capped = userIds.slice(0, data.limit)` was the cap that search
    // could not see past.
    expect(handler).not.toMatch(/\.slice\(0, data\.limit\)/);
    expect(handler).not.toMatch(/const capped/);
  });

  it("reads every membership row in ranges instead of stopping at a fixed limit", () => {
    expect(directoryCode).not.toMatch(/\.limit\(2000\)/);
    const loader = directoryCode.slice(
      directoryCode.indexOf("async function loadMemberships"),
      directoryCode.indexOf("async function loadOrgNames"),
    );
    expect(loader).toMatch(/\.range\(/);
    expect(loader).toMatch(/\.order\("user_id"/);
    // A ranged read with no total order can overlap or skip between chunks.
    expect(loader).toMatch(/\.order\("id"/);
  });

  it("resolves emails by paging the account list, not one request per row", () => {
    const loader = directoryCode.slice(directoryCode.indexOf("async function loadAccounts"));
    expect(loader).toMatch(/auth\.admin\.listUsers\(\{/);
    expect(loader).toMatch(/perPage: ACCOUNT_PAGE_SIZE/);
  });

  it("narrows and pages through the one exported, tested code path", () => {
    expect(handler).toMatch(/selectDirectoryPage\(all, \{/);
    expect(handler).toMatch(/search: data\.search/);
    expect(handler).toMatch(/offset: data\.offset/);
  });

  it("returns the clamped offset and the true total, not the page length", () => {
    expect(handler).toMatch(/total: page\.total/);
    expect(handler).toMatch(/offset: page\.offset/);
  });

  it("reports how much of the directory it actually managed to read", () => {
    expect(handler).toMatch(/scan: \{/);
    expect(handler).toMatch(/membershipsComplete: memberships\.complete/);
    expect(handler).toMatch(/accountsComplete: accounts\.complete/);
  });

  it("still applies the org and role filters to the query, before anything is paged", () => {
    const loader = directoryCode.slice(
      directoryCode.indexOf("async function loadMemberships"),
      directoryCode.indexOf("async function loadOrgNames"),
    );
    expect(loader).toMatch(/\.eq\("organization_id", filters\.organization_id\)/);
    expect(loader).toMatch(/\.eq\("role", filters\.role\)/);
  });

  it("is still behind the platform-admin gate", () => {
    expect(handler.slice(0, 400)).toMatch(
      /await assertAdmin\(context\.supabase, context\.userId\)/,
    );
  });
});

describe("the screen asks for a page and says which one it got", () => {
  it("no longer asks for 150 rows and searches them in the browser", () => {
    expect(usersCode).not.toMatch(/limit: 150/);
    expect(usersCode).not.toMatch(/Shows up to 150 users/);
    // The old client-side narrowing, which could only ever see the fetched page.
    expect(usersCode).not.toMatch(/const filtered = search\.trim\(\)/);
    expect(usersCode).not.toMatch(/rows\.filter\(\(r\) => \{/);
  });

  it("sends the search and the offset to the server", () => {
    expect(usersCode).toMatch(/offset: page \* PAGE_SIZE/);
    expect(usersCode).toMatch(/\.\.\.\(search \? \{ search \} : \{\}\)/);
    expect(usersCode).toMatch(/queryKey: \["platform", "users", role, search, page\]/);
  });

  it("debounces typing rather than scanning the directory per keystroke", () => {
    expect(usersCode).toMatch(/setTimeout\(\(\) => setSearch\(searchInput\.trim\(\)\)/);
  });

  it("goes back to the first page when the result set changes underneath it", () => {
    expect(usersCode).toMatch(/setPage\(0\);\s*\n\s*\}, \[search, role\]\)/);
  });

  it("states the range and the total on every render, capped or not", () => {
    expect(usersCode).toMatch(/Showing \$\{firstShown\.toLocaleString\(\)\}–\$\{lastShown\.toLocaleString\(\)\} of \$\{total\.toLocaleString\(\)\}/);
    expect(usersCode).toMatch(/const total = q\.data\?\.total \?\? 0/);
  });

  it("says so when a scan ran short instead of showing a confident wrong number", () => {
    expect(usersCode).toMatch(/!scan\.membershipsComplete \|\| !scan\.accountsComplete/);
    expect(usersCode).toMatch(/incomplete/i);
  });

  it("has a pager with labelled controls, not two bare arrows", () => {
    const pager = usersCode.slice(usersCode.indexOf("Page ${(currentPage + 1)"));
    expect(pager).toMatch(/>\s*Previous\s*</);
    expect(pager).toMatch(/>\s*Next\s*</);
    // `size="sm"` carries the max-md:min-h-11 touch floor from ui/button.tsx;
    // `size="icon"` around a chevron alone would be a 36px target with no label.
    expect(pager).not.toMatch(/size="icon"/);
    expect(pager).toMatch(/disabled=\{currentPage <= 0/);
    expect(pager).toMatch(/disabled=\{currentPage >= pageCount - 1/);
    expect(pager).toMatch(/Page \$\{\(currentPage \+ 1\)\.toLocaleString\(\)\} of \$\{pageCount\.toLocaleString\(\)\}/);
  });

  it("keeps the previous page on screen while the next one loads", () => {
    expect(usersCode).toMatch(/placeholderData: keepPreviousData/);
    // …and does not then re-sync its position against that stale page. The
    // held-over result still carries the OLD offset, so an unguarded sync
    // sends you back where you were and Next looks broken.
    expect(usersCode).toMatch(/!q\.isPlaceholderData/);
  });

  it("clears the row selection when the page turns, not only when the filter changes", () => {
    expect(usersCode).toMatch(/useRowSelection\(selectableIds, `\$\{search\}\|\$\{role\}\|\$\{page\}`\)/);
  });

  it("does not overflow a 360px phone with a fixed-width search box", () => {
    expect(usersCode).toMatch(/className="w-full sm:w-64"/);
    expect(usersCode).toMatch(/className="w-full sm:w-44"/);
    // The pager row wraps rather than pushing Next off the side.
    expect(usersCode).toMatch(/className="mt-4 flex flex-wrap items-center justify-between gap-3"/);
  });
});

describe("what this change was not allowed to break", () => {
  it("still shows whether the user's email is confirmed", () => {
    // getPlatformUserDetail has returned email_confirmed_at since it was
    // written and it was rendered nowhere for months; it is rendered now.
    expect(directoryCode).toMatch(/email_confirmed_at: user\.email_confirmed_at \?\? null/);
    expect(usersCode).toMatch(/d\.email_confirmed_at/);
    expect(usersRoute).toMatch(/Not confirmed/);
  });

  it("still lets the person you found be impersonated and reset", () => {
    expect(usersCode).toMatch(/launchImpersonationTab\(impersonateFn as never/);
    expect(usersCode).toMatch(/bulkResetM\.mutate\(sel\.selectedIds\)/);
  });
});

// ── AND THE HONESTY FLAG IS EXERCISED, NOT JUST ASSERTED ─────────────────
//
// `scan.accountsComplete` is what stops the screen from printing a confident
// wrong number, so "did the scan really finish" has to be a fact about the
// loop rather than a comment above it. This drives `loadAccounts` against a
// stand-in auth admin API that counts its calls, at the three sizes where it
// changes strategy and at the one where it gives up.

type FakeCalls = { listPages: number[]; byId: string[] };

function fakeAuthAdmin(totalAccounts: number, calls: FakeCalls) {
  const idOf = (i: number) => `acct-${i}`;
  return {
    auth: {
      admin: {
        // Lazily materialised: the ceiling case is 50,000 accounts and there
        // is no reason to build them all to prove we stopped.
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          calls.listPages.push(page);
          const start = (page - 1) * perPage;
          const end = Math.min(start + perPage, totalAccounts);
          const users = [];
          for (let i = start; i < end; i++) {
            users.push({ id: idOf(i), email: `${idOf(i)}@example.test`, last_sign_in_at: null, created_at: null });
          }
          return { data: { users }, error: null };
        },
        getUserById: async (uid: string) => {
          calls.byId.push(uid);
          const n = Number(uid.replace("acct-", ""));
          if (!Number.isFinite(n) || n >= totalAccounts) return { data: { user: null }, error: null };
          return {
            data: { user: { id: uid, email: `${uid}@example.test`, last_sign_in_at: null, created_at: null } },
            error: null,
          };
        },
      },
    },
  };
}

describe("the account scan knows, and says, whether it finished", () => {
  it("one page is enough when the whole auth table fits in one", async () => {
    const calls: FakeCalls = { listPages: [], byId: [] };
    const members = ["acct-3", "acct-77", "acct-499"];
    const r = await loadAccounts(fakeAuthAdmin(500, calls), members);
    expect(calls.listPages).toEqual([1]);
    expect(calls.byId).toEqual([]);
    expect(r.complete).toBe(true);
    expect(r.byId.get("acct-499")?.email).toBe("acct-499@example.test");
  });

  it("looks a small directory up member by member rather than paging past accounts it does not want", async () => {
    // 12 members inside a 5,000-account tenant estate: paging four more
    // thousand-account pages to find eleven addresses would be silly.
    const calls: FakeCalls = { listPages: [], byId: [] };
    const members = ["acct-0", "acct-1500", "acct-4999"];
    const r = await loadAccounts(fakeAuthAdmin(5000, calls), members);
    expect(calls.listPages).toEqual([1]);
    expect(calls.byId.sort()).toEqual(["acct-1500", "acct-4999"]);
    expect(r.complete).toBe(true);
    expect(r.byId.get("acct-4999")?.email).toBe("acct-4999@example.test");
  });

  it("keeps paging when the directory is too big to look up one at a time", async () => {
    const calls: FakeCalls = { listPages: [], byId: [] };
    const members = Array.from({ length: 2500 }, (_, i) => `acct-${i}`);
    const r = await loadAccounts(fakeAuthAdmin(4200, calls), members);
    expect(calls.listPages).toEqual([1, 2, 3, 4, 5]);
    expect(calls.byId).toEqual([]);
    expect(r.accounts).toBe(4200);
    expect(r.complete).toBe(true);
  });

  it("stops at its ceiling and admits it, instead of returning a short answer that looks whole", async () => {
    const calls: FakeCalls = { listPages: [], byId: [] };
    // Members that live past the 50,000-account ceiling.
    const members = Array.from({ length: 2500 }, (_, i) => `acct-${60_000 + i}`);
    const r = await loadAccounts(fakeAuthAdmin(80_000, calls), members);
    expect(calls.listPages).toHaveLength(50);
    expect(r.accounts).toBe(50_000);
    expect(r.complete).toBe(false);
  }, 20_000);

  it("does not blank the page when one account cannot be read", async () => {
    const calls: FakeCalls = { listPages: [], byId: [] };
    const r = await loadAccounts(fakeAuthAdmin(1200, calls), ["acct-5", "acct-99999"]);
    expect(r.byId.get("acct-5")?.email).toBe("acct-5@example.test");
    expect(r.byId.has("acct-99999")).toBe(false);
    // …but it does say the answer is short, which is the whole point.
    expect(r.complete).toBe(false);
  });
});
