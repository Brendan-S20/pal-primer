// The signed-in half of the calendar feed: make a link, replace it, turn it
// off, and the owner's access-code switch.
//
// Every write goes through a SECURITY DEFINER function that reads auth.uid()
// itself (calendar_feed_rotate / _revoke), so a caller can only ever touch
// their OWN link, and the scope check (a staff record for 'mine',
// view_client_directory for 'org') is made in the database, not only here.
// The table has no grant to any client role at all.
//
// The token is made here and shown ONCE. Only its hash reaches the database,
// so there is nothing to show again later: "Get a new link" is the way back.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";
import type { FeedScope } from "@/lib/calendar-feed";

export type CalendarFeedLinkState = {
  createdAt: string;
  lastFetchedAt: string | null;
} | null;

export type MyCalendarFeeds = {
  mine: CalendarFeedLinkState;
  org: CalendarFeedLinkState;
  /** Has an active staff record, so there are "my visits" to feed. */
  canMine: boolean;
  /** Holds view_client_directory, which is what seeing every visit needs. */
  canOrg: boolean;
  /** organizations.calendar_feed_access_codes. */
  accessCodesInFeed: boolean;
  /** May flip that switch (manage_settings). */
  canManageSettings: boolean;
};

const scopeSchema = z.object({ scope: z.enum(["mine", "org"]) });

export const getMyCalendarFeeds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyCalendarFeeds> => {
    const { supabase, userId } = context;
    const { orgId, role, overrides } = await resolveCaller(supabase, userId);
    const [{ data: rows, error }, { data: staff }, { data: org }] = await Promise.all([
      (supabase as any).rpc("calendar_feed_status"),
      supabase
        .from("staff")
        .select("id")
        .eq("user_id", userId)
        .eq("organization_id", orgId)
        .eq("active", true)
        .limit(1),
      (supabase.from("organizations") as any)
        .select("calendar_feed_access_codes")
        .eq("id", orgId)
        .maybeSingle(),
    ]);
    if (error) throw new Error(error.message);
    const pick = (s: FeedScope): CalendarFeedLinkState => {
      const r = ((rows ?? []) as Array<{
        scope: string;
        created_at: string;
        last_fetched_at: string | null;
      }>).find((x) => x.scope === s);
      return r ? { createdAt: r.created_at, lastFetchedAt: r.last_fetched_at } : null;
    };
    return {
      mine: pick("mine"),
      org: pick("org"),
      canMine: (staff ?? []).length > 0,
      canOrg: hasPermission(role, "view_client_directory", overrides),
      accessCodesInFeed: !!(org as { calendar_feed_access_codes?: boolean } | null)
        ?.calendar_feed_access_codes,
      canManageSettings: hasPermission(role, "manage_settings", overrides),
    };
  });

/** What the database says when it refuses, as a sentence a person can act on. */
function rotateRefusal(raw: string): string {
  if (/no_staff_record/.test(raw))
    return "You don't have an active staff record, so there are no visits assigned to you to put in a calendar.";
  if (/not_authorized/.test(raw))
    return "Only the owner, office managers and dispatchers can subscribe to every visit.";
  if (/no_organization/.test(raw)) return "Your account isn't part of a business yet.";
  return raw;
}

/** Make a link, or replace the existing one (which stops the old URL working
 *  on the calendar's next poll). Returns the URL, which is never stored. */
export const createCalendarFeedLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => scopeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { newFeedToken, hashFeedToken } = await import("@/lib/calendar-feed.server");
    const { feedPath } = await import("@/lib/calendar-feed");
    const { appUrl } = await import("@/lib/app-origin");
    const token = newFeedToken();
    const { data: createdAt, error } = await (context.supabase as any).rpc(
      "calendar_feed_rotate",
      { _scope: data.scope, _token_hash: hashFeedToken(token) },
    );
    if (error) throw new Error(rotateRefusal(error.message));
    // appUrl, never the page's own origin: this URL is pasted into Google,
    // which will poll it from the public internet for months.
    return { url: appUrl(feedPath(token)), createdAt: createdAt as string };
  });

export const revokeCalendarFeedLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => scopeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: removed, error } = await (context.supabase as any).rpc("calendar_feed_revoke", {
      _scope: data.scope,
    });
    if (error) throw new Error(error.message);
    return { removed: !!removed };
  });

/** The owner's decision about access codes in technicians' own feeds. */
export const setCalendarFeedAccessCodes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, { calendar_feed_access_codes: data.enabled });
    return { ok: true, accessCodesInFeed: data.enabled };
  });
