// Start on the lock screen starts the stop.
//
// The owner, after the 2026-10-08 TestFlight build: the Start button on the
// route's Live Activity should START the visit, not open the app to a
// focused button. iOS runs the button's App Intent in the app's process,
// with no web view and no session, so it presses with an ACTION TOKEN the
// signed-in app minted: one tech, one business, one day, Start only, at most
// sixteen hours, revoked when the route leaves the lock screen
// (src/lib/live-activity-action.ts, live-activity-action.server.ts,
// supabase/migrations/20261008150000_the-lock-screen-starts-the-stop.sql,
// ios/App/App/LiveActivity/RouteActivityIntents.swift).
//
// What this file pins, without a phone or a database:
//
//   1. the token: its shape, that only its hash is kept, how long it lives;
//   2. every refusal: unknown, revoked, expired, another business's stop,
//      another tech's, another day's, a stop that is not startable, too many
//      presses, a tech no longer on staff; and that a refusal writes nothing;
//   3. idempotency: a replayed press and a double tap start the stop once;
//   4. that the transition is start_visit's own body (start_visit_as), as
//      the token's tech, and the migration keeps that body the service
//      role's alone;
//   5. the iPhone side holds the token and nothing else, and falls back to
//      opening the app rather than failing quietly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_TOKEN_MAX_MS,
  ACTION_TOKEN_RE,
  actionTokenExpiry,
  checkActionScope,
  checkActionState,
  checkActionToken,
  orgWallClockInstant,
  rateLimited,
  type ActionTokenRow,
} from "@/lib/live-activity-action";
import {
  hashActionToken,
  newActionToken,
  performLiveActivityAction,
  resetActionRateForTests,
  type ActionDeps,
} from "@/lib/live-activity-action.server";
import { FakeDb } from "./support/fake-supabase";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const STAFF = "44444444-4444-4444-8444-444444444444";
const OTHER_STAFF = "55555555-5555-4555-8555-555555555555";
const VISIT = "66666666-6666-4666-8666-666666666666";
const DAY = "2026-10-08";
const NOW = new Date("2026-10-08T15:00:00Z");

// ── 1. the token ──────────────────────────────────────────────────────────

