// Server-only helpers to emit in-app notifications. Rows are fanned out one per
// recipient user so RLS stays trivial. Call from webhooks / RPCs / server fns
// (best-effort — a notification failure must never block the triggering action).

export type NotifyInput = {
  orgId: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  /** The ITEM this is about: `route:<staffId>:<day>`, `visit:<id>`. Stored on
   *  the row (what coalescing looks up) and sent as the push's thread, so the
   *  phone stacks every push about one tech's day together. */
  threadId?: string | null;
  /** The one notification a newer push about the same thing REPLACES on the
   *  phone: `late:<visitId>`, `route:<staffId>:<day>`. Push only. */
  collapseId?: string | null;
  /** The EVENT, unique per recipient (a unique index since
   *  20261004150000). Telling the same event twice inserts one row, and only
   *  the recipients whose row was actually inserted are pushed: an offline
   *  replay, or a GPS ping every thirty seconds while a truck stays late,
   *  buzzes nobody a second time. */
  eventKey?: string | null;
  /** Push or not, overriding the type's default (IN_APP_ONLY_TYPES). For a
   *  type whose urgency depends on the content: a finished route is good news
   *  unless something on it was skipped. */
  push?: boolean;
  /** The person who made the change. Nobody is told about their own action:
   *  a tech who reorders their own day, an owner who skips their own stop. */
  exceptUserId?: string | null;
  /** Fold a burst into one notification. If the recipient already has a row
   *  in the same thread (threadId) from the last `windowMs`, that row is
   *  rewritten with this text and marked unread, and NOTHING is pushed: the
   *  phone already buzzed for this item a moment ago. A dispatcher dragging
   *  ten stops around a tech's day is one notification that keeps up, not
   *  ten. Leading edge: the first change pushes at once, a change after the
   *  window pushes again (and replaces the old one on the device, by
   *  collapseId). */
  coalesce?: { windowMs: number; title: string; body?: string | null; link?: string | null };
};

export type NotifyResult = {
  /** Rows inserted. */
  inserted: string[];
  /** Rows rewritten in place by `coalesce`. */
  coalesced: string[];
  /** Recipients a push was sent to. */
  pushed: string[];
};

const NONE: NotifyResult = { inserted: [], coalesced: [], pushed: [] };

/** Types that land in the notification centre but do not buzz a phone: good
 *  news or a nightly summary, nothing anyone has to act on now. The nightly
 *  job runs in the small hours, and a push at 3am about the schedule horizon
 *  is how an owner learns to turn notifications off altogether. */
export const IN_APP_ONLY_TYPES = new Set(["schedule.horizon", "payout_paid"]);

// ── The same event, told once per server instance ──────────────────────────
//
// The database is what guarantees "once" (the unique event_key). This is only
// a cache in front of it, so that the GPS ping a late truck sends every thirty
// seconds does not cost three queries each time to learn what the first ping
// already established. Per isolate, so another instance may still ask the
// database, which then answers "already told" for free. Bounded and pruned.
const EVENT_MEMO_MS = 15 * 60_000;
const eventMemo = new Map<string, number>();

function toldRecently(eventKey: string | null | undefined, now = Date.now()): boolean {
  if (!eventKey) return false;
  const at = eventMemo.get(eventKey);
  return at != null && now - at < EVENT_MEMO_MS;
}

function rememberTold(eventKey: string, now = Date.now()) {
  eventMemo.set(eventKey, now);
  if (eventMemo.size > 1000) {
    for (const [k, at] of eventMemo) if (now - at >= EVENT_MEMO_MS) eventMemo.delete(k);
    // Still too big: drop the oldest half. Losing a memo costs one query.
    if (eventMemo.size > 1000) [...eventMemo.keys()].slice(0, 500).forEach((k) => eventMemo.delete(k));
  }
}

/** Test hook. */
export function resetNotifyMemoForTests() {
  eventMemo.clear();
}

/** The error a write gets when the columns 20261004150000 adds are not on the
 *  database yet: the app deploys on merge and the migration is applied after
 *  it, so for a few minutes the code is ahead. Unknown column in PostgREST's
 *  cache (PGRST204), in Postgres (42703), or ON CONFLICT with no index to
 *  match (42P10). In that window a notification goes out the old way, without
 *  the new columns, rather than not at all. */
function isSchemaBehind(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    error.code === "42P10" ||
    /thread_id|event_key/.test(error.message ?? "")
  );
}

/** Notify specific users by id. */
export async function notifyUsers(userIds: string[], n: NotifyInput): Promise<NotifyResult> {
  let ids = Array.from(new Set(userIds.filter(Boolean)));
  if (n.exceptUserId) ids = ids.filter((uid) => uid !== n.exceptUserId);
  if (!ids.length || toldRecently(n.eventKey)) return NONE;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  // Drop recipients who muted this notification type.
  const { data: prefs } = await admin
    .from("app_notification_prefs")
    .select("user_id, muted_types")
    .in("user_id", ids);
  const muted = new Set(
    (prefs ?? []).filter((p: any) => (p.muted_types ?? []).includes(n.type)).map((p: any) => p.user_id),
  );
  ids = ids.filter((uid) => !muted.has(uid));
  if (!ids.length) return NONE;

  // Nobody whose access to this business is turned off (20261009180000). A
  // push carries the business's data -- an address, a client's name -- to a
  // phone the owner has deliberately cut off, and nothing else stops it: this
  // runs on the service role, past every policy.
  try {
    const { data: off, error: offErr } = await admin
      .from("staff")
      .select("user_id")
      .eq("organization_id", n.orgId)
      .eq("active", false)
      .in("user_id", ids);
    if (offErr) throw new Error(offErr.message);
    const turnedOff = new Set((off ?? []).map((r: any) => r.user_id));
    ids = ids.filter((uid) => !turnedOff.has(uid));
  } catch (e) {
    console.error("notifyUsers turned-off lookup failed", e);
  }
  if (!ids.length) return NONE;

  const coalesced = n.coalesce && n.threadId ? await coalesceInto(admin, ids, n) : [];
  ids = ids.filter((uid) => !coalesced.includes(uid));
  if (!ids.length) return { inserted: [], coalesced, pushed: [] };

  const inserted = await insertRows(admin, ids, n);
  if (n.eventKey && inserted.length) rememberTold(n.eventKey);

  const pushed = await pushToUsers(inserted, n);
  return { inserted, coalesced, pushed };
}

