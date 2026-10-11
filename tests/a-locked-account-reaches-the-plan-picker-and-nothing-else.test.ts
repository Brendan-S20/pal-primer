// A locked account reaches the plan picker and nothing else (spec NP-12).
//
//   Day 14 with no plan    locked until a plan is chosen; data kept 30 days.
//   A cancelled plan,      locked the same way, but may export its data for
//   once it has ended      30 days.
//   Choosing a plan        unlocks at once.
//   Deletion               30 days after the lock (or after the deploy, for
//                          accounts already locked), by a job that SHIPS OFF.
//
// The lock's rule is pure and tested as such. The server check that every
// server function passes through is run with its lookup faked. The deletion
// job is run against a fake service-role client, so "it deleted nothing" is a
// fact about the calls it made. The database half (purge_locked_account) was
// proved inside BEGIN … ROLLBACK against a local database; see the PR.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_LOCKED_MESSAGE,
  accountLockFor,
  exportAllowed,
  pathOpenWhenLocked,
  serverFnOpenWhenLocked,
} from "@/lib/account-lock";
import { forgetAccountLocks, refuseIfLocked, subFromBearer } from "@/lib/account-lock.server";
import {
  ACCOUNT_DELETION_DEPLOYED_ON,
  ACCOUNT_DELETION_ENABLED,
  runAccountDeletion,
} from "@/lib/account-deletion.server";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NOW = new Date("2026-10-20T12:00:00Z");

const base = {
  plan_status: "trialing",
  billing_status: "free",
  trial_ends_at: "2026-10-01T00:00:00Z",
  stripe_subscription_id: null,
  created_at: "2026-09-17T00:00:00Z",
  is_comped: false,
  current_period_end: null,
  suspended_at: null,
};

describe("who is locked", () => {
  it("locks a trial past day 14 with no plan", () => {
    expect(accountLockFor(base, NOW)).toEqual({
      locked: true,
      reason: "trial_ended",
      since: "2026-10-01T00:00:00Z",
      exportUntil: null,
    });
  });

  it("does not lock a trial still running, a paying account, or a comped one", () => {
    expect(accountLockFor({ ...base, trial_ends_at: "2026-10-25T00:00:00Z" }, NOW).locked).toBe(false);
    expect(accountLockFor({ ...base, plan_status: "active", billing_status: "active" }, NOW).locked).toBe(false);
    expect(accountLockFor({ ...base, stripe_subscription_id: "sub_123" }, NOW).locked).toBe(false);
    expect(accountLockFor({ ...base, is_comped: true }, NOW).locked).toBe(false);
  });

  it("keeps the grandfather date: an account made before trials existed is not locked", () => {
    expect(accountLockFor({ ...base, created_at: "2026-08-01T00:00:00Z" }, NOW).locked).toBe(false);
  });

  it("keeps the grandfather date after a plan ends too: full access, never locked (owner, 2026-10-10)", () => {
    const ended = {
      ...base,
      plan_status: "canceled",
      billing_status: "canceled",
      stripe_subscription_id: "sub_old",
      current_period_end: "2026-10-10T00:00:00Z",
    };
    expect(accountLockFor({ ...ended, created_at: "2026-08-15T23:59:59Z" }, NOW)).toEqual({ locked: false });
    expect(accountLockFor({ ...ended, created_at: "2026-08-16T00:00:00Z" }, NOW).locked).toBe(true);
  });

  it("locks a cancelled plan once it has ended, with 30 days to export", () => {
    const lock = accountLockFor(
      { ...base, plan_status: "canceled", billing_status: "canceled", current_period_end: "2026-10-10T00:00:00Z" },
      NOW,
    );
    expect(lock).toEqual({
      locked: true,
      reason: "plan_ended",
      since: "2026-10-10T00:00:00Z",
      exportUntil: "2026-11-09T00:00:00.000Z",
    });
    expect(exportAllowed(lock, NOW)).toBe(true);
    expect(exportAllowed(lock, new Date("2026-11-10T00:00:00Z"))).toBe(false);
  });

  it("does not let a trial lock export", () => {
    expect(exportAllowed(accountLockFor(base, NOW), NOW)).toBe(false);
    expect(exportAllowed({ locked: false }, NOW)).toBe(true);
  });

  it("leaves a suspension to its own process", () => {
    expect(accountLockFor({ ...base, plan_status: "canceled", suspended_at: "2026-10-02T00:00:00Z" }, NOW).locked).toBe(false);
  });

  it("is lifted the moment a plan is chosen", () => {
    const after = { ...base, plan_status: "active", billing_status: "active", stripe_subscription_id: "sub_new" };
    expect(accountLockFor(after, NOW)).toEqual({ locked: false });
  });
});

