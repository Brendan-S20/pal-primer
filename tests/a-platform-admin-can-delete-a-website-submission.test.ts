import { beforeEach, describe, expect, it, vi } from "vitest";

// Two QA rows from the live contact and early-access forms had no way out of
// Platform > Website forms: rows could only be marked handled or spam. A
// platform admin can now delete one, and the audit keeps no personal details.
//
// This drives the real handler against a stand-in service-role client.

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

const ID = "11111111-1111-4111-8111-111111111111";
const h = vi.hoisted(() => ({ rows: [] as any[], audits: [] as any[] }));

vi.mock("@/integrations/supabase/client.server", () => {
  class Query {
    private filters: Array<(r: any) => boolean> = [];
    private deleting = false;
    constructor(private table: string) {}
    delete() {
      this.deleting = true;
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    select() {
      return this;
    }
    insert(row: unknown) {
      if (this.table === "platform_admin_audit") h.audits.push(row);
      return Promise.resolve({ error: null });
    }
    then(resolve: (v: unknown) => unknown) {
      const hit = h.rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.deleting) h.rows = h.rows.filter((r) => !hit.includes(r));
      return Promise.resolve({ data: hit, error: null }).then(resolve);
    }
  }
  return { supabaseAdmin: { from: (t: string) => new Query(t) } };
});

const { deleteWebsiteSubmission } = await import("@/lib/platform-website-submissions.functions");

function as(admin: boolean) {
  context = {
    userId: "admin-user",
    supabase: { rpc: async () => ({ data: admin, error: null }) },
  };
}

beforeEach(() => {
  h.audits = [];
  h.rows = [
    {
      id: ID,
      form: "contact",
      created_at: "2026-11-18T15:00:00Z",
      name: "QA TEST",
      email: "qa@example.com",
      message: "delete ok",
    },
  ];
});

describe("deleting a website submission", () => {
  it("removes the row and audits it without the submitter's details", async () => {
    as(true);
    const out = await (deleteWebsiteSubmission as any)({ data: { id: ID } });
    expect(out).toEqual({ ok: true, id: ID });
    expect(h.rows).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].action).toBe("delete_website_submission");
    const audited = JSON.stringify(h.audits[0]);
    expect(audited).not.toContain("qa@example.com");
    expect(audited).not.toContain("QA TEST");
  });

  it("refuses anyone who is not a platform admin", async () => {
    as(false);
    await expect((deleteWebsiteSubmission as any)({ data: { id: ID } })).rejects.toThrow(
      "Forbidden",
    );
    expect(h.rows).toHaveLength(1);
    expect(h.audits).toHaveLength(0);
  });

  it("says so when the row is already gone", async () => {
    as(true);
    h.rows = [];
    await expect((deleteWebsiteSubmission as any)({ data: { id: ID } })).rejects.toThrow(
      "Submission not found",
    );
  });

  it("rejects an id that is not a uuid", async () => {
    as(true);
    await expect((deleteWebsiteSubmission as any)({ data: { id: "1; drop" } })).rejects.toThrow();
  });
});
