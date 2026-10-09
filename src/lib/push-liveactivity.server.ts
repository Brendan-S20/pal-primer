// Remote updates for the route on a technician's lock screen.
//
// The phone keeps its own Live Activity current while the tech works the
// route in the app. What it cannot see is the office changing the day: a stop
// reassigned to someone else, a visit added, the route re-sequenced, a stop
// canceled. For that iOS gives each Live Activity its own APNs push token,
// which the phone saves in live_activity_tokens, and this file pushes the
// rebuilt state to it.
//
// The APNs half is push.server.ts's: the same five APNS_* variables, the same
// cached ES256 provider token (Apple rate-limits minting it, so there must be
// one cache, not two), the same rule for a dead token. What differs, per
// Apple's "Starting and updating Live Activities with ActivityKit push
// notifications":
//
//   apns-push-type  liveactivity
//   apns-topic      <bundle id>.push-type.liveactivity
//   apns-priority   10 for a change a person would act on, 5 for a minor one
//                   (iOS may hold a 5 to save battery, and budgets 10s)
//   body            { aps: { timestamp, event: "update" | "end",
//                            "content-state": {...}, "dismissal-date"? } }
//
// `content-state` is decoded on the phone into
// RouteActivityAttributes.ContentState, so it is built by the SAME function
// My Day uses (src/lib/live-activity-state.ts), in the language the phone
// saved beside its token. The extension draws exactly what it is sent.
//
// A 410, BadDeviceToken, DeviceTokenNotForTopic or Unregistered switches the
// row off (ended_at, with the reason in end_reason), as push.server.ts does
// for a device. Nothing here throws into the dispatcher's action that caused
// it: a lock screen that did not update is never worth a failed reassign.

import {
  APNS_DEFAULT_TOPIC,
  apnsConfigFromEnv,
  apnsErrorIsGone,
  apnsProviderToken,
  forgetApnsProviderToken,
} from "@/lib/push.server";
import {
  buildRouteActivityState,
  routeChangePriority,
  type RouteActivityState,
  type RouteActivityVisit,
} from "@/lib/live-activity-state";
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";

export const LIVE_ACTIVITY_TOPIC_SUFFIX = ".push-type.liveactivity";

/** consulting.thenorth.houndstack.push-type.liveactivity, from the app's topic. */
export function liveActivityTopic(appTopic: string = APNS_DEFAULT_TOPIC): string {
  return `${appTopic}${LIVE_ACTIVITY_TOPIC_SUFFIX}`;
}

/** How long a finished route stays on the lock screen. */
export const FINISHED_ROUTE_LINGERS_S = 15 * 60;

export type LiveActivityMessage = {
  event: "update" | "end";
  state: RouteActivityState;
  priority: 5 | 10;
  /** Seconds since the epoch. iOS drops a push older than the last one. */
  timestamp: number;
  /** For "end": when iOS takes it off the lock screen, seconds since epoch. */
  dismissalDate?: number;
};

/** The request for one token, minus the authorization header. Pure, so the
 *  wire shape is testable without a key or a network. */
export function liveActivityRequestFor(
  token: string,
  msg: LiveActivityMessage,
  appTopic: string = APNS_DEFAULT_TOPIC,
): { path: string; headers: Record<string, string>; body: { aps: Record<string, unknown> } } {
  return {
    path: `/3/device/${token}`,
    headers: {
      "apns-topic": liveActivityTopic(appTopic),
      "apns-push-type": "liveactivity",
      "apns-priority": String(msg.priority),
      "content-type": "application/json",
    },
    body: {
      aps: {
        timestamp: msg.timestamp,
        event: msg.event,
        "content-state": msg.state,
        ...(msg.event === "end" && msg.dismissalDate != null
          ? { "dismissal-date": msg.dismissalDate }
          : {}),
      },
    },
  };
}

type AdminLike = { from: (table: string) => any };

