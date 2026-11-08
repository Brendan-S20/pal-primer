// A portal change waits for the owner, when the owner says so (#730; audit
// F-18, F-21, R2-41; decision D6 option C, and "The tenant, or business owner
// needs to have a way to choose").
//
// This file:
//   * runs the office server functions as each role: only an owner changes
//     the setting or answers a request, refused BEFORE any RPC, and the org is
//     always the caller's own (never one the browser names);
//   * runs the portal handlers against both policies: INSTANT applies and
//     attempts the fee, APPROVAL files the request and charges nothing;
//   * runs the fee module: off by default, test mode only, the amount from the
//     database, one idempotency key per fee, no payment_method_types, and the
//     webhook matched by account and deduplicated by the database;
//   * pins the migration and the webhook wiring;
//   * runs tests/sql/a-portal-change-waits-for-the-owner.proof.sql against a
//     real database when one answers (skipped, loudly, when none does). That
//     proof is where cross-tenant refusal, the REST path and the backfill of
//     existing businesses are proved in Postgres.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261108153700_a-portal-change-waits-for-the-owner-when-the-owner-says-so.sql",
);
const PROOF = join(ROOT, "tests/sql/a-portal-change-waits-for-the-owner.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ORG_A = "0a000000-0000-4000-8000-000000073000";
const ORG_B = "0b000000-0000-4000-8000-000000073000";
const REQ = "9a000000-0000-4000-8000-000000073001";
const VISIT = "7a000000-0000-4000-8000-000000073001";
const TOKEN = "aaaaaaaa-0000-4000-8000-0000000730a1";
const KEY = "11111111-2222-4333-8444-555555555555";

// ── Shared fakes ──────────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  role: "owner" as string,
  orgId: "0a000000-0000-4000-8000-000000073000",
  rpcs: [] as Array<{ fn: string; args: any }>,
  rpcResult: {} as Record<string, unknown>,
  feeCalls: [] as string[],
}));

const db = {
  from: (_t: string) => {
    const api: any = {
      select: () => api,
      eq: () => api,
      neq: () => api,
      order: () => api,
      limit: () => api,
      maybeSingle: async () => ({
        data: { visit_id: "7a000000-0000-4000-8000-000000073001" },
        error: null,
      }),
      then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }),
    };
    return api;
  },
  rpc: async (fn: string, args: any) => {
    state.rpcs.push({ fn, args });
    return { data: state.rpcResult[fn] ?? null, error: null };
  },
};

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data), context: { supabase: db, userId: "caller-1" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: state.orgId, role: state.role }),
  requirePermission: async () => ({ orgId: state.orgId, role: state.role }),
}));
vi.mock("@/lib/portal-auth.server", () => ({
  requirePortalSession: async () => ({
    clientId: "c0000000-0000-4000-8000-0000000730a1",
    organizationId: "0a000000-0000-4000-8000-000000073000",
  }),
}));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/portal-change-fees.server", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    chargePortalChangeFee: async (id: string) => {
      state.feeCalls.push(id);
      return { outcome: "not_charged", reason: "test" };
    },
  };
});

beforeEach(() => {
  state.rpcs.length = 0;
  state.feeCalls.length = 0;
  state.rpcResult = {};
  state.orgId = ORG_A;
});

// ── The owner's setting ───────────────────────────────────────────────────
describe("only an owner chooses INSTANT or APPROVAL", () => {
  for (const role of ["office_manager", "dispatcher", "tech"]) {
    it(`refuses ${role} before any RPC, for the policy, the switch and the rules`, async () => {
      state.role = role;
      const { setPortalChangeSettings } = await import("@/lib/portal-change.functions");
      const { ONLY_AN_OWNER_CHANGES_PORTAL_POLICY } = await import("@/lib/portal-change");
      for (const data of [{ policy: "instant" }, { policy: "approval" }, { autocharge: true }]) {
        await expect(setPortalChangeSettings({ data } as any)).rejects.toThrow(
          ONLY_AN_OWNER_CHANGES_PORTAL_POLICY,
        );
      }
      expect(state.rpcs).toEqual([]);
    });
  }

  it("lets an owner choose either, for their OWN business only", async () => {
    state.role = "owner";
    const { setPortalChangeSettings } = await import("@/lib/portal-change.functions");
    await setPortalChangeSettings({ data: { policy: "instant" } } as any);
    await setPortalChangeSettings({ data: { policy: "approval", autocharge: false } } as any);
    expect(state.rpcs.map((r) => [r.fn, r.args._org, r.args._policy])).toEqual([
      ["set_portal_change_settings", ORG_A, "instant"],
      ["set_portal_change_settings", ORG_A, "approval"],
    ]);
    // The input schema has no organization field: a browser cannot name B.
    state.rpcs.length = 0;
    await setPortalChangeSettings({
      data: { policy: "instant", orgId: ORG_B, _org: ORG_B },
    } as any);
    expect(state.rpcs[0].args._org).toBe(ORG_A);
  });

  it("refuses a policy that is neither, and a fee over the bound", async () => {
    state.role = "owner";
    const { setPortalChangeSettings } = await import("@/lib/portal-change.functions");
    // The fake wrapper validates synchronously, so each call is made inside a
    // promise to be awaited the way the real server function is.
    await expect(
      (async () => setPortalChangeSettings({ data: { policy: "sometimes" } } as any))(),
    ).rejects.toThrow();
    await expect(
      (async () =>
        setPortalChangeSettings({
          data: {
            rules: [
              {
                service_line: "pet_waste",
                cutoff_hours: null,
                late_window_hours: 24,
                late_reschedule_fee_cents: 100_001,
                late_cancel_fee_cents: 0,
              },
            ],
          },
        } as any))(),
    ).rejects.toThrow();
    expect(state.rpcs).toEqual([]);
  });
});