describe("the action token", () => {
  it("is 32 random bytes as 43 base64url characters, and two are never the same", () => {
    const a = newActionToken();
    const b = newActionToken();
    expect(a).toMatch(ACTION_TOKEN_RE);
    expect(a).not.toBe(b);
  });

  it("is kept only as its SHA-256", () => {
    const t = newActionToken();
    expect(hashActionToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashActionToken(t)).not.toContain(t);
    const sql = read("supabase/migrations/20261008150000_the-lock-screen-starts-the-stop.sql");
    expect(sql).toMatch(/token_hash text NOT NULL/);
    expect(sql).toMatch(/CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(codeOnly(sql)).not.toMatch(/\btoken text\b/);
  });

  it("expires at the end of the workday plus two hours, in the org's own zone", () => {
    // 17:00 in Chicago on 2026-10-08 is 22:00Z (CDT); plus two hours' grace.
    expect(orgWallClockInstant(DAY, "17:00:00", "America/Chicago").toISOString()).toBe(
      "2026-10-08T22:00:00.000Z",
    );
    const at = actionTokenExpiry({
      now: NOW,
      routeDate: DAY,
      tz: "America/Chicago",
      workdayEnd: "17:00:00",
    });
    expect(at.toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("never lives past sixteen hours, however late the workday says it ends", () => {
    const early = new Date("2026-10-08T04:00:00Z");
    const at = actionTokenExpiry({
      now: early,
      routeDate: DAY,
      tz: "America/Chicago",
      workdayEnd: "23:59:00",
    });
    expect(at.getTime() - early.getTime()).toBe(ACTION_TOKEN_MAX_MS);
  });

  it("minted after hours, still lives an hour, so a late stop is not refused at once", () => {
    const late = new Date("2026-10-09T03:00:00Z");
    const at = actionTokenExpiry({
      now: late,
      routeDate: DAY,
      tz: "America/Chicago",
      workdayEnd: "17:00:00",
    });
    expect(at.getTime() - late.getTime()).toBe(60 * 60 * 1000);
  });

  it("falls back to 17:00 for a workday end it cannot read", () => {
    const at = actionTokenExpiry({
      now: NOW,
      routeDate: DAY,
      tz: "America/Chicago",
      workdayEnd: null,
    });
    expect(at.toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("the database refuses a token that lives longer than sixteen hours", () => {
    const sql = read("supabase/migrations/20261008150000_the-lock-screen-starts-the-stop.sql");
    expect(sql).toMatch(/expires_at <= created_at \+ interval '16 hours 5 minutes'/);
  });
});

// ── 2. the rules, one at a time ───────────────────────────────────────────

const token = (over: Partial<ActionTokenRow> = {}): ActionTokenRow => ({
  id: "tok-1",
  user_id: USER,
  organization_id: ORG,
  staff_id: STAFF,
  route_date: DAY,
  locale: "en",
  expires_at: "2026-10-09T00:00:00Z",
  revoked_at: null,
  ...over,
});
const visit = (over: Record<string, unknown> = {}) => ({
  id: VISIT,
  organization_id: ORG,
  assigned_staff_id: STAFF,
  scheduled_on: DAY,
  status: "scheduled",
  ...over,
});

describe("whether a token may act", () => {
  it.each([
    ["unknown", null, "unknown_token"],
    ["revoked", token({ revoked_at: "2026-10-08T14:00:00Z" }), "revoked"],
    ["expired", token({ expires_at: "2026-10-08T14:59:59Z" }), "expired"],
    ["good", token(), null],
  ])("%s", (_why, row, want) => {
    expect(checkActionToken(row, NOW)).toBe(want);
  });

  it.each([
    ["another business's stop", visit({ organization_id: OTHER_ORG }), "not_your_stop"],
    ["another tech's stop", visit({ assigned_staff_id: OTHER_STAFF }), "not_your_stop"],
    ["an unassigned stop", visit({ assigned_staff_id: null }), "not_your_stop"],
    ["another day's stop", visit({ scheduled_on: "2026-10-09" }), "not_your_stop"],
    ["a stop that does not exist", null, "not_your_stop"],
    ["this tech's stop today", visit(), null],
  ])("%s", (_why, v, want) => {
    expect(checkActionScope(token(), v as any)).toBe(want);
  });

  it.each([
    ["scheduled", { already: false }],
    ["in_progress", { already: true }],
    ["completed", { refusal: "not_startable" }],
    ["skipped", { refusal: "not_startable" }],
    ["missed", { refusal: "not_startable" }],
    ["canceled", { refusal: "not_startable" }],
  ])("a %s stop", (status, want) => {
    expect(checkActionState(status)).toEqual(want);
  });

  it("six presses a minute is the most", () => {
    expect(rateLimited(5)).toBe(false);
    expect(rateLimited(6)).toBe(true);
  });
});

// ── 3. the hook, end to end against an in-memory database ─────────────────

function world() {
  const db = new FakeDb();
  db.unique.live_activity_actions = [["token_id", "visit_id", "action"]];
  db.unique.live_activity_action_tokens = [["token_hash"]];
  const raw = newActionToken();
  db.table("live_activity_action_tokens").push({
    ...token({ id: "tok-1" }),
    token_hash: hashActionToken(raw),
  });
  db.table("visits").push(visit());
  db.table("staff").push({ id: STAFF, user_id: USER, active: true });
  db.rpcHandler = async (fn, args) => {
    if (fn === "start_visit_as") {
      const v = db.table("visits").find((x) => x.id === args._visit_id);
      if (v && (v.status === "scheduled" || v.status === "in_progress")) v.status = "in_progress";
    }
    return { error: null };
  };
  const logged: string[] = [];
  const pushed: string[] = [];
  const deps: ActionDeps = {
    db: db as unknown as ActionDeps["db"],
    now: () => NOW,
    logStarted: async (v, u) => {
      logged.push(`${v}|${u}`);
    },
    routeState: async () => ({ stopLabel: "Stop 1 of 1", nextAction: "complete" }) as any,
    push: async (u, d) => {
      pushed.push(`${u}|${d}`);
    },
  };
  return { db, raw, deps, logged, pushed };
}

const press = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) =>
  performLiveActivityAction({ token: w.raw, visitId: VISIT, action: "start", ...over }, w.deps);

describe("a press of Start", () => {
  beforeEach(() => resetActionRateForTests());
  afterEach(() => vi.restoreAllMocks());

  it("starts the stop as the token's tech, with start_visit's own body, and says so everywhere", async () => {
    const w = world();
    const r = await press(w);
    expect(r).toMatchObject({ status: 200, body: { ok: true, outcome: "started" } });
    expect((r.body as any).state).toMatchObject({ nextAction: "complete" });
    expect(w.db.rpcCalls).toEqual([
      { fn: "start_visit_as", args: { _actor: USER, _visit_id: VISIT } },
    ]);
    expect(w.db.table("visits")[0].status).toBe("in_progress");
    // Audited: the press, and the same activity line the app's Start writes.
    expect(w.db.table("live_activity_actions")).toEqual([
      expect.objectContaining({
        token_id: "tok-1",
        visit_id: VISIT,
        user_id: USER,
        action: "start",
        outcome: "done",
      }),
    ]);
    expect(w.logged).toEqual([`${VISIT}|${USER}`]);
    // And pushed, for a phone the reply does not reach.
    expect(w.pushed).toEqual([`${USER}|${DAY}`]);
  });

  it("a replay of the same press finds the stop started and does nothing twice", async () => {
    const w = world();
    await press(w);
    const again = await press(w);
    expect(again).toMatchObject({ status: 200, body: { ok: true, outcome: "already" } });
    expect(w.db.rpcCalls).toHaveLength(1);
    expect(w.db.table("live_activity_actions")).toHaveLength(1);
    expect(w.logged).toHaveLength(1);
  });

  it("a double tap, two presses in flight at once, starts it once", async () => {
    const w = world();
    const [a, b] = await Promise.all([press(w), press(w)]);
    const outcomes = [a, b].map((r) => (r.body as any).outcome).sort();
    expect(outcomes).toEqual(["already", "started"]);
    expect(w.db.rpcCalls).toHaveLength(1);
    expect(w.db.table("live_activity_actions")).toHaveLength(1);
  });

  it.each([
    ["no token", { token: undefined }, 401],
    ["a token of the wrong shape", { token: "short" }, 401],
    ["a token nobody minted", { token: "x".repeat(43) }, 401],
    ["a visit id that is not one", { visitId: "../../settings" }, 400],
    ["an action that is not Start", { action: "complete" }, 400],
  ])("refuses %s, and writes nothing", async (_why, over, status) => {
    const w = world();
    const r = await press(w, over);
    expect(r.status).toBe(status);
    expect(r.body.ok).toBe(false);
    expect(w.db.rpcCalls).toHaveLength(0);
    expect(w.db.table("live_activity_actions")).toHaveLength(0);
  });

  it.each([
    [
      "an expired token",
      (w: ReturnType<typeof world>) =>
        (w.db.table("live_activity_action_tokens")[0].expires_at = "2026-10-08T14:00:00Z"),
      401,
    ],
    [
      "a revoked token",
      (w: ReturnType<typeof world>) =>
        (w.db.table("live_activity_action_tokens")[0].revoked_at = "2026-10-08T14:00:00Z"),
      401,
    ],
    [
      "another business's stop",
      (w: ReturnType<typeof world>) => (w.db.table("visits")[0].organization_id = OTHER_ORG),
      404,
    ],
    [
      "another tech's stop",
      (w: ReturnType<typeof world>) => (w.db.table("visits")[0].assigned_staff_id = OTHER_STAFF),
      404,
    ],
    [
      "yesterday's stop",
      (w: ReturnType<typeof world>) => (w.db.table("visits")[0].scheduled_on = "2026-10-07"),
      404,
    ],
    [
      "a finished stop",
      (w: ReturnType<typeof world>) => (w.db.table("visits")[0].status = "completed"),
      409,
    ],
  ])("refuses %s, and starts nothing", async (_why, setup, status) => {
    const w = world();
    setup(w);
    const r = await press(w);
    expect(r.status).toBe(status);
    expect(w.db.rpcCalls).toHaveLength(0);
    expect(w.db.table("live_activity_actions")).toHaveLength(0);
    expect(w.logged).toHaveLength(0);
  });

  it("a cross-tenant press is answered exactly like a stop that does not exist", async () => {
    const a = world();
    a.db.table("visits")[0].organization_id = OTHER_ORG;
    const b = world();
    b.db.table("visits").length = 0;
    expect(await press(a)).toEqual(await press(b));
  });

  it("a tech who has left the business: refused, and the token revoked", async () => {
    const w = world();
    w.db.table("staff")[0].active = false;
    const r = await press(w);
    expect(r.status).toBe(401);
    expect(w.db.table("live_activity_action_tokens")[0]).toMatchObject({
      revoke_reason: "staff_inactive",
    });
    expect(w.db.rpcCalls).toHaveLength(0);
  });

  it("too many presses in a minute are refused", async () => {
    const w = world();
    for (let i = 0; i < 6; i++) {
      w.db.table("live_activity_actions").push({
        id: `old-${i}`,
        token_id: "tok-1",
        visit_id: `v-${i}`,
        action: "start",
        created_at: new Date(NOW.getTime() - 10_000).toISOString(),
      });
    }
    const r = await press(w);
    expect(r.status).toBe(429);
    expect(w.db.rpcCalls).toHaveLength(0);
  });

  it("a loop that only ever gets 'already' is cut off too", async () => {
    const w = world();
    w.db.table("visits")[0].status = "in_progress";
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await press(w)).status);
    expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("a transition the database refuses is recorded as failed, and can be pressed again", async () => {
    const w = world();
    let refuse = true;
    const real = w.db.rpcHandler;
    w.db.rpcHandler = async (fn, args) =>
      refuse ? { error: { message: "Not authorized for this visit" } } : real(fn, args);
    const first = await press(w);
    expect(first.status).toBe(422);
    expect(w.db.table("live_activity_actions")[0]).toMatchObject({ outcome: "failed" });
    refuse = false;
    const second = await press(w);
    expect(second).toMatchObject({ status: 200, body: { outcome: "started" } });
    expect(w.db.table("live_activity_actions")).toHaveLength(1);
    expect(w.db.table("live_activity_actions")[0]).toMatchObject({ outcome: "done" });
  });
});

// ── 4. the transition is the app's own ────────────────────────────────────

describe("one start, two callers", () => {
  const sql = codeOnly(
    read("supabase/migrations/20261008150000_the-lock-screen-starts-the-stop.sql"),
  );

  it("start_visit is start_visit_as with the caller, and nothing else", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.start_visit("));
    const body = fn.slice(fn.indexOf("AS $function$"), fn.indexOf("$function$;"));
    expect(body).toMatch(
      /PERFORM public\.start_visit_as\(auth\.uid\(\), _visit_id, _started_at\);/,
    );
    expect(body).not.toMatch(/UPDATE public\.visits/);
  });

  it("start_visit_as authorizes the actor it is given the way start_visit always did", () => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.start_visit_as("));
    expect(fn).toMatch(/IF _actor IS NULL OR NOT public\.is_visit_tech\(_actor, _visit_id\) THEN/);
    expect(fn).toMatch(/started_at = COALESCE\(started_at, _when\)/);
    expect(fn).toMatch(/WHERE id = _visit_id AND status IN \('scheduled','in_progress'\)/);
  });

  it("start_visit_as is the service role's alone; start_visit keeps its callers", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.start_visit_as\(uuid, uuid, timestamptz\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.start_visit_as\(uuid, uuid, timestamptz\) TO service_role;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.start_visit\(uuid, timestamptz\) FROM PUBLIC, anon;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.start_visit\(uuid, timestamptz\) TO authenticated, service_role;/,
    );
  });

  it("both new tables are service-role only, with two-step sign-in like every RLS table", () => {
    for (const t of ["live_activity_action_tokens", "live_activity_actions"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY;`));
      expect(sql).toMatch(new RegExp(`SELECT public\\.require_mfa_policy\\('public\\.${t}'\\);`));
      expect(sql).toMatch(
        new RegExp(`REVOKE ALL ON public\\.${t} FROM PUBLIC, anon, authenticated;`),
      );
      expect(sql).not.toMatch(new RegExp(`CREATE POLICY[^;]*ON public\\.${t}`));
    }
    expect(sql).toMatch(
      /CONSTRAINT live_activity_actions_once UNIQUE \(token_id, visit_id, action\)/,
    );
  });

  it("the app's startVisit and the hook write the same activity line", () => {
    expect(read("src/lib/my-day.functions.ts")).toMatch(
      /logVisitStarted\(context\.supabase, \{ visitId: data\.visitId, actorUserId: context\.userId \}\)/,
    );
    expect(read("src/lib/live-activity-action.server.ts")).toMatch(
      /logVisitStarted\(db, \{ visitId, actorUserId, via: "lock_screen" \}\)/,
    );
  });

  it("the route hands the bearer token and the body to the one function, uncached", () => {
    const route = codeOnly(read("src/routes/api/public/hooks/live-activity-action.ts"));
    expect(route).toMatch(/createFileRoute\("\/api\/public\/hooks\/live-activity-action"\)/);
    expect(route).toMatch(/\/\^Bearer \(\[A-Za-z0-9_-\]\{1,100\}\)\$\//);
    expect(route).toMatch(/performLiveActivityAction\(/);
    expect(route).toMatch(/"Cache-Control": "no-store"/);
    expect(route).not.toMatch(/supabase\.auth|getSession|setSession/);
  });

  it("ending the route, and clocking out, revoke the tokens", () => {
    expect(read("src/lib/live-activity.functions.ts")).toMatch(
      /revokeActionTokens\(context\.userId, data\.reason\)/,
    );
    expect(read("src/lib/time-clock.functions.ts")).toMatch(
      /revokeActionTokens\(context\.userId, "clocked_out"\)/,
    );
  });

  it("a token is minted only for the caller's own active staff record, for the org's today, and supersedes the last", () => {
    const fn = read("src/lib/live-activity.functions.ts");
    const mint = fn.slice(fn.indexOf("export const mintLiveActivityActionToken"));
    expect(mint).toMatch(/\.eq\("user_id", userId\)\s*\.eq\("active", true\)/);
    expect(mint).toMatch(
      /if \(data\.routeDate !== orgToday\(tz\)\) return \{ minted: false as const \};/,
    );
    expect(mint).toMatch(/revoke_reason: "superseded"/);
    expect(mint).toMatch(/token_hash: hashActionToken\(token\)/);
  });
});

// ── 5. the iPhone side ─────────────────────────────────────────────────────

describe("the App Intent", () => {
  const intent = read("ios/App/App/LiveActivity/RouteActivityIntents.swift");
  const code = codeOnly(intent);
  const pbx = read("ios/App/App.xcodeproj/project.pbxproj");

  it("is a LiveActivityIntent, compiled into the app and the extension, and runs only in the app", () => {
    expect(code).toMatch(/struct StartStopIntent: LiveActivityIntent/);
    expect(
      pbx.match(/RouteActivityIntents\.swift in Sources \*\/ = \{isa = PBXBuildFile/g),
    ).toHaveLength(2);
    expect(pbx).toMatch(/SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG ROUTE_ACTIVITY_EXTENSION";/);
    expect(pbx).toMatch(/SWIFT_ACTIVE_COMPILATION_CONDITIONS = ROUTE_ACTIVITY_EXTENSION;/);
    const perform = code.slice(code.indexOf("func perform()"));
    expect(perform.slice(0, perform.indexOf("#else"))).toMatch(
      /#if ROUTE_ACTIVITY_EXTENSION\s*return \.result\(\)/,
    );
  });

  it("holds the token and nothing else: no session, no Supabase, no App Group", () => {
    expect(code).not.toMatch(/supabase|access_token|refresh_token|getSession|\bjwt\b/i);
    expect(code).not.toMatch(/kSecAttrAccessGroup|group\./);
    expect(read("ios/App/App/App.entitlements")).not.toMatch(/application-groups/);
    expect(code).toMatch(/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    expect(code).toMatch(
      /setValue\("Bearer \\\(held\.token\)", forHTTPHeaderField: "Authorization"\)/,
    );
  });

  it("sends the token only to https (or this Mac, on a Debug build)", () => {
    const fn = code.slice(code.indexOf("static func endpointURL"));
    expect(fn).toMatch(/if url\.scheme == "https" \{ return url \}/);
    expect(fn).toMatch(
      /#if DEBUG\s*if url\.scheme == "http", \["localhost", "127\.0\.0\.1"\]\.contains\(host\)/,
    );
  });

  it("falls back to opening the app on the stop, never to nothing", () => {
    expect(code).toMatch(/extension StartStopIntent: ForegroundContinuableIntent \{\}/);
    expect(code).toMatch(/throw needsToContinueInForegroundError \{/);
    expect(code).toMatch(
      /RouteLinks\.myDay\(routeDate: routeDate, visitId: visitId, action: "start"\)/,
    );
  });

  it("weak-links AppIntents, so the app still launches on iOS 15", () => {
    expect(pbx).toMatch(
      /AppIntents\.framework in Frameworks \*\/ = \{[^}]*ATTRIBUTES = \(Weak, \)/,
    );
  });

  it("the widget's Start is a Button(intent:) on iOS 17; Complete and Navigate stay links", () => {
    const view = read("ios/App/RouteActivity/RouteLiveActivity.swift");
    expect(view).toMatch(
      /Button\(intent: StartStopIntent\(visitId: visitId, routeDate: routeDate\)\)/,
    );
    expect(view).toMatch(/@available\(iOS 17\.0, \*\)\s*private struct StopActionButton/);
    expect(view).toMatch(/Link\(destination: url\)/);
  });

  it("the plugin keeps the token in the keychain, and forgets it when the route ends", () => {
    const plugin = read("ios/App/App/LiveActivity/RouteActivityPlugin.swift");
    expect(plugin).toMatch(/CAPPluginMethod\(name: "setActionToken"/);
    expect(plugin).toMatch(/CAPPluginMethod\(name: "clearActionToken"/);
    const end = plugin.slice(
      plugin.indexOf("@objc func end("),
      plugin.indexOf("@objc func setActionToken"),
    );
    expect(end).toMatch(/RouteActionStore\.clear\(\)/);
  });
});
