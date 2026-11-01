// An invited name is kept (#651, R2-10 / F-26).
//
// Four faults, one outcome: an invited teammate could not end up with their
// own name anywhere in the product.
//
//   1. accept_org_invite_for_current_user wrote the email prefix as the staff
//      name and ignored the name typed on Get started. Customers read
//      "Walked by tech1-walk-r2".
//   2. /profile renamed through an RLS update that only managers pass. A tech's
//      save matched no row, raised nothing, and the page said "Profile saved".
//   3. /auth?invite= made the person type the invited address again, and the
//      address rode to /get-started in the URL.
//   4. /sign-up with a pending invitation asked for a business and said
//      "Create my workspace", then joined anyway.
//
// This file pins each. The SQL half runs tests/sql/an-invited-name-is-kept.proof.sql
// against the local stack when one answers.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = join(ROOT, "supabase/migrations/20261101160000_an-invited-name-is-kept.sql");
const PROOF = join(ROOT, "tests/sql/an-invited-name-is-kept.proof.sql");

// ── Server functions, run with a fake client ─────────────────────────────────

/** A server function as the mock below builds it: called with `{ data }`. */
type CallServerFn = (args: { data: unknown }) => Promise<unknown>;

const state = vi.hoisted(() => ({
  userDb: null as unknown,
  adminDb: null as unknown,
}));

vi.mock("@tanstack/react-start", () => {
  const createServerFn = () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: state.userDb, userId: "tech-1" } }),
    };
    return builder;
  };
  return { createServerFn, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return state.adminDb;
  },
}));

/** A client that behaves the way Postgres does for a tech: an UPDATE on staff
 *  through RLS matches no row and reports no error. */
function techClient(rpcResult: { data: unknown; error: { message: string } | null }) {
  const calls = { rlsUpdates: 0, rpc: [] as Array<[string, unknown]> };
  const db = {
    from: (table: string) => ({
      update: () => ({
        eq: async () => {
          if (table === "staff") calls.rlsUpdates += 1;
          return { data: null, error: null, count: 0 };
        },
      }),
    }),
    rpc: async (fn: string, args: unknown) => {
      calls.rpc.push([fn, args]);
      return rpcResult;
    },
  };
  return { db, calls };
}