async function admin(): Promise<AdminLike> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as AdminLike;
}

export type LiveActivityTokenRow = { id: string; push_token: string };

let warnedUnconfigured = false;

/** Send one message to each row. Never throws. */
export async function sendLiveActivityPush(
  rows: LiveActivityTokenRow[],
  msg: LiveActivityMessage,
  db?: AdminLike,
): Promise<{ sent: number; failed: number; ended: number }> {
  const out = { sent: 0, failed: 0, ended: 0 };
  if (rows.length === 0) return out;
  const { config, missing } = apnsConfigFromEnv();
  if (!config) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        `[live-activity] ${rows.length} lock screen(s) not updated: APNs is not configured (missing ${missing.join(", ")}).`,
      );
    }
    return out;
  }
  let jwt: string;
  try {
    jwt = await apnsProviderToken(config);
  } catch (e) {
    console.error("[live-activity] APNs provider token could not be signed: check APNS_AUTH_KEY", e);
    out.failed = rows.length;
    return out;
  }
  const store = db ?? (await admin());
  const now = () => new Date().toISOString();

  await Promise.all(
    rows.map(async (row) => {
      try {
        const req = liveActivityRequestFor(row.push_token, msg, config.topic);
        const res = await fetch(`${config.host}${req.path}`, {
          method: "POST",
          headers: { authorization: `bearer ${jwt}`, ...req.headers },
          body: JSON.stringify(req.body),
        });
        if (res.status === 200) {
          out.sent++;
          await store
            .from("live_activity_tokens")
            .update({
              last_state: msg.state,
              last_sent_at: now(),
              last_error: null,
              ...(msg.event === "end" ? { ended_at: now(), end_reason: "finished" } : {}),
            })
            .eq("id", row.id);
          return;
        }
        const reason: string | undefined = (await res.json().catch(() => ({})))?.reason;
        // A rejected provider token is ours to fix, and the cached bad one
        // would otherwise keep failing for fifty minutes after the fix.
        if (res.status === 403) forgetApnsProviderToken();
        out.failed++;
        const why = (reason ?? `apns_${res.status}`).slice(0, 200);
        if (apnsErrorIsGone(res.status, reason)) {
          out.ended++;
          await store
            .from("live_activity_tokens")
            .update({ ended_at: now(), end_reason: why, last_error: why })
            .eq("id", row.id);
        } else {
          await store.from("live_activity_tokens").update({ last_error: why }).eq("id", row.id);
        }
      } catch (e) {
        out.failed++;
        console.warn("[live-activity] send failed", row.id, e);
      }
    }),
  );
  return out;
}

/** `t` for one of the four languages, without touching the global language. */
async function translatorFor(lang: string) {
  const i18n = (await import("@/lib/i18n")).default;
  const { intlLocaleFor, dirFor } = await import("@/lib/i18n");
  return {
    t: i18n.getFixedT(lang) as unknown as (key: string, opts?: Record<string, unknown>) => string,
    locale: intlLocaleFor(lang),
    rtl: dirFor(lang) === "rtl",
  };
}

/** A tech's route for one day as the database has it, in getMyDay's order,
 *  and the clock it is read on. */
async function loadRoute(
  db: AdminLike,
  techUserId: string,
  orgId: string,
  date: string,
): Promise<{ visits: RouteActivityVisit[]; tz: string }> {
  const [{ data: staff }, { data: org }] = await Promise.all([
    db
      .from("staff")
      .select("id")
      .eq("user_id", techUserId)
      .eq("organization_id", orgId)
      .maybeSingle(),
    db
      .from("organizations")
      .select("timezone")
      .eq("id", orgId)
      .maybeSingle(),
  ]);
  let visits: RouteActivityVisit[] = [];
  if (staff?.id) {
    // The same rows, in the same order, as getMyDay in my-day.functions.ts.
    const { data: v, error: vErr } = await db
      .from("visits")
      .select(
        // city, postal_code and the coordinates are where the card's
        // Navigate button sends the maps app (stopDestination).
        "id, status, sequence, eta_start, eta_end, properties(label, street, city, postal_code, latitude, longitude, earliest_service_time, latest_service_time)",
      )
      .eq("assigned_staff_id", staff.id)
      .eq("scheduled_on", date)
      .order("sequence", { ascending: true, nullsFirst: false });
    if (vErr) throw new Error(vErr.message);
    visits = (v ?? []) as RouteActivityVisit[];
  }
  return {
    visits,
    tz: (org?.timezone as string | null) || DEFAULT_ORG_TIMEZONE,
  };
}

