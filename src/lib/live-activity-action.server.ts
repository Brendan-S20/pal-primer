// The server half of Start on the lock screen: minting the action token, and
// trading one for a started stop.
//
// The shape of the token and every rule the trade applies are in
// src/lib/live-activity-action.ts, pure and tested. This file is the order
// they run in, against the database, and is written against a small `deps`
// object rather than the real clients so the order itself is tested too
// (tests/the-lock-screen-starts-the-stop.test.ts): idempotency, the rate
// limit, and that a refusal writes nothing.
//
// THREAT MODEL, briefly (the PR says it at more length):
//
//   * A stolen token can start stops on ONE tech's route, for ONE day, in
//     ONE business, for at most sixteen hours, and nothing else: no read, no
//     other transition, no other tech, no other day. It is revoked when the
//     activity ends, on clock-out and whenever a newer one is minted.
//   * It is stored only as a SHA-256. A database read does not yield a
//     working token, and the lookup is by digest, which a caller cannot steer
//     byte by byte, so there is no timing oracle to compare against.
//   * Replay is the double tap: one row per (token, visit, action) means a
//     replayed press finds the row and answers "already", and the transition
//     itself (start_visit_as) keeps the first start time anyway.
//   * Cross-tenant: the visit must carry the token's organization, staff and
//     day, and start_visit_as re-checks is_visit_tech for the token's user,
//     so a token from business A answers a visit in business B exactly as it
//     answers a visit id that does not exist.
//   * No Supabase session ever leaves the app: the intent holds this token
//     and nothing else, in the iPhone keychain, readable after first unlock.

import { createHash, randomBytes } from "node:crypto";
import {
  ACTION_RATE_PER_MINUTE,
  ACTION_TOKEN_RE,
  REFUSAL_STATUS,
  checkActionScope,
  checkActionState,
  checkActionToken,
  isLockScreenAction,
  rateLimited,
  type ActionRefusal,
  type ActionTokenRow,
  type ActionVisitRow,
  type LockScreenAction,
} from "@/lib/live-activity-action";
import type { RouteActivityState } from "@/lib/live-activity-state";

export function newActionToken(): string {
  const t = randomBytes(32).toString("base64url");
  if (!ACTION_TOKEN_RE.test(t)) throw new Error("token shape");
  return t;
}