describe("only an owner answers the queue", () => {
  for (const role of ["office_manager", "dispatcher", "tech"]) {
    it(`refuses ${role} on approve and deny, before any RPC`, async () => {
      state.role = role;
      const { decidePortalChangeRequest } = await import("@/lib/portal-change.functions");
      const { ONLY_AN_OWNER_DECIDES_PORTAL_CHANGES } = await import("@/lib/portal-change");
      for (const approve of [true, false]) {
        await expect(
          decidePortalChangeRequest({ data: { requestId: REQ, approve } } as any),
        ).rejects.toThrow(ONLY_AN_OWNER_DECIDES_PORTAL_CHANGES);
      }
      expect(state.rpcs).toEqual([]);
    });
  }

  it("an owner's approval of a late change attempts the fee; a denial never does", async () => {
    state.role = "owner";
    const { decidePortalChangeRequest } = await import("@/lib/portal-change.functions");
    state.rpcResult.decide_portal_change_request = { status: "approved", fee_cents: 1500 };
    const out = await decidePortalChangeRequest({ data: { requestId: REQ, approve: true } } as any);
    expect(out).toMatchObject({
      status: "approved",
      feeCents: 1500,
      fee: { outcome: "not_charged" },
    });
    expect(state.feeCalls).toEqual([REQ]);

    state.rpcResult.decide_portal_change_request = { status: "denied", fee_cents: 0 };
    await decidePortalChangeRequest({ data: { requestId: REQ, approve: false } } as any);
    expect(state.feeCalls).toEqual([REQ]);
    expect(state.rpcs.filter((r) => r.fn === "decide_portal_change_request")).toHaveLength(2);
  });
});

