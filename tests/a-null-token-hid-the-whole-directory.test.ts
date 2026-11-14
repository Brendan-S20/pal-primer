import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// #767. Six SQL-seeded `auth.users` rows had NULL confirmation_token /
// recovery_token / email_change_token_new / email_change. GoTrue scans those
// columns into Go strings, so `auth.admin.listUsers` answered every page that
// held one of them with 500:
//
//   sql: Scan error on column index 3, name "confirmation_token":
//   converting NULL to string is unsupported
//
// The directory treated that as "the listing failed" and fell back to one
// getUserById per MEMBER — so every account with no membership (the stuck
// owner support was trying to find) vanished, along with the count of them,
// and nothing on screen said why. Six bad rows hid the whole directory.
//
// The data was repaired by hand. This is the code guard, so the next seed that
// skips GoTrue's defaults costs six rows, not the directory: a page that fails
// with exactly this error is re-read in halves until the unreadable rows are
// isolated, every readable account is kept, and the screen is told how many
// could not be read.

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b: Record<string, () => unknown> = {};
    b.middleware = b.inputValidator = b.handler = () => b;
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import {
  isNullTokenScanError,
  loadAccounts,
  nullTokenAccountMessage,
} from "@/lib/platform-directory.functions";

const SCAN_ERROR =
  'unable to fetch records: error finding user: sql: Scan error on column index 3, name "confirmation_token": converting NULL to string is unsupported';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Acct = { id: string; email: string; bad?: boolean; last_sign_in_at: null; created_at: string };

/** GoTrue as it behaved: a page containing a NULL-token row is a 500 for the whole page. */
function gotrue(accounts: Acct[], opts: { otherError?: string } = {}) {
  const calls: Array<{ page: number; perPage: number }> = [];
  const admin = {
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          calls.push({ page, perPage });
          if (opts.otherError)
            return { data: null, error: { message: opts.otherError, status: 500 } };
          const start = (page - 1) * perPage;
          const slice = accounts.slice(start, start + perPage);
          if (slice.some((a) => a.bad))
            return { data: null, error: { message: SCAN_ERROR, status: 500 } };
          return { data: { users: slice }, error: null };
        },
        getUserById: async (id: string) => {
          const a = accounts.find((x) => x.id === id);
          if (!a) return { data: { user: null }, error: { message: "User not found" } };
          if (a.bad) return { data: { user: null }, error: { message: SCAN_ERROR } };
          return { data: { user: a }, error: null };
        },
      },
    },
  };
  return { admin, calls };
}

/** The production shape: 31 accounts, 21 members, 10 orphans, 6 NULL-token rows created together. */
function production(): { accounts: Acct[]; members: string[]; orphan: string } {
  const accounts: Acct[] = Array.from({ length: 31 }, (_, i) => ({
    id: uuid(i + 1),
    email: `person${i + 1}@example.test`,
    last_sign_in_at: null,
    created_at: "2026-10-01T00:00:00Z",
  }));
  for (const i of [11, 12, 13, 14, 15, 16]) accounts[i].bad = true; // all seeded in one insert
  const orphan = accounts[29].id; // detroitdoodisposal@: an account with no business
  accounts[29].email = "orphan@example.test";
  const members = accounts.slice(0, 21).map((a) => a.id);
  return { accounts, members, orphan };
}

describe("six NULL-token rows do not hide the directory (#767)", () => {
  it("recognises GoTrue's NULL-token scan error, and nothing else", () => {
    expect(isNullTokenScanError(SCAN_ERROR)).toBe(true);
    expect(
      isNullTokenScanError(
        'sql: Scan error on column index 5, name "email_change": converting NULL to string is unsupported',
      ),
    ).toBe(true);
    expect(isNullTokenScanError("Database error finding users")).toBe(false);
    expect(isNullTokenScanError("fetch failed")).toBe(false);
    expect(isNullTokenScanError(undefined)).toBe(false);
  });

  it("keeps every readable account, the orphan included, and counts the unreadable ones", async () => {
    const { accounts, members, orphan } = production();
    const { admin } = gotrue(accounts);
    const r = await loadAccounts(admin, members);

    // the account support was looking for is there
    expect(r.byId.get(orphan)?.email).toBe("orphan@example.test");
    // every readable account was read
    expect(r.byId.size).toBe(25);
    for (const a of accounts) expect(r.byId.has(a.id)).toBe(!a.bad);
    // the listing reached the end, so "how many accounts hold no role" is answerable again
    expect(r.exhausted).toBe(true);
    // and the six are reported, not silently dropped
    expect(r.unreadable).toBe(6);
    // the bad rows are members, so no email for them: the screen says incomplete
    expect(r.complete).toBe(false);
  });

  it("isolates the bad rows in a bounded number of calls", async () => {
    const { accounts, members } = production();
    const { admin, calls } = gotrue(accounts);
    await loadAccounts(admin, members);
    // 1 full page + a bisection to six rows out of 1000: well under 200 calls
    expect(calls.length).toBeLessThan(200);
    // never asks for a page size that does not divide the one above it
    for (const c of calls) expect(1000 % c.perPage).toBe(0);
  });

  it("still falls back to per-member lookups for any OTHER listing error (#446 unchanged)", async () => {
    const { accounts, members, orphan } = production();
    const { admin, calls } = gotrue(accounts, { otherError: "Database error finding users" });
    const r = await loadAccounts(admin, members);
    expect(calls).toHaveLength(1); // no bisection on an error it does not understand
    expect(r.exhausted).toBe(false);
    expect(r.byId.has(orphan)).toBe(false);
    expect(r.byId.size).toBe(15); // 21 members minus the 6 GoTrue cannot read one at a time either
    expect(r.unreadable).toBe(0);
  });

  it("a clean directory costs exactly one call, as before", async () => {
    const { accounts, members } = production();
    for (const a of accounts) delete a.bad;
    const { admin, calls } = gotrue(accounts);
    const r = await loadAccounts(admin, members);
    expect(calls).toEqual([{ page: 1, perPage: 1000 }]);
    expect(r.byId.size).toBe(31);
    expect(r.unreadable).toBe(0);
    expect(r.complete).toBe(true);
  });

  it("opening an unreadable account says what is wrong in words, not as a Go scan error", () => {
    const msg = nullTokenAccountMessage();
    expect(msg).not.toMatch(/Scan error|converting NULL/);
    expect(msg).toMatch(/cannot read this account/i);
  });

  it("the screen reports unreadable accounts instead of hiding them", () => {
    const page = readFileSync("src/routes/platform.users.tsx", "utf8");
    expect(page).toMatch(/scan\.unreadableAccounts/);
  });
});