/** The content state for a tech's route, in one language, as the database
 *  has it now. The lock-screen hook answers a press with this, so the card
 *  flips at once without waiting for a push. Never throws; null on failure. */
export async function routeActivityStateFor(
  techUserId: string,
  orgId: string,
  date: string,
  lang: string,
): Promise<RouteActivityState | null> {
  try {
    const db = await admin();
    const route = await loadRoute(db, techUserId, orgId, date);
    const tr = await translatorFor(lang);
    return buildRouteActivityState(route.visits, {
      t: tr.t,
      tz: route.tz,
      locale: tr.locale,
      rtl: tr.rtl,
    });
  } catch (e) {
    console.warn("[live-activity] routeActivityStateFor failed", techUserId, date, e);
    return null;
  }
}

/**
 * Rebuild a tech's route for `date` from the database and push it to every
 * live activity they have for that day. A route with nothing left on it --
 * finished, or every stop taken away -- ends the activity. Unchanged state is
 * not sent. Never throws.
 */
export async function updateRouteLiveActivity(
  techUserId: string,
  date: string,
): Promise<{ sent: number; failed: number; ended: number; unchanged: number }> {
  const total = { sent: 0, failed: 0, ended: 0, unchanged: 0 };
  try {
    const db = await admin();
    const { data: tokens, error } = await db
      .from("live_activity_tokens")
      .select("id, push_token, locale, organization_id, last_state")
      .eq("user_id", techUserId)
      .eq("route_date", date)
      .is("ended_at", null);
    if (error) throw new Error(error.message);
    const rows = (tokens ?? []) as Array<{
      id: string;
      push_token: string;
      locale: string | null;
      organization_id: string;
      last_state: RouteActivityState | null;
    }>;
    if (rows.length === 0) return total;

    const orgId = rows[0].organization_id;
    const route = await loadRoute(db, techUserId, orgId, date);
    const nowS = Math.floor(Date.now() / 1000);

    for (const row of rows) {
      const tr = await translatorFor(row.locale ?? "en");
      const state = buildRouteActivityState(route.visits, {
        t: tr.t,
        tz: route.tz,
        locale: tr.locale,
        rtl: tr.rtl,
      });
      const nothingLeft = state.allDone || state.total === 0;
      const priority = routeChangePriority(row.last_state, state);
      if (priority == null && !nothingLeft) {
        total.unchanged++;
        continue;
      }
      const r = await sendLiveActivityPush(
        [{ id: row.id, push_token: row.push_token }],
        {
          event: nothingLeft ? "end" : "update",
          state,
          priority: priority ?? 10,
          timestamp: nowS,
          ...(nothingLeft
            ? { dismissalDate: state.allDone ? nowS + FINISHED_ROUTE_LINGERS_S : nowS }
            : {}),
        },
        db,
      );
      total.sent += r.sent;
      total.failed += r.failed;
      total.ended += r.ended;
    }
  } catch (e) {
    console.warn("[live-activity] updateRouteLiveActivity failed", techUserId, date, e);
  }
  return total;
}

export type RouteDay = { staffId: string | null | undefined; day: string | null | undefined };

/**
 * Push to every tech whose route for one of these days is on a lock screen.
 * Two queries when nobody has one, which is the common case. Never throws.
 */
