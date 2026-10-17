/** A walk asked for from the portal, with a time window (#410).
 *
 *  Two steps of portalRequestOneOff, kept here so portal.functions.ts only
 *  calls them:
 *
 *    checkedWalkWindow      the window the client picked is one the card
 *                           offered (the org's working day in two-hour
 *                           windows), for a dog walk, or there is none.
 *    recordRequestedWindow  writes it onto the request (qc_tickets), so the
 *                           office sees it in /concerns and its Book it
 *                           carries it onto the visit.
 *
 *  Service role callers only: both take the organization id from the portal
 *  session and filter by it. */

import {
  WINDOW_NOT_OFFERED,
  isOfferedWindow,
  normalizeClock,
  walkWindows,
  windowLabel,
} from "@/lib/walk-windows";

export type RequestedWindow = { earliest: string; latest: string; label: string };

export async function checkedWalkWindow(
  sb: any,
  orgId: string,
  service: { service_line: string } | null,
  input: { earliestTime?: string; latestTime?: string },
): Promise<RequestedWindow | null> {
  if (!input.earliestTime && !input.latestTime) return null;
  if (service?.service_line !== "dog_walking") {
    throw new Error("A time can only be picked for a walk.");
  }
  const { data: org } = await sb
    .from("organizations")
    .select("workday_start, workday_end")
    .eq("id", orgId)
    .maybeSingle();
  const windows = walkWindows(org?.workday_start ?? null, org?.workday_end ?? null);
  if (!isOfferedWindow(windows, input.earliestTime, input.latestTime)) {
    throw new Error(WINDOW_NOT_OFFERED);
  }
  const earliest = normalizeClock(input.earliestTime)!;
  const latest = normalizeClock(input.latestTime)!;
  return { earliest, latest, label: windowLabel(earliest, latest)! };
}

/** Best-effort: the request is saved either way, and a window that did not
 *  land still reaches the office in the notification's words. */
export async function recordRequestedWindow(
  sb: any,
  orgId: string,
  ticketId: string,
  window: RequestedWindow,
): Promise<void> {
  const { error } = await sb
    .from("qc_tickets")
    .update({
      requested_earliest_time: window.earliest,
      requested_latest_time: window.latest,
    })
    .eq("id", ticketId)
    .eq("organization_id", orgId);
  if (error) console.error("walk request window was not recorded", ticketId, error.message);
}
