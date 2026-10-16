// What a calendar feed says about a visit. Pure, so the rules can be tested
// without a database: calendar_feed_events (the SQL) decides WHICH visits and
// which fields leave the building, and this decides how they read in Google,
// Apple or Outlook.
//
// Two scopes, and the difference between them is the point:
//
//   mine  a technician's own assigned visits. The SQL may send access codes
//         when the owner turned that on (organizations.calendar_feed_access_codes),
//         but this file prints only that access details are in the app, never
//         the codes (#410).
//   org   every visit, for whoever runs the board. NEVER carries access codes:
//         the SQL does not select them for this scope, and this file does not
//         print them for it either, so a regression in one layer is not a leak.

import { buildCalendar, nextDay, type IcsEvent } from "@/lib/ics";

export type FeedScope = "mine" | "org";

export type FeedVisit = {
  id: string;
  scheduled_on: string;
  status: string;
  eta_start: string | null;
  eta_end: string | null;
  updated_at: string | null;
  client_name: string | null;
  street: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  tech_name: string | null;
  gate_code?: string | null;
  lock_box_code?: string | null;
  key_location?: string | null;
};

export type FeedPayload = {
  scope: FeedScope;
  org_name: string | null;
  timezone: string;
  holder_name: string | null;
  events: FeedVisit[];
};

/** Anything past this and the timed event is assumed to be bad data and the
 *  visit falls back to all-day, rather than a 3-week block on someone's phone. */
const MAX_TIMED_MS = 12 * 3_600_000;
/** An ETA with a start and no usable end still gets a slot this long. */
const DEFAULT_TIMED_MS = 30 * 60_000;

/** Stable per visit, and per nothing else: re-fetching, rescheduling, or
 *  reassigning a visit updates the same event instead of adding another. The
 *  domain part keeps it globally unique, as §3.8.4.7 asks. */
export function visitUid(visitId: string): string {
  return `visit-${visitId}@houndstack.com`;
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  skipped: "Skipped",
  canceled: "Cancelled",
  missed: "Missed",
};

function address(v: FeedVisit): string {
  const cityLine = [v.city, [v.region, v.postal_code].filter(Boolean).join(" ")]
    .filter((s) => s && String(s).trim())
    .join(", ");
  return [v.street, cityLine].filter((s) => s && String(s).trim()).join(", ");
}

function instant(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Timed from the ETA window when there is a usable start, otherwise all-day
 *  on the scheduled day. scheduled_on is already the ORGANIZATION's calendar
 *  day, so an all-day DATE is the right day on every phone in every zone. */
export function visitTiming(v: FeedVisit): Pick<IcsEvent, "allDay" | "timed"> {
  const start = instant(v.eta_start);
  if (start != null) {
    const endRaw = instant(v.eta_end);
    const end =
      endRaw != null && endRaw > start && endRaw - start <= MAX_TIMED_MS
        ? endRaw
        : start + DEFAULT_TIMED_MS;
    return { timed: { start: new Date(start), end: new Date(end) } };
  }
  return { allDay: { start: v.scheduled_on, end: nextDay(v.scheduled_on) } };
}

/** What a technician's own feed says in place of a gate code, lock box code
 *  or key location. */
export const ACCESS_IN_APP = "Access details are in the app";

export function visitDescription(v: FeedVisit, scope: FeedScope): string {
  const lines: string[] = [];
  lines.push(`Status: ${STATUS_LABEL[v.status] ?? v.status}`);
  if (scope === "org") {
    lines.push(`Technician: ${v.tech_name ?? "Unassigned"}`);
  } else if (v.gate_code || v.lock_box_code || v.key_location) {
    // The codes themselves never go in a feed. Calendar apps sync events to
    // their own servers, and a lock box code there is out of the business's
    // hands (#410). The technician's own feed says where to find them.
    lines.push(ACCESS_IN_APP);
  }
  return lines.join("\n");
}

export function visitToEvent(v: FeedVisit, scope: FeedScope): IcsEvent {
  const client = v.client_name?.trim() || "Visit";
  const cancelled = v.status === "skipped" || v.status === "canceled";
  const summary =
    scope === "org" ? `${client} (${v.tech_name?.trim() || "Unassigned"})` : client;
  return {
    uid: visitUid(v.id),
    summary: cancelled
      ? `${v.status === "skipped" ? "Skipped" : "Cancelled"}: ${summary}`
      : summary,
    location: address(v) || null,
    description: visitDescription(v, scope),
    status: cancelled ? "CANCELLED" : "CONFIRMED",
    lastModified: v.updated_at,
    ...visitTiming(v),
  };
}

export function feedCalendarName(p: Pick<FeedPayload, "scope" | "org_name" | "holder_name">): string {
  const org = p.org_name?.trim() || "HoundStack";
  if (p.scope === "org") return `${org}: all visits`;
  return p.holder_name?.trim() ? `${org}: ${p.holder_name.trim()}` : `${org}: my visits`;
}

/** The whole .ics body for a feed. */
export function buildFeedCalendar(p: FeedPayload, now: Date = new Date()): string {
  return buildCalendar(
    {
      prodId: "-//HoundStack//Calendar feed//EN",
      name: feedCalendarName(p),
      timezone: p.timezone,
      // A hint; Google ignores it and polls on its own schedule (hours).
      refreshMinutes: 60,
      events: p.events.map((v) => visitToEvent(v, p.scope)),
    },
    now,
  );
}

// ── The link itself ─────────────────────────────────────────────────────────

/** 32 random bytes, base64url: 43 characters from [A-Za-z0-9_-]. Anything
 *  else is refused before a hash is computed or the database is asked. */
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The path segment a calendar app is given. `.ics` on the end because a few
 *  clients (older Outlook) decide what a URL is by its extension. */
export function feedPath(token: string): string {
  return `/api/public/calendar/${token}.ics`;
}

/** The route receives `<token>.ics` (or a bare token); this returns the token
 *  or null when what arrived could not be one. */
export function tokenFromPathSegment(segment: string | null | undefined): string | null {
  if (!segment) return null;
  const t = segment.endsWith(".ics") ? segment.slice(0, -4) : segment;
  return FEED_TOKEN_RE.test(t) ? t : null;
}

/** webcal:// is what makes Apple Calendar and Outlook offer "Subscribe" when
 *  the link is tapped, rather than downloading a one-off copy. */
export function webcalUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https?:\/\//, "webcal://");
}

/** Google Calendar's "add by URL" deep link. */
export function googleSubscribeUrl(httpsUrl: string): string {
  return `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl(httpsUrl))}`;
}