describe("what a locked account can reach", () => {
  it("one page: Plan & billing", () => {
    expect(pathOpenWhenLocked("/settings/billing")).toBe(true);
    for (const p of ["/dashboard", "/clients", "/my-day", "/settings", "/settings/users", "/routes", "/invoices"]) {
      expect(pathOpenWhenLocked(p), p).toBe(false);
    }
  });

  it("the plan picker, checkout and the shell's own reads, and nothing else", () => {
    const open = (filename: string, name: string) => serverFnOpenWhenLocked({ filename, name });
    expect(open("src/lib/billing.functions.ts", "createPlanSubscription")).toBe(true);
    expect(open("src/lib/billing.functions.ts", "listPlatformPlans")).toBe(true);
    expect(open("src/lib/org.functions.ts", "getMyOrg")).toBe(true);
    expect(open("src/lib/org.functions.ts", "updateOrgSettings")).toBe(false);
    expect(open("src/lib/platform-addons.functions.ts", "subscribePlatformAddon")).toBe(false);
    expect(open("src/lib/clients.functions.ts", "listClients")).toBe(false);
    expect(open("src/lib/my-day.functions.ts", "getMyDay")).toBe(false);
    expect(serverFnOpenWhenLocked(null)).toBe(false);
  });
});

function bearerFor(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `Bearer ${b64({ alg: "HS256" })}.${b64({ sub })}.sig`;
}