/** Rewrite the recipient's recent row in the same thread, if there is one.
 *  Returns the recipients that were folded in (and so are not inserted or
 *  pushed). Any failure, including the columns not existing yet, answers
 *  "none": a notification too many is better than none at all. */
async function coalesceInto(admin: any, ids: string[], n: NotifyInput): Promise<string[]> {
  const c = n.coalesce!;
  try {
    const since = new Date(Date.now() - c.windowMs).toISOString();
    const { data: recent, error } = await admin
      .from("app_notifications")
      .select("id, recipient_user_id, created_at")
      .in("recipient_user_id", ids)
      .eq("thread_id", n.threadId)
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    if (error || !recent?.length) return [];
    const latest = new Map<string, string>();
    for (const r of recent as Array<{ id: string; recipient_user_id: string }>) {
      if (!latest.has(r.recipient_user_id)) latest.set(r.recipient_user_id, r.id);
    }
    const folded: string[] = [];
    for (const [uid, rowId] of latest) {
      const { error: uErr } = await admin
        .from("app_notifications")
        .update({ title: c.title, body: c.body ?? null, link: c.link ?? n.link ?? null, read_at: null })
        .eq("id", rowId);
      if (!uErr) folded.push(uid);
    }
    return folded;
  } catch (e) {
    console.warn("notifyUsers coalesce lookup failed", e);
    return [];
  }
}

/** Insert one row per recipient. Returns the recipients whose row is new. */
async function insertRows(admin: any, ids: string[], n: NotifyInput): Promise<string[]> {
  const base = ids.map((uid) => ({
    organization_id: n.orgId,
    recipient_user_id: uid,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    link: n.link ?? null,
  }));
  const withKeys = base.map((r) => ({
    ...r,
    ...(n.threadId ? { thread_id: n.threadId } : {}),
    ...(n.eventKey ? { event_key: n.eventKey } : {}),
  }));

  if (n.eventKey) {
    // ignoreDuplicates is ON CONFLICT DO NOTHING, and `select` returns only
    // the rows that were inserted: the recipients already told are the ones
    // missing from the answer.
    const { data, error } = await admin
      .from("app_notifications")
      .upsert(withKeys, { onConflict: "recipient_user_id,event_key", ignoreDuplicates: true })
      .select("recipient_user_id");
    if (!error) {
      return ((data ?? []) as Array<{ recipient_user_id: string }>).map((r) => r.recipient_user_id);
    }
    if (!isSchemaBehind(error)) {
      // Not pushed: without the row there is no way to know whether this
      // event was already told, and a push repeated on every retry or GPS
      // ping is the noise this key exists to stop.
      console.error("notifyUsers insert failed", error.message);
      return [];
    }
    const { error: oldErr } = await admin.from("app_notifications").insert(base);
    if (oldErr) console.error("notifyUsers insert failed", oldErr.message);
    return ids;
  }

  const { error } = await admin.from("app_notifications").insert(withKeys);
  if (error && n.threadId && isSchemaBehind(error)) {
    const { error: oldErr } = await admin.from("app_notifications").insert(base);
    if (oldErr) console.error("notifyUsers insert failed", oldErr.message);
  } else if (error) {
    console.error("notifyUsers insert failed", error.message);
  }
  // As it always has: the push is the half that matters on a phone, and a
  // failed centre row does not stop it.
  return ids;
}

/**
 * The same notification, as a push to every device each recipient has
 * registered — the iOS app, the Android app, and any browser they turned
 * push on in. Until this existed `sendPushToUser` had no caller at all: the
 * iOS app registered a token on every launch and nothing was ever sent to it.
 *
 * Mutes are already applied (the caller filtered `ids`). Best-effort: a push
 * failure is logged inside sendPushToUser and never reaches the action that
 * raised the notification.
 */
async function pushToUsers(ids: string[], n: NotifyInput): Promise<string[]> {
  if (!ids.length) return [];
  if (!(n.push ?? !IN_APP_ONLY_TYPES.has(n.type))) return [];
  try {
    const { sendPushToUser } = await import("@/lib/push.server");
    await Promise.all(
      ids.map((uid) =>
        sendPushToUser(uid, {
          title: n.title,
          body: n.body ?? undefined,
          // The tap lands where the notification centre row links to: the
          // stop, the route or the client, not the list of notifications.
          url: n.link ?? "/notifications",
          data: { type: n.type },
          ...(n.threadId ? { threadId: n.threadId } : {}),
          ...(n.collapseId ? { collapseId: n.collapseId } : {}),
        }),
      ),
    );
    return ids;
  } catch (e) {
    console.error("notifyUsers push failed", e);
    return [];
  }
}

/** Notify every user in the org holding one of the given roles. */
export async function notifyRoles(
  roles: Array<"owner" | "office_manager" | "dispatcher" | "tech">,
  n: NotifyInput,
): Promise<NotifyResult> {
  if (toldRecently(n.eventKey)) return NONE;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("user_id, role")
    .eq("organization_id", n.orgId)
    .in("role", roles);
  return notifyUsers((data ?? []).map((r: any) => r.user_id), n);
}