// ── The customer's side, both policies ────────────────────────────────────
describe("the portal: INSTANT applies, APPROVAL waits", () => {
  it("INSTANT: a reschedule is applied, and its late fee is attempted", async () => {
    const { portalRescheduleVisit } = await import("@/lib/portal.functions");
    state.rpcResult.portal_request_visit_change = {
      request_id: REQ,
      status: "applied",
      fee_cents: 500,
    };
    const out = await portalRescheduleVisit({
      data: {
        token: TOKEN,
        visitId: VISIT,
        newDate: "2026-12-01",
        acceptedFeeCents: 500,
        idempotencyKey: KEY,
      },
    } as any);
    expect(out).toMatchObject({ status: "applied", requestId: REQ, feeCents: 500 });
    const call = state.rpcs.find((r) => r.fn === "portal_request_visit_change")!;
    expect(call.args).toMatchObject({
      _token: TOKEN,
      _visit_id: VISIT,
      _kind: "reschedule",
      _new_date: "2026-12-01",
      _accepted_fee_cents: 500,
      _idempotency_key: KEY,
    });
    expect(state.feeCalls).toEqual([REQ]);
  });

  it("INSTANT with no fee charges nothing", async () => {
    const { portalRequestSkip } = await import("@/lib/portal.functions");
    state.rpcResult.portal_request_visit_change = {
      request_id: REQ,
      status: "applied",
      fee_cents: 0,
    };
    const out = await portalRequestSkip({
      data: { token: TOKEN, visitId: VISIT, reason: "away", idempotencyKey: KEY },
    } as any);
    expect(out.status).toBe("applied");
    expect(state.rpcs.find((r) => r.fn === "portal_request_visit_change")!.args).toMatchObject({
      _kind: "cancel",
      _new_date: null,
      _accepted_fee_cents: null,
    });
    expect(state.feeCalls).toEqual([]);
  });

  it("APPROVAL: a skip is filed, nothing is charged, and the portal is told it is pending", async () => {
    const { portalRequestSkip } = await import("@/lib/portal.functions");
    state.rpcResult.portal_request_visit_change = {
      request_id: REQ,
      status: "pending",
      fee_cents: 1500,
    };
    const out = await portalRequestSkip({
      data: {
        token: TOKEN,
        visitId: VISIT,
        reason: "",
        acceptedFeeCents: 1500,
        idempotencyKey: KEY,
      },
    } as any);
    expect(out).toMatchObject({ status: "pending", feeCents: 1500 });
    expect(state.feeCalls).toEqual([]);
  });

  it("neither handler calls the old instant-only RPCs any more", () => {
    const s = read("src/lib/portal.functions.ts");
    expect(s).not.toMatch(/rpc\("portal_reschedule_visit"/);
    expect(s).not.toMatch(/rpc\("portal_request_skip"/);
  });

  it("a fee mismatch is said in words, not as the database's code", async () => {
    const { portalChangeError } = await import("@/lib/portal.functions");
    expect(
      portalChangeError("FEE_NOT_ACCEPTED: This change now carries a fee of 1500 cents"),
    ).toMatch(/^The fee for this change has changed since the page loaded/);
    expect(portalChangeError("This visit is past the change cutoff. Contact the office")).toBe(
      "This visit is past the change cutoff. Contact the office",
    );
  });

  it("the client can never set the amount: the portal sends only what it showed, the RPC compares", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(
      /IF _fee > 0 AND _accepted_fee_cents IS DISTINCT FROM _fee THEN\s+RAISE EXCEPTION 'FEE_NOT_ACCEPTED/,
    );
    // The fee stored is the server's _fee; the accepted figure is kept only as
    // what was disclosed.
    expect(sql).toMatch(/\(_t\.late_from IS NOT NULL AND now\(\) > _t\.late_from\), _fee,/);
  });
});

// ── The review of 0e5b085 (#735), one regression test per finding ─────────
describe("review finding 1: one press, one request, one fee", () => {
  it("a portal change without a request key is refused before anything is called", async () => {
    const { portalRequestSkip, portalRescheduleVisit } = await import("@/lib/portal.functions");
    await expect(
      (async () =>
        portalRequestSkip({ data: { token: TOKEN, visitId: VISIT, reason: "" } } as any))(),
    ).rejects.toThrow();
    await expect(
      (async () =>
        portalRescheduleVisit({
          data: { token: TOKEN, visitId: VISIT, newDate: "2026-12-01", idempotencyKey: "nope" },
        } as any))(),
    ).rejects.toThrow();
    expect(state.rpcs).toEqual([]);
  });

  it("a retried press sends the same key, and a replayed applied change does not charge twice", async () => {
    const { portalRescheduleVisit } = await import("@/lib/portal.functions");
    const data = {
      token: TOKEN,
      visitId: VISIT,
      newDate: "2026-12-01",
      acceptedFeeCents: 500,
      idempotencyKey: KEY,
    };
    state.rpcResult.portal_request_visit_change = {
      request_id: REQ,
      status: "applied",
      fee_cents: 500,
    };
    await portalRescheduleVisit({ data } as any);
    state.rpcResult.portal_request_visit_change = {
      request_id: REQ,
      status: "applied",
      fee_cents: 500,
      replayed: true,
    };
    await portalRescheduleVisit({ data } as any);
    const keys = state.rpcs
      .filter((r) => r.fn === "portal_request_visit_change")
      .map((r) => r.args._idempotency_key);
    expect(keys).toEqual([KEY, KEY]);
    // Both reach the fee module with the SAME request: begin_portal_change_fee
    // is unique per request, so the second finds it already attempted.
    expect(state.feeCalls).toEqual([REQ, REQ]);
  });

  it("the database serialises presses on the visit, replays a key, and refuses the same change again", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const fn = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.portal_request_visit_change("),
    );
    const lock = fn.indexOf("FOR UPDATE;");
    const replay = fn.indexOf("idempotency_key = _idempotency_key");
    const insert = fn.indexOf("INSERT INTO public.portal_change_requests");
    expect(lock).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(replay);
    expect(fn).toMatch(
      /IF _new_date = _on THEN RAISE EXCEPTION 'This visit is already on that date'/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS portal_change_requests_one_per_key\s+ON public\.portal_change_requests \(client_id, idempotency_key\)/,
    );
  });

  it("the portal makes a new key per press and keeps it for a retry", () => {
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).toMatch(/const \[requestKey, setRequestKey\] = useState\(newRequestKey\);/);
    expect(ui).toMatch(/onReschedule\(newDate, feeNow > 0 \? feeNow : null, requestKey\);/);
    expect(ui).toMatch(/onSkip\(reason, feeNow > 0 \? feeNow : null, requestKey\);/);
    expect(ui.match(/setRequestKey\(newRequestKey\(\)\);/g)?.length).toBe(2);
  });

  it("makes UUIDs, with or without crypto.randomUUID", async () => {
    const { newRequestKey } = await import("@/lib/portal-change");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newRequestKey()).toMatch(uuid);
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (b: Uint8Array) => real.getRandomValues(b) });
    try {
      const a = newRequestKey();
      expect(a).toMatch(uuid);
      expect(newRequestKey()).not.toBe(a);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("review finding 3: an approval about a visit the office has moved", () => {
  it("is refused by the database for a reschedule and a skip alike", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const apply = sql.slice(
      sql.indexOf("CREATE OR REPLACE FUNCTION public.portal_change_apply"),
      sql.indexOf("-- ── 7. The customer asks"),
    );
    const stale = apply.indexOf("IF _on IS DISTINCT FROM _r.original_date THEN");
    // Before the branch on kind, so it covers both.
    expect(stale).toBeGreaterThan(-1);
    expect(stale).toBeLessThan(apply.indexOf("IF _r.kind = 'reschedule' THEN"));
  });

  it("and the owner is told in words", async () => {
    state.role = "owner";
    const { decidePortalChangeRequest } = await import("@/lib/portal-change.functions");
    const original = db.rpc;
    db.rpc = async (fn: string, args: any) => {
      state.rpcs.push({ fn, args });
      return {
        data: null,
        error: {
          message:
            "STALE_REQUEST: This visit was moved to 2026-12-03 after the client asked about 2026-12-01.",
        },
      } as any;
    };
    try {
      await expect(
        decidePortalChangeRequest({ data: { requestId: REQ, approve: true } } as any),
      ).rejects.toThrow(/^This visit was moved to 2026-12-03/);
      expect(state.feeCalls).toEqual([]);
    } finally {
      db.rpc = original;
    }
  });
});