export function hashActionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = { from: (table: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

export type ActionDeps = {
  db: Db;
  now?: () => Date;
  /** The visit.started activity line (visit-activity.server.ts). */
  logStarted: (visitId: string, actorUserId: string) => Promise<void>;
  /** The route as it now stands, in the phone's language, for the reply. */
  routeState: (
    userId: string,
    orgId: string,
    date: string,
    lang: string,
  ) => Promise<RouteActivityState | null>;
  /** Push the new state to the activity's APNs token, for a phone the reply
   *  does not reach (the intent was killed before it read it). */
  push: (userId: string, date: string) => Promise<unknown>;
};

export type ActionReply =
  | {
      status: 200;
      body: { ok: true; outcome: "started" | "already"; state: RouteActivityState | null };
    }
  | { status: number; body: { ok: false; error: ActionRefusal | "failed" } };

const refuse = (error: ActionRefusal): ActionReply => ({
  status: REFUSAL_STATUS[error],
  body: { ok: false, error },
});

/**
 * One press of Start on the lock screen. Never throws: every outcome is a
 * reply, and every reply that is not 200 makes the intent open the app on
 * the stop instead.
 */
export async function performLiveActivityAction(
  input: { token: unknown; visitId: unknown; action: unknown },
  deps: ActionDeps,
): Promise<ActionReply> {
  const now = deps.now?.() ?? new Date();
  const { token, visitId, action } = input;
  if (typeof token !== "string" || !ACTION_TOKEN_RE.test(token)) return refuse("unknown_token");
  if (typeof visitId !== "string" || !UUID.test(visitId) || !isLockScreenAction(action)) {
    return refuse("bad_request");
  }
  const db = deps.db;
  try {
    // 1. The token: known, not revoked, not expired.
    const { data: row, error: tokErr } = await db
      .from("live_activity_action_tokens")
      .select("id, user_id, organization_id, staff_id, route_date, locale, expires_at, revoked_at")
      .eq("token_hash", hashActionToken(token))
      .maybeSingle();
    if (tokErr) throw new Error(tokErr.message);
    const tok = row as ActionTokenRow | null;
    const bad = checkActionToken(tok, now);
    if (bad) return refuse(bad);

    // 2. Not too often. Twice over: every press this server instance has
    // seen for the token, refused or not (cheap, and covers a loop that only
    // ever gets "already"), and every press that reached a stop, from the
    // database (which every instance shares).
    if (seenTooOften(tok!.id, now.getTime())) return refuse("rate_limited");
    const since = new Date(now.getTime() - 60_000).toISOString();
    const { count, error: rateErr } = await db
      .from("live_activity_actions")
      .select("id", { count: "exact", head: true })
      .eq("token_id", tok!.id)
      .gte("created_at", since);
    if (rateErr) throw new Error(rateErr.message);
    if (rateLimited(count ?? 0)) return refuse("rate_limited");

    // 3. The stop is on this token's route, and its tech is still on staff.
    const { data: visit, error: visitErr } = await db
      .from("visits")
      .select("id, organization_id, assigned_staff_id, scheduled_on, status")
      .eq("id", visitId)
      .maybeSingle();
    if (visitErr) throw new Error(visitErr.message);
    const outOfScope = checkActionScope(tok!, visit as ActionVisitRow | null);
    if (outOfScope) return refuse(outOfScope);
    const { data: staff } = await db
      .from("staff")
      .select("id, active")
      .eq("id", tok!.staff_id)
      .eq("user_id", tok!.user_id)
      .maybeSingle();
    if (!staff || staff.active === false) {
      await db
        .from("live_activity_action_tokens")
        .update({ revoked_at: now.toISOString(), revoke_reason: "staff_inactive" })
        .eq("id", tok!.id);
      return refuse("revoked");
    }

    const reply = async (outcome: "started" | "already"): Promise<ActionReply> => ({
      status: 200,
      body: {
        ok: true,
        outcome,
        state: await deps.routeState(
          tok!.user_id,
          tok!.organization_id,
          tok!.route_date,
          tok!.locale,
        ),
      },
    });

    // 4. Where the stop is now.
    const where = checkActionState((visit as ActionVisitRow).status);
    if ("refusal" in where) return refuse(where.refusal);
    if (where.already) return reply("already");

    // 5. Once per (token, visit, action). The insert IS the lock: a second
    // tap that arrives while the first is still running loses the race here
    // and answers "already" rather than starting the stop twice.
    const claimed = await claim(db, tok!, visitId, action);
    if (claimed === "already") return reply("already");

    // 6. The transition: start_visit's own body, as this tech.
    // rpc-role: service (db is supabaseAdmin, injected at the bottom of this file)
    const { error: rpcErr } = await db.rpc("start_visit_as", {
      _actor: tok!.user_id,
      _visit_id: visitId,
    });
    if (rpcErr) {
      await db
        .from("live_activity_actions")
        .update({
          outcome: "failed",
          detail: String(rpcErr.message ?? "").slice(0, 500),
          finished_at: new Date().toISOString(),
        })
        .eq("id", claimed);
      return { status: 422, body: { ok: false, error: "failed" } };
    }
    await Promise.all([
      db
        .from("live_activity_actions")
        .update({ outcome: "done", finished_at: new Date().toISOString() })
        .eq("id", claimed),
      db
        .from("live_activity_action_tokens")
        .update({ last_used_at: now.toISOString() })
        .eq("id", tok!.id),
    ]);

    // 7. The same activity line the app's Start writes, and the lock screen
    // brought up to date by push as well as by the reply.
    await deps.logStarted(visitId, tok!.user_id);
    await deps.push(tok!.user_id, tok!.route_date).catch(() => {});
    return reply("started");
  } catch (e) {
    console.warn("[live-activity] action failed", e);
    return { status: 503, body: { ok: false, error: "failed" } };
  }
}

// Presses per token seen by this instance in the last minute. A soft limit
// in front of the database's; an instance restart forgets it, which is fine.
const recentPresses = new Map<string, number[]>();

function seenTooOften(tokenId: string, at: number): boolean {
  const kept = (recentPresses.get(tokenId) ?? []).filter((t) => at - t < 60_000);
  kept.push(at);
  recentPresses.set(tokenId, kept);
  if (recentPresses.size > 5_000) {
    for (const [k, v] of recentPresses)
      if (v.every((t) => at - t >= 60_000)) recentPresses.delete(k);
  }
  return kept.length > ACTION_RATE_PER_MINUTE * 2;
}

/** Test hook: forget the in-memory presses. */
export function resetActionRateForTests() {
  recentPresses.clear();
}

/** Write the press's row. Its id when this press is the one that acts,
 *  "already" when another press for the same stop got there first. A row
 *  left "failed" by an earlier press may be claimed again. */
async function claim(
  db: Db,
  tok: ActionTokenRow,
  visitId: string,
  action: LockScreenAction,
): Promise<string | "already"> {
  const { data, error } = await db
    .from("live_activity_actions")
    .insert({
      token_id: tok.id,
      organization_id: tok.organization_id,
      user_id: tok.user_id,
      visit_id: visitId,
      action,
      outcome: "pending",
    })
    .select("id")
    .single();
  if (!error && data?.id) return data.id as string;
  if (error?.code !== "23505") throw new Error(error?.message ?? "claim failed");
  const { data: retry } = await db
    .from("live_activity_actions")
    .update({ outcome: "pending", detail: null, finished_at: null })
    .eq("token_id", tok.id)
    .eq("visit_id", visitId)
    .eq("action", action)
    .eq("outcome", "failed")
    .select("id")
    .maybeSingle();
  return retry?.id ? (retry.id as string) : "already";
}

/** Revoke every live action token a user holds: the route left the lock
 *  screen, or the tech clocked out. Never throws. */
export async function revokeActionTokens(userId: string, reason: string): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (supabaseAdmin as unknown as Db)
      .from("live_activity_action_tokens")
      .update({ revoked_at: new Date().toISOString(), revoke_reason: reason.slice(0, 200) })
      .eq("user_id", userId)
      .is("revoked_at", null);
  } catch (e) {
    console.warn("[live-activity] action tokens could not be revoked", userId, e);
  }
}

/** The real dependencies, for the route. */
export async function liveActivityActionDeps(): Promise<ActionDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as unknown as Db;
  const { logVisitStarted } = await import("@/lib/visit-activity.server");
  const { routeActivityStateFor, updateRouteLiveActivity } =
    await import("@/lib/push-liveactivity.server");
  return {
    db,
    logStarted: (visitId, actorUserId) =>
      logVisitStarted(db, { visitId, actorUserId, via: "lock_screen" }),
    routeState: routeActivityStateFor,
    push: updateRouteLiveActivity,
  };
}