export async function refreshRouteLiveActivities(pairs: RouteDay[]): Promise<void> {
  try {
    const wanted = new Map<string, { staffId: string; day: string }>();
    for (const p of pairs) {
      if (p.staffId && p.day) wanted.set(`${p.staffId}|${p.day}`, { staffId: p.staffId, day: p.day });
    }
    if (wanted.size === 0) return;
    const db = await admin();
    const staffIds = [...new Set([...wanted.values()].map((p) => p.staffId))];
    const days = [...new Set([...wanted.values()].map((p) => p.day))];
    const { data: staff } = await db.from("staff").select("id, user_id").in("id", staffIds);
    const userOf = new Map<string, string>();
    for (const s of (staff ?? []) as Array<{ id: string; user_id: string | null }>) {
      if (s.user_id) userOf.set(s.id, s.user_id);
    }
    if (userOf.size === 0) return;
    const { data: live } = await db
      .from("live_activity_tokens")
      .select("user_id, route_date")
      .in("user_id", [...new Set(userOf.values())])
      .in("route_date", days)
      .is("ended_at", null);
    const hasLive = new Set(
      ((live ?? []) as Array<{ user_id: string; route_date: string }>).map(
        (r) => `${r.user_id}|${r.route_date}`,
      ),
    );
    const targets = new Set<string>();
    for (const p of wanted.values()) {
      const user = userOf.get(p.staffId);
      if (user && hasLive.has(`${user}|${p.day}`)) targets.add(`${user}|${p.day}`);
    }
    for (const key of targets) {
      const [user, day] = key.split("|");
      await updateRouteLiveActivity(user, day);
    }
  } catch (e) {
    console.warn("[live-activity] refreshRouteLiveActivities failed", e);
  }
}

/** Every live route in an organization, for a change that moves work between
 *  techs without saying whose (redistributing a departing tech's work). */
export async function refreshOrgRouteLiveActivities(orgId: string): Promise<void> {
  try {
    const db = await admin();
    const { data } = await db
      .from("live_activity_tokens")
      .select("user_id, route_date")
      .eq("organization_id", orgId)
      .is("ended_at", null);
    const keys = new Set(
      ((data ?? []) as Array<{ user_id: string; route_date: string }>).map(
        (r) => `${r.user_id}|${r.route_date}`,
      ),
    );
    for (const key of keys) {
      const [user, day] = key.split("|");
      await updateRouteLiveActivity(user, day);
    }
  } catch (e) {
    console.warn("[live-activity] refreshOrgRouteLiveActivities failed", orgId, e);
  }
}

/** Whose route, on which day, each of these visits is on right now. */
export async function routeDaysForVisits(visitIds: string[]): Promise<RouteDay[]> {
  if (visitIds.length === 0) return [];
  try {
    const db = await admin();
    const { data } = await db
      .from("visits")
      .select("assigned_staff_id, scheduled_on")
      .in("id", visitIds);
    return ((data ?? []) as Array<{ assigned_staff_id: string | null; scheduled_on: string }>).map(
      (v) => ({ staffId: v.assigned_staff_id, day: v.scheduled_on }),
    );
  } catch {
    return [];
  }
}

/**
 * For an office action that moves visits: note whose routes they are on
 * BEFORE the change, and after it push to both sides -- the tech who lost the
 * stop and the tech who gained it, the day it left and the day it went to.
 *
 *   const pushed = await watchRouteLiveActivities([visitId]);
 *   ...the change...
 *   await pushed();
 */
export async function watchRouteLiveActivities(
  visitIds: string[],
): Promise<(extra?: RouteDay[]) => Promise<void>> {
  const before = await routeDaysForVisits(visitIds);
  return async (extra: RouteDay[] = []) => {
    const after = await routeDaysForVisits(visitIds);
    await refreshRouteLiveActivities([...before, ...after, ...extra]);
  };
}