describe("review finding 4: the fee accepted is the fee shown, for this action", () => {
  it("acceptance is keyed by action and amount, not one boolean", () => {
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).not.toMatch(/setFeeAccepted/);
    expect(ui).toMatch(/const feeKey = openKind \? `\$\{openKind\}:\$\{feeNow\}` : null;/);
    expect(ui).toMatch(/const feeAccepted = feeKey !== null && acceptedFee === feeKey;/);
    expect(ui).toMatch(
      /onChange=\{\(e\) => setAcceptedFee\(e\.target\.checked \? feeKey : null\)\}/,
    );
  });

  it("and the server refuses any accepted amount that is not its own", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/IF _fee > 0 AND _accepted_fee_cents IS DISTINCT FROM _fee THEN/);
  });
});

describe("review finding 5: the client sees the owner's answer", () => {
  it("lists the client's requests with status and note, from the new table", async () => {
    const { portalListMyChangeRequests } = await import("@/lib/portal.functions");
    state.rpcResult.portal_list_change_requests = [
      {
        request_id: REQ,
        kind: "cancel",
        status: "denied",
        decision_note: "Need this one",
        fee_cents: 0,
      },
    ];
    const rows = await portalListMyChangeRequests({ data: { token: TOKEN } } as any);
    expect(rows[0]).toMatchObject({ status: "denied", decision_note: "Need this one" });
    expect(state.rpcs.at(-1)).toEqual({
      fn: "portal_list_change_requests",
      args: { _token: TOKEN },
    });
  });

  it("shows it on the Requests tab and on the visit it was about", () => {
    expect(read("src/routes/portal.$slug.$token.requests.tsx")).toMatch(
      /<PortalChangeRequestsList token=\{token\} \/>/,
    );
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).toMatch(/PORTAL_CHANGE_COPY\.deniedReschedule/);
    expect(ui).toMatch(/PORTAL_CHANGE_COPY\.ownerNote\(denied\.note\)/);
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/CASE WHEN last\.status = 'denied' THEN last\.decision_note END/);
  });
});

