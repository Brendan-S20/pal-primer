import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #446. Platform > Users said "No users yet" for every filter while each
// tenant's own page listed its people. Production held 15 `user_roles` rows,
// every one with an organization, 15 distinct users.
//
// Two things made that possible. The directory resolved emails with one
// all-or-nothing `auth.admin.listUsers` call, and any error from it threw the
// whole request away; the tenant page never makes that call. And the screen
// read a failed request as `rows ?? []`, so "the server errored" and "nobody
// is here" printed the same sentence.
//
// This drives the real handler against a stand-in service-role client holding
// exactly that shape of data, and checks the screen says a failure out loud.

let context: { supabase: unknown; userId: string };
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown): unknown => data;
    const builder: any = {
      middleware: () => builder,
      inputValidator: (v: typeof validate) => {
        validate = v;
        return builder;
      },
      handler:
        (handler: any) =>
        async ({ data }: { data: unknown }) =>
          handler({ data: validate(data), context }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

type Role = { id: string; user_id: string; role: string; organization_id: string };

const h = vi.hoisted(() => ({
  roles: [] as Role[],
  orgs: [] as Array<{ id: string; name: string }>,
  accounts: [] as Array<{
    id: string;
    email: string;
    last_sign_in_at: string | null;
    created_at: string;
  }>,
  rolesError: null as string | null,
  listUsersError: null as string | null,
  listUsersThrows: false,
  byIdCalls: 0,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<(r: any) => boolean> = [];
    private sorts: string[] = [];
    private window: [number, number] | null = null;
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    in(col: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[col]));
      return this;
    }
    order(col: string) {
      this.sorts.push(col);
      return this;
    }
    range(from: number, to: number) {
      this.window = [from, to];
      return this;
    }
    private run() {
      if (this.table === "user_roles" && h.rolesError) {
        return { data: null, error: { message: h.rolesError } };
      }
      const source: any[] =
        this.table === "user_roles" ? h.roles : this.table === "organizations" ? h.orgs : [];
      let rows = source.filter((r) => this.filters.every((f) => f(r)));
      for (const col of this.sorts.slice().reverse()) {
        rows = rows.slice().sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0));
      }
      if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
      return { data: rows, error: null };
    }
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }
  return {
    supabaseAdmin: {
      from: (t: string) => new Query(t),
      auth: {
        admin: {
          listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
            if (h.listUsersThrows) throw new Error("fetch failed");
            if (h.listUsersError) return { data: null, error: { message: h.listUsersError } };
            const start = (page - 1) * perPage;
            return { data: { users: h.accounts.slice(start, start + perPage) }, error: null };
          },
          getUserById: async (uid: string) => {
            h.byIdCalls += 1;
            const user = h.accounts.find((a) => a.id === uid) ?? null;
            return { data: { user }, error: null };
          },
        },
      },
    },
  };
});

import { listPlatformUsers } from "@/lib/platform-directory.functions";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORGS = [
  { id: uuid(901), name: "Southside Scoopers" },
  { id: uuid(902), name: "Northgate Pet Waste" },
  { id: uuid(903), name: "Riverbend Yard Care" },
];
const ROLES = ["owner", "office_manager", "dispatcher", "tech", "tech"];

/** The production shape from the issue: 15 rows, 15 users, every row in an org. */
function seed() {
  h.orgs = ORGS;
  h.roles = Array.from({ length: 15 }, (_, i) => ({
    id: uuid(500 + i),
    user_id: uuid(i + 1),
    role: ROLES[i % ROLES.length],
    organization_id: ORGS[i % ORGS.length].id,
  }));
  // Platform admins and abandoned signups have accounts and no role.
  h.accounts = [
    ...h.roles.map((r, i) => ({
      id: r.user_id,
      email: `member${String(i + 1).padStart(2, "0")}@example.test`,
      last_sign_in_at: null,
      created_at: "2026-10-01T00:00:00Z",
    })),
    {
      id: uuid(800),
      email: "admin@example.test",
      last_sign_in_at: null,
      created_at: "2026-09-01T00:00:00Z",
    },
  ];
}

const list = (data: Record<string, unknown> = {}) => (listPlatformUsers as any)({ data });

beforeEach(() => {
  seed();
  h.rolesError = null;
  h.listUsersError = null;
  h.listUsersThrows = false;
  h.byIdCalls = 0;
  context = {
    userId: uuid(800),
    supabase: { rpc: async () => ({ data: true, error: null }) },
  };
});

describe("the directory lists the members that exist", () => {
  it("returns all fifteen users with email, organization and role", async () => {
    const page = await list();
    // Fifteen members, plus the one account with no role, which since #765 is
    // listed (labelled, not hidden) so support can find it and send a reset.
    expect(page.total).toBe(16);
    expect(page.rows).toHaveLength(16);
    expect(page.scan.membershipRows).toBe(15);
    expect(page.scan.accountsComplete).toBe(true);
    const members = page.rows.filter((r: any) => !r.no_business);
    expect(members).toHaveLength(15);
    for (const row of members) {
      const membership = h.roles.find((r) => r.user_id === row.user_id)!;
      expect(row.email).toMatch(/^member\d\d@example\.test$/);
      expect(row.organizations).toEqual([
        {
          id: membership.organization_id,
          name: ORGS.find((o) => o.id === membership.organization_id)!.name,
          role: membership.role,
        },
      ]);
    }
    // The one account with no role is counted AND listed (#765).
    expect(page.scan.unattached).toBe(1);
    expect(page.rows.filter((r: any) => r.no_business).map((r: any) => r.email)).toEqual([
      "admin@example.test",
    ]);
  });

  it("narrows by role and by organization without losing anybody", async () => {
    const techs = await list({ role: "tech" });
    expect(techs.total).toBe(h.roles.filter((r) => r.role === "tech").length);
    expect(techs.rows.every((r: any) => r.organizations[0].role === "tech")).toBe(true);

    const one = await list({ organization_id: ORGS[0].id });
    expect(one.total).toBe(5);
  });

  it("still lists everyone when the account listing returns an error", async () => {
    h.listUsersError = "Database error finding users";
    const page = await list();
    expect(page.total).toBe(15);
    expect(page.rows.every((r: any) => r.email)).toBe(true);
    expect(page.scan.accountsComplete).toBe(true);
    expect(h.byIdCalls).toBe(15);
    // Without a full listing the number of role-less accounts is unknown.
    expect(page.scan.unattached).toBeNull();
  });

  it("still lists everyone when the account listing throws", async () => {
    h.listUsersThrows = true;
    const page = await list();
    expect(page.total).toBe(15);
    expect(page.rows.every((r: any) => r.email)).toBe(true);
  });

  it("rejects, rather than returning an empty page, when the memberships cannot be read", async () => {
    h.rolesError = "permission denied for table user_roles";
    await expect(list()).rejects.toThrow("permission denied for table user_roles");
  });
});

describe("the screen says a failure is a failure", () => {
  const page = readFileSync("src/routes/platform.users.tsx", "utf8");

  it("renders the load error with a retry when the request fails", () => {
    expect(page).toMatch(/q\.isError \? \(\s*<div[^>]*>\s*<LoadError/);
    expect(page).toMatch(/onRetry=\{\(\) => q\.refetch\(\)\}/);
  });

  it("does not print the empty directory sentence for a failed request", () => {
    expect(page).toMatch(/const failed = q\.isError && !q\.data;/);
    expect(page).toMatch(/: failed\s*\? "The directory could not be loaded/);
    expect(page).toMatch(/\) : failed \? null : rows\.length === 0 \? \(/);
  });
});