describe("a tech's rename is saved, or the page says it was not (F-26)", () => {
  it("writes through update_my_staff_profile, not an RLS update a tech cannot pass", async () => {
    const { db, calls } = techClient({ data: "staff-1", error: null });
    state.userDb = db;
    const { updateMyProfile } = await import("@/lib/profile.functions");
    await expect(
      (updateMyProfile as unknown as CallServerFn)({
        data: { displayName: "  Maria Lopez ", phone: "" },
      }),
    ).resolves.toEqual({ ok: true });
    expect(calls.rlsUpdates).toBe(0);
    expect(calls.rpc).toEqual([
      ["update_my_staff_profile", { _display_name: "Maria Lopez", _phone: undefined }],
    ]);
  });

  it("rejects when the write did not happen, so 'Profile saved' is never shown", async () => {
    const { db } = techClient({
      data: null,
      error: { message: "No staff record for this account" },
    });
    state.userDb = db;
    const { updateMyProfile } = await import("@/lib/profile.functions");
    await expect(
      (updateMyProfile as unknown as CallServerFn)({ data: { displayName: "Maria", phone: null } }),
    ).rejects.toThrow("No staff record for this account");
  });

  it("the page toasts 'Profile saved' only from onSuccess of that call", () => {
    const src = read("src/routes/_authenticated/profile.tsx");
    const save = src.slice(src.indexOf("const save = useMutation"), src.indexOf("const upload"));
    expect(save).toMatch(/mutationFn: \(\) => saveFn\(/);
    expect(save).toMatch(/onSuccess: \(\) => \{\s*toast\.success\("Profile saved"\)/);
  });
});

describe("an address with a pending invitation is told so (sign-up never asks for a business)", () => {
  function adminWith(opts: { exists: boolean; invites: unknown[] }) {
    const seen: Record<string, unknown> = {};
    const chain: Record<string, (...args: string[]) => unknown> = {
      select: () => chain,
      ilike: (col: string, v: string) => ((seen.ilike = [col, v]), chain),
      eq: (col: string, v: string) => ((seen[`eq:${col}`] = v), chain),
      gt: () => chain,
      limit: async () => ({ data: opts.invites, error: null }),
    };
    return {
      seen,
      db: {
        rpc: async () => ({ data: opts.exists, error: null }),
        from: (t: string) => {
          seen.table = t;
          return chain;
        },
      },
    };
  }

  it("says pendingInvite for a new address that has one", async () => {
    const a = adminWith({ exists: false, invites: [{ id: "inv-1" }] });
    state.adminDb = a.db;
    const { checkEmailAccount } = await import("@/lib/auth-entry.functions");
    await expect(
      (checkEmailAccount as unknown as CallServerFn)({ data: { email: "tech1_walk@x.test" } }),
    ).resolves.toEqual({ exists: false, pendingInvite: true });
    expect(a.seen.table).toBe("org_invites");
    expect(a.seen["eq:status"]).toBe("pending");
    // `_` is a LIKE wildcard; the address is matched exactly.
    expect(a.seen.ilike).toEqual(["email", "tech1\\_walk@x.test"]);
  });

  it("says no invitation when there is none", async () => {
    state.adminDb = adminWith({ exists: false, invites: [] }).db;
    const { checkEmailAccount } = await import("@/lib/auth-entry.functions");
    await expect(
      (checkEmailAccount as unknown as CallServerFn)({ data: { email: "owner@x.test" } }),
    ).resolves.toEqual({
      exists: false,
      pendingInvite: false,
    });
  });

  it("Get started checks the address before the business step, and joins instead", () => {
    const src = read("src/routes/get-started.tsx");
    const page = src.slice(
      src.indexOf("function NewBusinessPage"),
      src.indexOf("function JoinTeamPage"),
    );
    // Step 0 no longer jumps to the business step on its own.
    expect(page).not.toMatch(/if \(step0Valid\) setStep\(1\)/);
    expect(page).toMatch(/checkEmailAccount\(/);
    expect(page).toMatch(/if \(r\.pendingInvite\)/);
    // The invited branch returns before the stepper ("Your business") and the
    // "Create my workspace" button are rendered.
    const invitedBranch = page.slice(
      page.indexOf("if (invited) {"),
      page.indexOf("const step1Valid"),
    );
    expect(invitedBranch).toMatch(/acceptPendingInvite\(null\)|<form/);
    expect(invitedBranch).not.toMatch(/Your business|Business name|workspace/i);
    expect(page.indexOf("if (invited) {")).toBeLessThan(page.indexOf("STEPS.map"));
    expect(page).toMatch(/\{step > 0 && \(/);
  });
});

describe("the invited address is prefilled and kept out of the URL", () => {
  it("/auth prefills the address from the invitation", () => {
    const src = read("src/routes/auth.tsx");
    expect(src).toMatch(/lookupInviteFn\(\{ data: \{ token: inviteToken \} \}\)/);
    expect(src).toMatch(/setEmail\(\(typed\) => \(typed\.trim\(\) \? typed : r\.email!\)\)/);
  });

  it("no navigation to /get-started carries an email", () => {
    for (const file of ["src/routes/auth.tsx", "src/routes/sign-up.tsx"]) {
      const src = read(file);
      let at = src.indexOf('to: "/get-started"');
      expect(at, file).toBeGreaterThan(-1);
      while (at > -1) {
        const call = src.slice(at, src.indexOf("});", at));
        expect(call, `${file} puts the email in the /get-started URL`).not.toMatch(
          /email: (?!undefined)/,
        );
        at = src.indexOf('to: "/get-started"', at + 1);
      }
    }
  });

  it("Get started takes ?email= off the URL and the invite page prefills from the invitation", () => {
    const src = read("src/routes/get-started.tsx");
    expect(src).toMatch(/search: \{ \.\.\.search, email: undefined \}, replace: true/);
    expect(src).toMatch(/function JoinTeamPage\(\{ token \}: \{ token: string \}\)/);
    expect(src).toMatch(/if \(invite\?\.email\) setEmail/);
  });
});

describe("accept_org_invite_for_current_user keeps the typed name (R2-10)", () => {
  /** The newest migration that (re)defines the function. */
  const newest = () => {
    const files = migrationFiles().filter((f) =>
      /CREATE OR REPLACE FUNCTION public\.accept_org_invite_for_current_user/i.test(
        readMigration(f),
      ),
    );
    const file = files[files.length - 1];
    const sql = stripLineComments(readMigration(file));
    const at = sql.search(/CREATE OR REPLACE FUNCTION public\.accept_org_invite_for_current_user/i);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    return { file, body };
  };

  it("reads the display_name the person typed", () => {
    const { file, body } = newest();
    expect(body, file).toMatch(/raw_user_meta_data/);
    expect(body, file).toMatch(/->>\s*'display_name'/);
  });

  it("uses the email prefix only as the fallback, and writes the email", () => {
    const { file, body } = newest();
    const insert = body.slice(body.search(/INSERT INTO public\.staff/i));
    expect(insert, file).not.toMatch(/split_part/);
    expect(insert, file).toMatch(/display_name, email, active/);
    expect(body, file).toMatch(/coalesce\(_name, split_part\(_email, '@', 1\)\)/);
  });

  it("still keeps the pre-claim guard and the accepted-invitation-is-a-seat rule", () => {
    const { file, body } = newest();
    expect(body, file).toMatch(/created_at < _created/);
    expect(body, file).toMatch(/token = _token/);
    expect(body, file).toMatch(/_name, _email, true\)/);
  });

  it("keeps the text 20261009180000's splice looks for, so off-means-off.proof.sql still replays", () => {
    // Read with comments: the splice uses pg_get_functiondef, which keeps them.
    expect(readFileSync(MIGRATION, "utf8")).toContain("split_part(_email, '@', 1), true);");
  });
});

// ── In a real database ───────────────────────────────────────────────────────

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the invited-name proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("an invited name is kept, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("the typed name is staff.display_name, and a tech's rename persists", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(7);
    expect(out).toMatch(/ALL INVITED-NAME PROOFS PASSED/);
  });
});