// ── Pure helpers the portal and the settings form use ─────────────────────
describe("what the customer is told, and when", () => {
  it("merges each visit's terms and prefers the line's own cutoff", async () => {
    const { withChangeTerms } = await import("@/lib/portal-change");
    const rows = [
      { visit_id: "a", changes_allowed_until: "2026-12-01T06:00:00Z" },
      { visit_id: "b", changes_allowed_until: "2026-12-02T06:00:00Z" },
    ];
    const out = withChangeTerms(rows, [
      {
        visit_id: "a",
        policy: "approval",
        cutoff_at: "2026-11-30T00:00:00Z",
        late_from: null,
        reschedule_fee_cents: 0,
        cancel_fee_cents: 0,
        pending_request_id: null,
        pending_kind: null,
        pending_requested_date: null,
      },
    ]);
    expect(out[0].changes_allowed_until).toBe("2026-11-30T00:00:00Z");
    expect(out[0].change_terms?.policy).toBe("approval");
    expect(out[1]).toBe(rows[1]);
  });

  it("a fee applies only once the late window has opened, never below zero", async () => {
    const { feeIfChangedNow } = await import("@/lib/portal-change");
    const t = {
      late_from: "2026-11-10T00:00:00Z",
      reschedule_fee_cents: 500,
      cancel_fee_cents: 1500,
    };
    const before = Date.parse("2026-11-09T23:59:00Z");
    const after = Date.parse("2026-11-10T00:01:00Z");
    expect(feeIfChangedNow(t, "cancel", before)).toBe(0);
    expect(feeIfChangedNow(t, "cancel", after)).toBe(1500);
    expect(feeIfChangedNow(t, "reschedule", after)).toBe(500);
    expect(feeIfChangedNow({ ...t, late_from: null }, "cancel", after)).toBe(0);
    expect(feeIfChangedNow({ ...t, cancel_fee_cents: -5 }, "cancel", after)).toBe(0);
    expect(feeIfChangedNow(undefined, "cancel", after)).toBe(0);
  });

  it("reads dollars typed in the form strictly", async () => {
    const { dollarsToCents } = await import("@/lib/portal-change");
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents("15")).toBe(1500);
    expect(dollarsToCents("15.5")).toBe(1550);
    expect(dollarsToCents("0.07")).toBe(7);
    for (const bad of ["-1", "1.234", "abc", "1e3", "$5"]) expect(dollarsToCents(bad)).toBeNull();
  });

  it("new businesses default to APPROVAL, and every customer sentence is marked for the owner", () => {
    const s = read("src/lib/portal-change.ts");
    expect(s).toMatch(/DEFAULT_PORTAL_CHANGE_POLICY: PortalChangePolicy = "approval"/);
    expect(s).toMatch(/OWNER REVIEW: every sentence below is a PLACEHOLDER/);
  });

  it("the portal shows the fee and asks for it to be accepted before the confirm button works", () => {
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).toMatch(/const blockedOnFee = feeNow > 0 && !feeAccepted;/);
    expect(ui.match(/disabled=\{blockedOnFee\}/g)?.length).toBe(2);
    expect(ui).toMatch(/onReschedule\(newDate, feeNow > 0 \? feeNow : null, requestKey\)/);
    expect(ui).toMatch(/onSkip\(reason, feeNow > 0 \? feeNow : null, requestKey\)/);
    expect(ui).toMatch(/PORTAL_CHANGE_COPY\.needsApproval/);
  });

  it("the office sees the queue on the Requests page, and the owner the setting", () => {
    expect(read("src/routes/_authenticated/concerns.tsx")).toMatch(/<PortalChangeRequestQueue \/>/);
    expect(read("src/routes/_authenticated/settings.client-portal.tsx")).toMatch(
      /<PortalChangePolicyCard \/>/,
    );
  });
});