describe("the server check every function passes through", () => {
  beforeEach(() => forgetAccountLocks());
  const clientsFn = { filename: "src/lib/clients.functions.ts", name: "listClients" };

  it("reads the caller from the token", () => {
    expect(subFromBearer(bearerFor("user-1"))).toBe("user-1");
    expect(subFromBearer("Bearer nonsense")).toBeNull();
    expect(subFromBearer(null)).toBeNull();
  });

  it("refuses a locked caller, in the lock's own words", async () => {
    const lookup = vi.fn(async () => ({ lock: accountLockFor(base, NOW) }));
    await expect(
      refuseIfLocked({ authorization: bearerFor("u1"), meta: clientsFn, now: NOW, lookup }),
    ).rejects.toThrow(ACCOUNT_LOCKED_MESSAGE);
  });

  it("lets a locked caller reach checkout without even looking them up", async () => {
    const lookup = vi.fn(async () => ({ lock: accountLockFor(base, NOW) }));
    await refuseIfLocked({
      authorization: bearerFor("u1"),
      meta: { filename: "src/lib/billing.functions.ts", name: "createPlanSubscription" },
      now: NOW,
      lookup,
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("is not its business when there is no bearer (portal, signup, webhooks)", async () => {
    const lookup = vi.fn();
    await refuseIfLocked({ authorization: null, meta: clientsFn, now: NOW, lookup });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("caches 'not locked', never 'locked', so choosing a plan unlocks at once", async () => {
    const open = vi.fn(async () => ({ lock: { locked: false } as const }));
    await refuseIfLocked({ authorization: bearerFor("u2"), meta: clientsFn, now: NOW, lookup: open });
    await refuseIfLocked({ authorization: bearerFor("u2"), meta: clientsFn, now: NOW, lookup: open });
    expect(open).toHaveBeenCalledTimes(1);

    const locked = vi.fn(async () => ({ lock: accountLockFor(base, NOW) }));
    for (let i = 0; i < 2; i += 1) {
      await expect(
        refuseIfLocked({ authorization: bearerFor("u3"), meta: clientsFn, now: NOW, lookup: locked }),
      ).rejects.toThrow();
    }
    expect(locked).toHaveBeenCalledTimes(2);
  });

  it("does not lock everybody out when the lookup fails", async () => {
    const broken = vi.fn(async () => {
      throw new Error("db down");
    });
    await refuseIfLocked({ authorization: bearerFor("u4"), meta: clientsFn, now: NOW, lookup: broken });
  });

  it("is registered for every server function, ahead of error reporting", () => {
    const start = read("src/start.ts");
    expect(start).toMatch(/functionMiddleware: \[attachSupabaseAuth, accountLockMiddleware, reportServerFnErrors\]/);
    expect(start).toMatch(/refuseIfLocked\(\{ authorization, meta: serverFnMeta \}\)/);
  });

  it("is applied before any page loads, and sends a locked owner to Plan & billing", () => {
    const route = read("src/routes/_authenticated/route.tsx");
    expect(route).toMatch(/lock\?\.locked && lock\.canChoosePlan && !pathOpenWhenLocked\(location\.pathname\)/);
    expect(route).toMatch(/throw redirect\(\{ to: "\/settings\/billing" \}\)/);
    expect(route).toMatch(/<AccountLockedShell/);
  });

  it("closes the client portal for a locked business", () => {
    const portal = read("src/lib/portal-auth.server.ts");
    expect(portal.match(/await businessLocked\(/g)?.length).toBe(3);
  });
});

// ── The deletion job ─────────────────────────────────────────────────────

type Call = { kind: string; args: unknown };
function fakeAdmin(candidates: Array<Record<string, unknown>>, purgeRefuses: string | null = null) {
  const calls: Call[] = [];
  const builder = (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      is: () => q,
      not: () => q,
      order: () => q,
      limit: () => q,
      upsert: (p: unknown) => (calls.push({ kind: `upsert:${table}`, args: p }), q),
      delete: () => (calls.push({ kind: `delete:${table}`, args: null }), q),
      then: (res: any) => Promise.resolve({ data: table === "user_roles" ? [{ user_id: "u1", organization_id: "org-1" }] : [], error: null }).then(res),
    };
    return q;
  };
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ kind: `rpc:${fn}`, args });
      if (fn === "account_deletion_candidates") return { data: candidates, error: null };
      if (purgeRefuses) return { data: null, error: { message: purgeRefuses } };
      return {
        data: { delete: { visits: 10, properties: 2 }, keep: { invoices: 3 } },
        error: null,
      };
    },
    from: builder,
    storage: {
      from: () => ({
        list: async () => ({ data: [{ id: "f1", name: "a.jpg" }], error: null }),
        remove: async (paths: string[]) => (calls.push({ kind: "storage:remove", args: paths }), { error: null }),
      }),
    },
    auth: {
      admin: {
        updateUserById: async (id: string) => (calls.push({ kind: "auth:anonymise", args: id }), {}),
        signOut: async () => ({}),
      },
    },
  };
  return { admin, calls };
}

const due = { organization_id: "org-1", reason: "trial_ended", locked_since: "2026-09-01T00:00:00Z", delete_after: "2026-11-08T00:00:00Z" };

describe("the deletion job", () => {
  it("ships disabled, with no deploy date", () => {
    expect(ACCOUNT_DELETION_ENABLED).toBe(false);
    expect(ACCOUNT_DELETION_DEPLOYED_ON).toBeNull();
  });

  it("disabled, it only counts: dry runs, no schedule written, no files, no sign-ins", async () => {
    const { admin, calls } = fakeAdmin([due]);
    const r = await runAccountDeletion({ admin, now: new Date("2026-12-01T00:00:00Z") });
    expect(r.dryRun).toBe(true);
    expect(r.deployedOnIsHypothetical).toBe(true);
    expect(r.accounts).toBe(1);
    expect(r.recordsToDelete).toBe(12);
    expect(r.recordsKept).toBe(3);
    expect(r.earliestDeleteAfter).toBe("2026-11-08T00:00:00Z");
    const purges = calls.filter((c) => c.kind === "rpc:purge_locked_account");
    expect(purges).toHaveLength(1);
    expect((purges[0].args as any)._dry_run).toBe(true);
    expect(calls.some((c) => /^(upsert|delete|storage|auth):/.test(c.kind))).toBe(false);
  });

  it("enabled but with no deploy date, it still only counts", async () => {
    const { admin, calls } = fakeAdmin([due]);
    const r = await runAccountDeletion({ admin, enabled: true, deployedOn: null, now: new Date("2026-12-01T00:00:00Z") });
    expect(r.dryRun).toBe(true);
    expect(calls.filter((c) => c.kind === "rpc:purge_locked_account").every((c) => (c.args as any)._dry_run)).toBe(true);
  });

  it("enabled, an account not yet due is only counted", async () => {
    const { admin, calls } = fakeAdmin([due]);
    const r = await runAccountDeletion({ admin, enabled: true, deployedOn: "2026-10-09", now: new Date("2026-11-01T00:00:00Z") });
    expect(r.dryRun).toBe(false);
    expect(r.dueNow).toBe(0);
    expect(calls.filter((c) => c.kind === "rpc:purge_locked_account").every((c) => (c.args as any)._dry_run)).toBe(true);
    expect(calls.some((c) => /^(storage|auth):/.test(c.kind))).toBe(false);
  });

  it("enabled and due: the database's own check, then files, then the purge, then the sign-ins", async () => {
    const { admin, calls } = fakeAdmin([due]);
    const r = await runAccountDeletion({ admin, enabled: true, deployedOn: "2026-10-09", now: new Date("2026-11-09T00:00:00Z") });
    expect(r.dueNow).toBe(1);
    const steps = calls
      .filter((c) => /^(storage|rpc:purge|auth)/.test(c.kind))
      .map((c) => (c.kind === "rpc:purge_locked_account" ? `purge:${(c.args as any)._dry_run ? "dry" : "real"}` : c.kind));
    expect(steps[0]).toBe("purge:dry");
    expect(steps.indexOf("storage:remove")).toBeGreaterThan(0);
    expect(steps.indexOf("purge:real")).toBeGreaterThan(steps.lastIndexOf("storage:remove"));
    expect(steps[steps.length - 1]).toBe("auth:anonymise");
    const real = calls.find((c) => c.kind === "rpc:purge_locked_account" && !(c.args as any)._dry_run)!.args as any;
    expect(real).toMatchObject({ _org: "org-1", _dry_run: false, _deployed_on: "2026-10-09" });
  });

  it("enabled and due, but the database refuses: no file, no sign-in and no real purge is touched", async () => {
    const { admin, calls } = fakeAdmin([due], "organization org-1 was created before 2026-08-16; it is never deleted");
    const r = await runAccountDeletion({ admin, enabled: true, deployedOn: "2026-10-09", now: new Date("2026-11-09T00:00:00Z") });
    expect(r.perAccount[0].error).toMatch(/never deleted/);
    expect(calls.some((c) => /^(storage|auth):/.test(c.kind))).toBe(false);
    expect(calls.filter((c) => c.kind === "rpc:purge_locked_account").every((c) => (c.args as any)._dry_run)).toBe(true);
  });

  it("is in the nightly run, and reports what it would delete", () => {
    const nightly = read("src/routes/api/public/hooks/nightly.ts");
    expect(nightly).toMatch(/runAccountDeletion\(\)/);
    expect(nightly).toMatch(/account_deletion: accountDeletion/);
  });
});

describe("the database half", () => {
  const SQL = read("supabase/migrations/20261009170000_a-locked-account-is-deleted-after-thirty-days.sql").replace(
    /--[^\n]*/g,
    "",
  );

  it("defaults to a dry run, and is service-role only", () => {
    expect(SQL).toMatch(/_dry_run boolean DEFAULT true/);
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.purge_locked_account\(uuid, boolean, date, timestamptz\) FROM PUBLIC, anon, authenticated;/);
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.account_deletion_candidates\(date, timestamptz\) FROM PUBLIC, anon, authenticated;/);
  });

  it("refuses to delete without a deploy date, or before the account is due", () => {
    expect(SQL).toMatch(/IF NOT _dry_run AND _deployed_on IS NULL THEN\s+RAISE EXCEPTION/);
    expect(SQL).toMatch(/IF NOT _dry_run AND _cand\.delete_after > _now THEN\s+RAISE EXCEPTION/);
  });

  it("never makes, or purges, an account the app does not lock (created before TRIAL_ENFORCEMENT_FROM)", () => {
    // Both branches, not only trial_ended: the gate sits on the row set.
    expect(SQL).toMatch(/WHERE NOT org\.is_comped\s+AND org\.created_at >= public\.trial_enforcement_from\(\)/);
    // The purge checks the row itself, before it asks the candidate list.
    const purge = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.purge_locked_account"));
    const guard = purge.search(/IF _created IS NULL OR _created < public\.trial_enforcement_from\(\) THEN\s+RAISE EXCEPTION/);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(purge.indexOf("FROM public.account_deletion_candidates("));
  });

  it("dates every account from the later of its lock and the deploy, plus 30 days", () => {
    expect(SQL).toMatch(/GREATEST\(c\.locked_since, _deployed_on::timestamptz\) \+ interval '30 days'/);
  });

  it("keeps the money and the audit trail, and the SMS consent in its own table", () => {
    for (const t of ["invoices", "payments", "credit_ledger", "activity_log", "platform_admin_audit", "platform_invoices", "sms_consent_records"]) {
      expect(SQL, t).toMatch(new RegExp(`_kept_tables constant text\\[\\] := ARRAY\\[[\\s\\S]*'${t}'`));
    }
    expect(SQL).toMatch(/INSERT INTO public\.sms_consent_records/);
    expect(SQL).not.toMatch(/DELETE FROM public\.sms_consent_records/);
    // The organization row is anonymised, never deleted (invoices cascade from it).
    expect(SQL).not.toMatch(/DELETE FROM public\.organizations/);
  });
});
