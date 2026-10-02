import { appUrl } from "@/lib/app-origin";
import { etaPhrase } from "@/lib/on-my-way";
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";

/** Live "your tech is on the way" tracking: the rules, pure.
 *
 *  The database enforces the same window (live_tracking_window_open in
 *  supabase/migrations/20260929100000_nobody-could-see-the-truck-coming.sql)
 *  and rounds the position before it leaves; this file is the app's copy, so
 *  the tech's phone stops asking for a location the database would refuse,
 *  and so the rules are tested without a database. */

/** How long after "on my way" sharing may last, at most. */
export const SHARING_WINDOW_MS = 2 * 60 * 60 * 1000;

/** How often the tech's phone posts its position while sharing. */
export const POST_INTERVAL_MS = 30_000;

/** How often the customer's page asks again. */
export const PUBLIC_POLL_MS = 30_000;

/** Decimal places a position is rounded to before a customer sees it. Three
 *  places is 0.001 degrees: about 111 m north to south everywhere, and about
 *  80 m east to west at 45 degrees of latitude. The database rounds the same
 *  way, so the exact fix never leaves it. */
export const PUBLIC_POSITION_DECIMALS = 3;

export type Position = { lat: number; lng: number };

/** A position rounded to about 100 m. Every position in the 0.001 degree cell
 *  comes out the same, so the answer cannot be worked back to the fix. */
export function approximatePosition(p: Position): Position {
  const f = 10 ** PUBLIC_POSITION_DECIMALS;
  // Postgres rounds a numeric half away from zero, and reads a double as 15
  // significant digits first, so -87.6485 is exactly a half there. Here the
  // same double times 1000 is 87648.49999999999. Rounding the magnitude, with
  // a nudge far below a millimetre, gives the database's answer on both.
  const r = (x: number) => (Math.sign(x) * Math.round(Math.abs(x) * f + 1e-7)) / f + 0;
  return { lat: r(p.lat), lng: r(p.lng) };
}

export type SharingWindow =
  | { share: true; until: Date }
  | {
      share: false;
      reason: "turned_off" | "not_announced" | "started" | "expired" | "stopped";
    };

/** Whether the tech's location may be shared for this visit right now.
 *
 *  Only between the "on my way" message and the start of the visit, for at
 *  most two hours, while the business has tracking on and the tech has not
 *  pressed Stop since the message went. Not before the message: a tech
 *  driving to stop 1 is not on the way to stop 4. Not after the start: a
 *  customer does not need a map of their own yard. */
export function sharingWindow(v: {
  enabled: boolean;
  status: string;
  onMyWaySentAt: string | null | undefined;
  stoppedAt?: string | null | undefined;
  now?: Date;
}): SharingWindow {
  const now = v.now ?? new Date();
  if (!v.enabled) return { share: false, reason: "turned_off" };
  if (v.status !== "scheduled") return { share: false, reason: "started" };
  const sent = v.onMyWaySentAt ? new Date(v.onMyWaySentAt) : null;
  if (!sent || Number.isNaN(sent.getTime())) return { share: false, reason: "not_announced" };
  const until = new Date(sent.getTime() + SHARING_WINDOW_MS);
  if (now >= until) return { share: false, reason: "expired" };
  const stopped = v.stoppedAt ? new Date(v.stoppedAt) : null;
  if (stopped && !Number.isNaN(stopped.getTime()) && stopped >= sent) {
    return { share: false, reason: "stopped" };
  }
  return { share: true, until };
}

/** The customer's link. */
export function trackingUrl(token: string): string {
  return appUrl(`/track/${token}`);
}

export type PublicTrackingStatus = "en_route" | "arrived" | "done" | "ended";

/** What the customer's page says at the top, by status. */
export function trackingHeadline(status: PublicTrackingStatus, techName: string | null): string {
  const who = techName ?? "Your tech";
  switch (status) {
    case "en_route":
      return `${who} is on the way`;
    case "arrived":
      return "Your tech has arrived";
    case "done":
      return "Today's visit is done";
    case "ended":
      return "Live tracking for this visit has ended";
  }
}

/** "Updated just now" / "Updated 3 min ago", for a fix the database stamped. */
export function updatedAgo(recordedAt: string | null | undefined, now: Date = new Date()): string | null {
  if (!recordedAt) return null;
  const t = new Date(recordedAt).getTime();
  if (Number.isNaN(t)) return null;
  const min = Math.floor((now.getTime() - t) / 60_000);
  if (min < 1) return "Updated just now";
  return `Updated ${min} min ago`;
}

/** What public_visit_tracking returns. */
export type TrackingDoc = {
  status: PublicTrackingStatus;
  business_name: string | null;
  tech_first_name: string | null;
  timezone?: string | null;
  eta_start?: string | null;
  eta_end?: string | null;
  sharing?: boolean;
  tech_lat?: number | string | null;
  tech_lng?: number | string | null;
  tech_recorded_at?: string | null;
  home_lat?: number | string | null;
  home_lng?: number | string | null;
};

export type PublicTracking =
  | { found: false }
  | {
      found: true;
      status: PublicTrackingStatus;
      businessName: string;
      techName: string | null;
      eta: string | null;
      /** Rounded to about 100 m, and only while the tech is en route. */
      tech: { lat: number; lng: number; recordedAt: string | null } | null;
      /** The property, rounded the same way. */
      home: { lat: number; lng: number } | null;
    };

const num = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

/** Map what public_visit_tracking returned to what the page draws. Pure, and
 *  rounds again, so a change in the SQL can never widen what the page shows. */
export function publicTrackingView(doc: TrackingDoc | null, now: Date = new Date()): PublicTracking {
  if (!doc) return { found: false };
  const enRoute = doc.status === "en_route";
  const tLat = num(doc.tech_lat);
  const tLng = num(doc.tech_lng);
  const hLat = num(doc.home_lat);
  const hLng = num(doc.home_lng);
  return {
    found: true,
    status: doc.status,
    businessName: doc.business_name ?? "Your service provider",
    techName: doc.tech_first_name ?? null,
    eta: enRoute
      ? etaPhrase(doc.eta_start, doc.eta_end, doc.timezone || DEFAULT_ORG_TIMEZONE, now)
      : null,
    tech:
      enRoute && doc.sharing && tLat !== null && tLng !== null
        ? { ...approximatePosition({ lat: tLat, lng: tLng }), recordedAt: doc.tech_recorded_at ?? null }
        : null,
    home:
      enRoute && hLat !== null && hLng !== null ? approximatePosition({ lat: hLat, lng: hLng }) : null,
  };
}
