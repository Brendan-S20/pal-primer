// The reads a Settings page draws from, started by its route rather than by
// its components (#786).
//
// WHAT WAS SLOW. Settings → Users measured 16.0 s to usable on live, Client
// portal 13.9 s. Neither page's own queries are expensive; what they did was
// queue. A route component is code-split, so on a navigation the router first
// downloads the page's chunk, THEN React mounts it, THEN each card's useQuery
// asks for its data -- and only then does each server function begin its own
// auth check and org lookup. Every step waited for the one before it.
//
// THE FIX. The route's loader starts the same queries, under the same keys,
// the moment the navigation starts: beside the chunk download rather than
// after it, and -- because the router preloads on intent -- on hover or
// touchstart of the Settings link, before the tap even lands. The components
// still call useQuery exactly as before; they find the request already in
// flight (or answered) and do not send a second one.
//
// What this deliberately does NOT do: wait. The loader returns nothing and
// awaits nothing, so a slow read can never hold the page back from drawing
// its own skeleton (CLAUDE.md, "Motion never makes a thumb wait"). And it asks
// only what the page itself would ask for that role, so a prefetch can never
// be a request the page would not have made.
//
// The keys here and the keys in the components must be the same strings, or
// this does nothing at all. tests/the-first-hour-does-not-wait-in-line.test.ts
// checks both sides.

import type { QueryClient } from "@tanstack/react-query";
import { listOrgInvites, listOrgUsers, listStaffAddresses } from "@/lib/users.functions";
import { getOrgBranding } from "@/lib/org.functions";
import { getPortalChangeSettings } from "@/lib/portal-change.functions";
import { getPortalBookingSettings } from "@/lib/portal-booking.functions";

/** Long enough that hovering the link twice does not ask twice; short enough
 *  that a page opened a minute later reads fresh. */
export const SETTINGS_PREFETCH_STALE_MS = 30_000;

export const USERS_PAGE_KEYS = {
  users: ["org-users"],
  staffAddresses: ["staff-addresses"],
  invites: ["org-invites"],
} as const;

export const CLIENT_PORTAL_PAGE_KEYS = {
  branding: ["org-branding"],
  changePolicy: ["portal-change-settings"],
  booking: ["portal-booking-settings"],
} as const;

function start(qc: QueryClient, queryKey: readonly string[], queryFn: () => Promise<unknown>) {
  // prefetchQuery never rejects; an error lands in the cache, where the
  // page's own useQuery retries it on mount like any other failed read.
  void qc.prefetchQuery({ queryKey, queryFn, staleTime: SETTINGS_PREFETCH_STALE_MS });
}

/** Settings → Users. The invite list is drawn for the owner alone (the panel
 *  is behind `canEdit`), so it is asked for the owner alone. */
export function prefetchUsersPage(qc: QueryClient, role: string | null | undefined): void {
  start(qc, USERS_PAGE_KEYS.users, () => listOrgUsers());
  start(qc, USERS_PAGE_KEYS.staffAddresses, () => listStaffAddresses());
  if (role === "owner") {
    start(qc, USERS_PAGE_KEYS.invites, () => listOrgInvites());
  }
}

/** Settings → Client portal. The portal address card reads ["my-org"], which
 *  the signed-in shell has already filled; the other three cards are here. */
export function prefetchClientPortalPage(qc: QueryClient): void {
  start(qc, CLIENT_PORTAL_PAGE_KEYS.branding, () => getOrgBranding());
  start(qc, CLIENT_PORTAL_PAGE_KEYS.changePolicy, () => getPortalChangeSettings());
  start(qc, CLIENT_PORTAL_PAGE_KEYS.booking, () => getPortalBookingSettings());
}