// ── Fees ──────────────────────────────────────────────────────────────────
describe("late-change fees: off by default, Stripe test mode only", () => {
  it("the server charges only when told to, and only with a test key", async () => {
    const { feeChargingMode } = await vi.importActual<any>("@/lib/portal-change-fees.server");
    expect(feeChargingMode({}).enabled).toBe(false);
    expect(feeChargingMode({ STRIPE_CONNECT_SECRET_KEY: "sk_test_x" }).enabled).toBe(false);
    expect(
      feeChargingMode({
        PORTAL_CHANGE_FEES_CHARGING: "live",
        STRIPE_CONNECT_SECRET_KEY: "sk_live_x",
      }).enabled,
    ).toBe(false);
    expect(
      feeChargingMode({
        PORTAL_CHANGE_FEES_CHARGING: "test",
        STRIPE_CONNECT_SECRET_KEY: "sk_live_x",
      }).enabled,
    ).toBe(false);
    expect(
      feeChargingMode({
        PORTAL_CHANGE_FEES_CHARGING: "test",
        STRIPE_CONNECT_SECRET_KEY: "rk_live_x",
      }).enabled,
    ).toBe(false);
    expect(
      feeChargingMode({
        PORTAL_CHANGE_FEES_CHARGING: "test",
        STRIPE_CONNECT_SECRET_KEY: "sk_test_x",
      }).enabled,
    ).toBe(true);
    expect(read("src/lib/portal-change-fees.server.ts")).not.toMatch(/sk_live|"live"/);
  });

  function feeDb(opts: { autocharge: boolean; card?: boolean; status?: string }) {
    const notes: any[] = [];
    const charge = {
      id: "fc-1",
      organization_id: ORG_A,
      client_id: "c-1",
      request_id: REQ,
      amount_cents: 1500,
      currency: "usd",
      status: opts.status ?? "pending",
      idempotency_key: `portal-change-fee:${REQ}`,
    };
    const d = {
      notes,
      rpc: async (fn: string, args: any) => {
        if (fn === "begin_portal_change_fee")
          return { data: { charge, created: true }, error: null };
        if (fn === "note_portal_change_fee_attempt") notes.push(args);
        return { data: null, error: null };
      },
      from: (t: string) => {
        const api: any = {
          select: () => api,
          eq: () => api,
          maybeSingle: async () =>
            t === "organizations"
              ? { data: { portal_change_fees_autocharge: opts.autocharge }, error: null }
              : {
                  data:
                    opts.card === false
                      ? { id: "c-1", stripe_customer_id: null, default_payment_method_id: null }
                      : {
                          id: "c-1",
                          stripe_customer_id: "cus_1",
                          default_payment_method_id: "pm_1",
                        },
                  error: null,
                },
        };
        return api;
      },
    };
    return d;
  }
  const TEST_ENV = { PORTAL_CHANGE_FEES_CHARGING: "test", STRIPE_CONNECT_SECRET_KEY: "sk_test_x" };

  it("with the owner's switch off (the default) nothing is sent to Stripe and the fee is recorded as not charged", async () => {
    const { chargePortalChangeFee } = await vi.importActual<any>("@/lib/portal-change-fees.server");
    const d = feeDb({ autocharge: false });
    const create = vi.fn();
    const out = await chargePortalChangeFee(REQ, {
      db: d,
      env: TEST_ENV,
      stripe: async () => ({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_a" }),
    });
    expect(out.outcome).toBe("not_charged");
    expect(create).not.toHaveBeenCalled();
    expect(d.notes[0]).toMatchObject({ _charge_id: "fc-1", _status: "not_charged" });
  });

  it("with the switch on but the server not in test mode, nothing is sent either", async () => {
    const { chargePortalChangeFee } = await vi.importActual<any>("@/lib/portal-change-fees.server");
    const create = vi.fn();
    const out = await chargePortalChangeFee(REQ, {
      db: feeDb({ autocharge: true }),
      env: { STRIPE_CONNECT_SECRET_KEY: "sk_live_x", PORTAL_CHANGE_FEES_CHARGING: "test" },
      stripe: async () => ({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_a" }),
    });
    expect(out.outcome).toBe("not_charged");
    expect(create).not.toHaveBeenCalled();
  });

  it("no saved card: not charged, said so", async () => {
    const { chargePortalChangeFee } = await vi.importActual<any>("@/lib/portal-change-fees.server");
    const create = vi.fn();
    const out = await chargePortalChangeFee(REQ, {
      db: feeDb({ autocharge: true, card: false }),
      env: TEST_ENV,
      stripe: async () => ({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_a" }),
    });
    expect(out).toMatchObject({ outcome: "not_charged", reason: "The client has no saved card." });
    expect(create).not.toHaveBeenCalled();
  });

  it("charges the database's amount on the connected account with the fee's own idempotency key and no payment_method_types", async () => {
    const { chargePortalChangeFee, PORTAL_CHANGE_FEE_SOURCE } = await vi.importActual<any>(
      "@/lib/portal-change-fees.server",
    );
    const d = feeDb({ autocharge: true });
    const create = vi.fn(async () => ({ id: "pi_1", status: "processing", livemode: false }));
    const out = await chargePortalChangeFee(REQ, {
      db: d,
      env: TEST_ENV,
      stripe: async () => ({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_a" }),
    });
    expect(out).toMatchObject({ outcome: "submitted", paymentIntentId: "pi_1" });
    const [params, opts] = create.mock.calls[0] as any;
    expect(params.amount).toBe(1500);
    expect(params).not.toHaveProperty("payment_method_types");
    expect(params).toMatchObject({
      customer: "cus_1",
      payment_method: "pm_1",
      off_session: true,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { source: PORTAL_CHANGE_FEE_SOURCE, fee_charge_id: "fc-1", request_id: REQ },
    });
    expect(opts).toEqual({ idempotencyKey: `portal-change-fee:${REQ}`, stripeAccount: "acct_a" });
    // Never 'succeeded' from here: only the webhook says money moved.
    expect(d.notes[0]).toMatchObject({
      _status: "processing",
      _payment_intent_id: "pi_1",
      _account: "acct_a",
    });
  });

  it("review finding 2: the account is recorded before Stripe is asked, and a failed record asks nothing", async () => {
    const { chargePortalChangeFee } = await vi.importActual<any>("@/lib/portal-change-fees.server");
    const order: string[] = [];
    const d = feeDb({ autocharge: true });
    const rpc = d.rpc;
    d.rpc = async (fn: string, args: any) => {
      order.push(fn);
      return rpc(fn, args);
    };
    const create = vi.fn(async () => {
      order.push("stripe.paymentIntents.create");
      return { id: "pi_1", status: "processing", livemode: false };
    });
    await chargePortalChangeFee(REQ, {
      db: d,
      env: TEST_ENV,
      stripe: async () => ({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_a" }),
    });
    expect(order).toEqual([
      "begin_portal_change_fee",
      "prepare_portal_change_fee",
      "stripe.paymentIntents.create",
      "note_portal_change_fee_attempt",
    ]);

    const failing = feeDb({ autocharge: true });
    const rpc2 = failing.rpc;
    failing.rpc = async (fn: string, args: any) =>
      fn === "prepare_portal_change_fee"
        ? {
            data: null,
            error: { message: "This fee is not waiting to be charged on that account" },
          }
        : rpc2(fn, args);
    const create2 = vi.fn();
    const out = await chargePortalChangeFee(REQ, {
      db: failing,
      env: TEST_ENV,
      stripe: async () => ({
        stripe: { paymentIntents: { create: create2 } },
        stripeAccount: "acct_a",
      }),
    });
    expect(out.outcome).toBe("failed");
    expect(create2).not.toHaveBeenCalled();
  });

  it("review finding 2: a webhook before the server's response is matched by the fee id it carries, and an unmatched one is not acknowledged", async () => {
    const { recordPortalChangeFeeEvent } = await vi.importActual<any>(
      "@/lib/portal-change-fees.server",
    );
    const calls: any[] = [];
    const d = {
      from: () => ({}),
      rpc: async (fn: string, args: any) => (calls.push(args), { data: "unknown", error: null }),
    };
    const ev = (metadata: Record<string, string>) => ({
      id: "evt_early",
      type: "payment_intent.succeeded",
      account: "acct_a",
      livemode: false,
      data: { object: { id: "pi_early", metadata } },
    });
    expect(
      await recordPortalChangeFeeEvent(
        d,
        ev({ fee_charge_id: "0f000000-0000-4000-8000-000000000001" }),
      ),
    ).toBe("unknown");
    expect(calls[0]._charge_id).toBe("0f000000-0000-4000-8000-000000000001");
    await recordPortalChangeFeeEvent(d, ev({ fee_charge_id: "not-a-uuid'; drop" }));
    expect(calls[1]._charge_id).toBeNull();

    const hook = read("src/routes/api/public/hooks/stripe.ts");
    const branch = hook.slice(
      hook.indexOf('"portal_change_fee"'),
      hook.indexOf('if (event.type === "setup_intent.succeeded")'),
    );
    expect(branch).toMatch(/if \(settled === "unknown"\) \{[\s\S]*?status: 409/);

    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/WHERE id = _charge_id\s+AND stripe_account_id = _account/);
  });

  it("a decline is recorded as failed with the intent's id, so the webhook can find it", async () => {
    const { chargePortalChangeFee } = await vi.importActual<any>("@/lib/portal-change-fees.server");
    const d = feeDb({ autocharge: true });
    const create = vi.fn(async () => {
      throw Object.assign(new Error("Your card was declined."), {
        raw: { payment_intent: { id: "pi_2" } },
      });
    });
    const out = await chargePortalChangeFee(REQ, {
      db: d,
      env: TEST_ENV,
      stripe: async () => ({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_a" }),
    });
    expect(out).toMatchObject({ outcome: "failed", reason: "Your card was declined." });
    expect(d.notes[0]).toMatchObject({ _status: "failed", _payment_intent_id: "pi_2" });
  });

  it("a fee already attempted is not attempted again", async () => {
    const { chargePortalChangeFee } = await vi.importActual<any>("@/lib/portal-change-fees.server");
    const create = vi.fn();
    const out = await chargePortalChangeFee(REQ, {
      db: feeDb({ autocharge: true, status: "processing" }),
      env: TEST_ENV,
      stripe: async () => ({ stripe: { paymentIntents: { create } }, stripeAccount: "acct_a" }),
    });
    expect(out).toEqual({ outcome: "already_attempted", status: "processing" });
    expect(create).not.toHaveBeenCalled();
  });

  it("the webhook hands the database the event id, the intent and the CONNECTED ACCOUNT, never metadata", async () => {
    const { recordPortalChangeFeeEvent } = await vi.importActual<any>(
      "@/lib/portal-change-fees.server",
    );
    const calls: any[] = [];
    const d = {
      from: () => ({}),
      rpc: async (fn: string, args: any) => (
        calls.push({ fn, args }),
        { data: "succeeded", error: null }
      ),
    };
    const out = await recordPortalChangeFeeEvent(d, {
      id: "evt_1",
      type: "payment_intent.succeeded",
      account: "acct_a",
      livemode: false,
      data: { object: { id: "pi_1", metadata: { organization_id: ORG_B } } },
    });
    expect(out).toBe("succeeded");
    expect(calls[0]).toEqual({
      fn: "record_portal_change_fee_event",
      args: {
        _event_id: "evt_1",
        _event_type: "payment_intent.succeeded",
        _payment_intent_id: "pi_1",
        _account: "acct_a",
        _succeeded: true,
        _message: null,
        _livemode: false,
        _charge_id: null,
      },
    });
    expect(
      await recordPortalChangeFeeEvent(d, {
        id: "evt_2",
        type: "charge.refunded",
        account: "acct_a",
        livemode: false,
        data: { object: { id: "ch_1" } },
      }),
    ).toBe("ignored");
  });

  it("the Connect webhook routes a fee's events to it before any invoice handling", () => {
    const hook = read("src/routes/api/public/hooks/stripe.ts");
    const branch = hook.indexOf('"portal_change_fee"');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(hook.indexOf('if (event.type === "setup_intent.succeeded")'));
    expect(hook.slice(branch, branch + 400)).toMatch(/recordPortalChangeFeeEvent\(supabaseAdmin/);
    // Signature verification still comes first.
    expect(hook.indexOf("constructEventAsync")).toBeLessThan(branch);
  });
});

// ── The migration ─────────────────────────────────────────────────────────
describe("D6 in the database", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("existing businesses keep INSTANT, new ones start on APPROVAL, auto-charge off", () => {
    const add = sql.indexOf(
      "ADD COLUMN IF NOT EXISTS portal_change_policy text NOT NULL DEFAULT 'instant'",
    );
    const flip = sql.indexOf("ALTER COLUMN portal_change_policy SET DEFAULT 'approval'");
    expect(add).toBeGreaterThan(-1);
    expect(flip).toBeGreaterThan(add);
    expect(sql).toMatch(/portal_change_fees_autocharge boolean NOT NULL DEFAULT false/);
    // No visit or request is rewritten: nothing retroactive.
    expect(sql).not.toMatch(/UPDATE public\.organizations SET portal_change_policy/i);
  });

  it("every new RLS table gets two-step sign-in, and no client role can write one", () => {
    for (const t of [
      "portal_change_rules",
      "portal_change_requests",
      "portal_change_fee_charges",
      "portal_change_fee_events",
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`SELECT public.require_mfa_policy('public.${t}');`);
    }
    expect(sql).not.toMatch(/CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(sql).toMatch(/permissive = 'PERMISSIVE'/);
  });

  it("owner-only, by any path, and every change logged", () => {
    expect(sql).toMatch(
      /BEFORE UPDATE OF portal_change_policy, portal_change_fees_autocharge ON public\.organizations/,
    );
    expect(sql).toMatch(
      /AFTER UPDATE OF portal_change_policy, portal_change_fees_autocharge ON public\.organizations/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_orgs_portal_change_owner_only\(\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_orgs_log_portal_change_settings\(\) FROM PUBLIC, anon, authenticated;/,
    );
    for (const kind of [
      "portal_change.requested",
      "portal_change.applied",
      "portal_change.withdrawn",
      "org.portal_change_policy_changed",
      "org.portal_change_autocharge_changed",
      "org.portal_change_rules_changed",
    ]) {
      expect(sql, kind).toContain(`'${kind}'`);
    }
    // approved / denied and charged / failed / not_charged are built from the outcome.
    expect(sql).toContain("'portal_change.' || _status");
    expect(sql).toContain(
      "'portal_change_fee.' || CASE WHEN _succeeded THEN 'charged' ELSE 'failed' END",
    );
  });

  it("a duplicate webhook delivery changes nothing, and another tenant's event finds nothing", () => {
    expect(sql).toMatch(
      /ON CONFLICT \(event_id\) DO NOTHING;\s+GET DIAGNOSTICS _n = ROW_COUNT;\s+IF _n = 0 THEN RETURN 'duplicate'; END IF;/,
    );
    expect(sql).toMatch(
      /WHERE stripe_payment_intent_id = _payment_intent_id\s+AND stripe_account_id = _account/,
    );
    expect(sql).toMatch(
      /request_id uuid NOT NULL UNIQUE REFERENCES public\.portal_change_requests/,
    );
    expect(sql).toMatch(/idempotency_key text NOT NULL UNIQUE/);
  });

  it("leaves the two old portal RPCs as they were", () => {
    expect(sql).not.toMatch(/FUNCTION public\.portal_reschedule_visit/);
    expect(sql).not.toMatch(/FUNCTION public\.portal_request_skip/);
  });
});

// ── The proof, in a real database ─────────────────────────────────────────
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
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
    `\n  SKIPPED: the a-portal-change-waits-for-the-owner proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a portal change waits for the owner, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("both policies, owner-only settings and decisions, cross-tenant refusals, fees once", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out).toMatch(/ALL PORTAL-CHANGE-WAITS-FOR-THE-OWNER PROOFS PASSED/);
  });
});
