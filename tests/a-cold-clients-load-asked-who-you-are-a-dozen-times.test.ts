// #900: a cold /clients load made 70 database requests, and twelve of them
// were one question asked six times inside ONE request: getShellParts runs a
// dozen loaders side by side, and each that checks the caller (features,
// trial, the billing banner, the review count, the franchise context) read
// user_roles and access_turned_off() again for itself. The summary under the
// tiles then asked for three empty pages of invoices after the last full one.
//
// What is pinned here:
//   * lookups are shared ONLY on a client a handler registered for its own
//     request, so the service-role client, a test double and every other
//     handler read exactly as they did;
//   * a failed lookup is not remembered;
//   * the counted paging reads every row, asks for no page after a short one,
//     and still reads a row added after the count was taken.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonation-session.server", () => ({
  assertImpersonationSessionActive: async () => {},
}));

import { callerRoleOrNull, resolveCaller } from "@/lib/authz.server";
import { sharedLookup, shareCallerLookups } from "@/lib/caller-lookup.server";
import { fetchAllPagesCounted } from "@/lib/supabase-paging.server";

/** A client that answers the two caller reads and counts them. */
function fakeClient(opts: { role?: string | null; off?: string[]; failFirst?: boolean } = {}) {
  const reads = { roles: 0, off: 0, overrides: 0 };
  let failed = !opts.failFirst;
  const client = {
    from(table: string) {
      if (table === "role_permission_overrides") {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          then: (ok: (v: unknown) => unknown) => {
            reads.overrides++;
            return Promise.resolve({ data: [], error: null }).then(ok);
          },
        };
        return chain;
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              reads.roles++;
              if (!failed) {
                failed = true;
                return { data: null, error: { message: "connection reset" } };
              }
              return {
                data: opts.role === null ? null : { organization_id: "org-1", role: opts.role ?? "owner" },
                error: null,
              };
            },
          }),
        }),
      };
    },
    rpc: async () => {
      reads.off++;
      return {
        data: (opts.off ?? []).map((id) => ({ organization_id: id, organization_name: "Biz" })),
        error: null,
      };
    },
  };
  return { client, reads };
}

describe("the caller lookup, shared within one request (#900)", () => {
  it("reads every time on a client nobody registered", async () => {
    const { client, reads } = fakeClient();
    await Promise.all([resolveCaller(client, "u1"), resolveCaller(client, "u1"), resolveCaller(client, "u1")]);
    expect(reads).toMatchObject({ roles: 3, off: 3 });
  });

  it("reads once for every loader in a request that registered its client", async () => {
    const { client, reads } = fakeClient();
    shareCallerLookups(client);
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => resolveCaller(client, "u1")),
    );
    expect(reads).toMatchObject({ roles: 1, off: 1 });
    for (const a of answers) expect(a).toEqual({ orgId: "org-1", role: "owner" });
    expect(await callerRoleOrNull(client, "u1")).toBe("owner");
    expect(reads).toMatchObject({ roles: 1, off: 1 });
  });

  it("shares a non-owner's overrides read too", async () => {
    const { client, reads } = fakeClient({ role: "dispatcher" });
    shareCallerLookups(client);
    await Promise.all([resolveCaller(client, "u1"), resolveCaller(client, "u1")]);
    expect(reads).toMatchObject({ roles: 1, off: 1, overrides: 1 });
  });

  it("keeps people apart on one client", async () => {
    const { client, reads } = fakeClient();
    shareCallerLookups(client);
    await Promise.all([resolveCaller(client, "u1"), resolveCaller(client, "u2")]);
    expect(reads).toMatchObject({ roles: 2, off: 2 });
  });

  it("does not remember a lookup that failed", async () => {
    const { client, reads } = fakeClient({ failFirst: true });
    shareCallerLookups(client);
    await expect(resolveCaller(client, "u1")).rejects.toThrow("connection reset");
    await expect(resolveCaller(client, "u1")).resolves.toEqual({ orgId: "org-1", role: "owner" });
    expect(reads.roles).toBe(2);
  });

  it("still refuses a person who was turned off, shared or not", async () => {
    const { client } = fakeClient({ off: ["org-1"] });
    shareCallerLookups(client);
    await expect(resolveCaller(client, "u1")).rejects.toThrow(/turned off/);
    expect(await callerRoleOrNull(client, "u1")).toBeNull();
  });

  it("answers no role without a business", async () => {
    const { client } = fakeClient({ role: null });
    expect(await callerRoleOrNull(client, "u1")).toBeNull();
  });

  it("passes anything that is not an object straight through", async () => {
    let n = 0;
    shareCallerLookups(undefined);
    await sharedLookup(undefined, "k", async () => ++n);
    await sharedLookup(undefined, "k", async () => ++n);
    expect(n).toBe(2);
  });
});

describe("fetchAllPagesCounted (#900)", () => {
  /** `rows` rows, of which the count reports `counted`. */
  function table(rows: number, counted: number | null = rows) {
    const asked: Array<[number, number, boolean]> = [];
    const build = async (from: number, to: number, withCount: boolean) => {
      asked.push([from, to, withCount]);
      const data = Array.from({ length: Math.max(0, Math.min(to, rows - 1) - from + 1) }, (_, k) => from + k);
      return { data, error: null, count: withCount ? counted : null };
    };
    return { asked, build };
  }

  it("is one request under a thousand rows", async () => {
    const t = table(999);
    expect((await fetchAllPagesCounted<number>(t.build)).length).toBe(999);
    expect(t.asked).toEqual([[0, 999, true]]);
  });

  it("asks for no empty page after a short one: 1,007 open invoices are two requests", async () => {
    const t = table(1007);
    expect((await fetchAllPagesCounted<number>(t.build)).length).toBe(1007);
    expect(t.asked).toEqual([
      [0, 999, true],
      [1000, 1999, false],
    ]);
  });

  it("reads every row of a book that ends exactly on a page", async () => {
    const t = table(5000);
    const rows = await fetchAllPagesCounted<number>(t.build);
    expect(rows).toEqual(Array.from({ length: 5000 }, (_, k) => k));
    // The four pages the count says are left, then one to prove the end.
    expect(t.asked.length).toBe(6);
  });

  it("still reads rows added after the count was taken", async () => {
    const t = table(2500, 1000);
    expect((await fetchAllPagesCounted<number>(t.build)).length).toBe(2500);
  });

  it("reads to the end when there is no count", async () => {
    const t = table(9100, null);
    expect((await fetchAllPagesCounted<number>(t.build)).length).toBe(9100);
  });

  it("throws on an error from any page", async () => {
    const build = async (from: number) =>
      from === 0
        ? { data: Array.from({ length: 1000 }, (_, k) => k), error: null, count: 3000 }
        : { data: null, error: { message: "boom" } };
    await expect(fetchAllPagesCounted<number>(build)).rejects.toThrow("boom");
  });
});
