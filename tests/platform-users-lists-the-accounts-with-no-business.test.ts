import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #765. Platform > Users could not find Detroit Doo Disposal's removed
// teammate. The directory was built from `user_roles`, and an account with no
// membership has no row there, so it was only ever a number in a footnote:
// not searchable, not openable, and not sendable a password reset. Ten such
// accounts were in production.
//
// This drives the real handlers against a stand-in service-role client.

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

const h = vi.hoisted(() => ({
  roles: [] as Array<{ id: string; user_id: string; role: string; organization_id: string }>,
  orgs: [] as Array<{ id: string; name: string }>,
  admins: [] as Array<{ user_id: string }>,
  accounts: [] as Array<{ id: string; email: string; last_sign_in_at: null; created_at: string }>,
  generated: [] as any[],
  orgReads: 0,
  audits: [] as any[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<(r: any) => boolean> = [];
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
    order() {
      return this;
    }
    range(from: number, to: number) {
      this.window = [from, to];
      return this;
    }
    insert(row: unknown) {
      if (this.table === "platform_admin_audit") h.audits.push(row);
      return Promise.resolve({ error: null });
    }
    private run() {
      if (this.table === "organizations") h.orgReads += 1;
      const source: any[] =
        this.table === "user_roles"
          ? h.roles
          : this.table === "organizations"
            ? h.orgs
            : this.table === "platform_admins"
              ? h.admins
              : [];
      let rows = source.filter((r) => this.filters.every((f) => f(r)));
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
            const start = (page - 1) * perPage;
            return { data: { users: h.accounts.slice(start, start + perPage) }, error: null };
          },
          getUserById: async (uid: string) => ({
            data: { user: h.accounts.find((a) => a.id === uid) ?? null },
            error: null,
          }),
          generateLink: async (args: any) => {
            h.generated.push(args);
            return {
              data: {
                properties: { action_link: "https://api.example.test/verify?type=recovery" },
              },
              error: null,
            };
          },
        },
      },
    },
  };
});

import { listPlatformUsers, sendPasswordReset } from "@/lib/platform-directory.functions";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = { id: uuid(901), name: "Detroit Doo Disposal" };
const ORPHAN = uuid(765);
const ADMIN = uuid(800);

beforeEach(() => {
  h.orgs = [ORG];
  h.roles = [
    { id: uuid(501), user_id: uuid(1), role: "owner", organization_id: ORG.id },
    { id: uuid(502), user_id: uuid(2), role: "tech", organization_id: ORG.id },
  ];
  h.admins = [{ user_id: ADMIN }];
  h.accounts = [
    {
      id: uuid(1),
      email: "owner@example.test",
      last_sign_in_at: null,
      created_at: "2026-07-01T00:00:00Z",
    },
    {
      id: uuid(2),
      email: "tech@example.test",
      last_sign_in_at: null,
      created_at: "2026-07-01T00:00:00Z",
    },
    // The removed teammate: an account, and nothing in user_roles.
    {
      id: ORPHAN,
      email: "removed@example.test",
      last_sign_in_at: null,
      created_at: "2026-07-14T00:00:00Z",
    },
    {
      id: ADMIN,
      email: "admin@example.test",
      last_sign_in_at: null,
      created_at: "2026-06-01T00:00:00Z",
    },
  ];
  h.generated = [];
  h.orgReads = 0;
  h.audits = [];
  delete process.env.RESEND_API_KEY;
  context = { userId: ADMIN, supabase: { rpc: async () => ({ data: true, error: null }) } };
});

const list = (data: Record<string, unknown> = {}) => (listPlatformUsers as any)({ data });

describe("an account with no business is in the directory", () => {
  it("is listed, labelled, and counted", async () => {
    const page = await list();
    const orphan = page.rows.find((r: any) => r.user_id === ORPHAN);
    expect(orphan, "the removed teammate's account is not in the directory").toBeTruthy();
    expect(orphan).toMatchObject({
      email: "removed@example.test",
      organizations: [],
      no_business: true,
      platform_admin: false,
    });
    expect(page.total).toBe(4);
    expect(page.scan.unattached).toBe(2);
  });

  it("is found by its email, and by searching the label", async () => {
    const byEmail = await list({ search: "removed@" });
    expect(byEmail.rows.map((r: any) => r.user_id)).toEqual([ORPHAN]);
    const byLabel = await list({ search: "no business" });
    expect(byLabel.rows.map((r: any) => r.user_id)).toEqual([ORPHAN]);
  });

  it("a platform admin is labelled as one, not as No business", async () => {
    const page = await list();
    expect(page.rows.find((r: any) => r.user_id === ADMIN)).toMatchObject({
      no_business: true,
      platform_admin: true,
    });
  });

  it("member rows are unchanged, and a filter still lists only members", async () => {
    const page = await list();
    const owner = page.rows.find((r: any) => r.user_id === uuid(1));
    expect(owner).toEqual({
      user_id: uuid(1),
      email: "owner@example.test",
      last_sign_in_at: null,
      created_at: "2026-07-01T00:00:00Z",
      organizations: [{ id: ORG.id, name: ORG.name, role: "owner" }],
    });
    const techs = await list({ role: "tech" });
    expect(techs.rows.map((r: any) => r.user_id)).toEqual([uuid(2)]);
    const org = await list({ organization_id: ORG.id });
    expect(org.total).toBe(2);
  });
});

describe("a password reset for an account with no business", () => {
  it("is created without looking up any organization", async () => {
    const r = await (sendPasswordReset as any)({ data: { userId: ORPHAN } });
    expect(r).toMatchObject({ sent: false, email: "removed@example.test" });
    expect(r.actionLink).toContain("type=recovery");
    expect(h.generated).toEqual([{ type: "recovery", email: "removed@example.test" }]);
    expect(h.orgReads).toBe(0);
    expect(h.audits[0]).toMatchObject({ organization_id: null, action: "send_password_reset" });
  });

  it("says what failed, in words", async () => {
    h.accounts = h.accounts.map((a) => (a.id === ORPHAN ? { ...a, email: "" } : a));
    await expect((sendPasswordReset as any)({ data: { userId: ORPHAN } })).rejects.toThrow(
      "This user has no email on file.",
    );
  });
});

describe("the screen", () => {
  const src = readFileSync(new URL("../src/routes/platform.users.tsx", import.meta.url), "utf8");
  it("labels a row with no organization 'No business', or 'Platform admin'", () => {
    expect(src).toMatch(/u\.platform_admin \? "Platform admin" : NO_BUSINESS_LABEL/);
    expect(src).not.toContain(">No org<");
  });
  it("still shows a reset failure as an error", () => {
    expect(src).toMatch(
      /mutationFn: \(\) => resetFn\(\{ data: \{ userId: userId! \} \}\),[\s\S]{0,400}onError: \(e: Error\) => toast\.error\(e\.message\)/,
    );
  });
});
