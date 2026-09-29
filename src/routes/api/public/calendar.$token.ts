// GET https://app.houndstack.com/api/public/calendar/<token>.ics
//
// A subscribable iCalendar feed of visits: a technician's own, or the whole
// organization's. Polled by Google, Apple and Outlook from their own servers,
// with no cookie and no header we control, so the token in the path is the
// only credential.
//
// What this route does with it, in order:
//   1. Refuse anything that is not the shape of a token (43 base64url chars,
//      optionally followed by `.ics`) without touching the database.
//   2. Hash it. Only hashes are stored (calendar_feeds.token_hash), so the
//      lookup is an index probe on a digest; see calendar-feed.server.ts.
//   3. Ask calendar_feed_events, service_role only, which returns NULL for an
//      unknown or rotated hash AND for a link whose owner has since lost the
//      right to it. Every refusal is the same 404 with the same body, so the
//      response says nothing about which of those it was.
//   4. Build the .ics from what came back (src/lib/calendar-feed.ts), with
//      access codes only where the SQL chose to send them.

import { createFileRoute } from "@tanstack/react-router";

const notFound = () =>
  new Response("Not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

export const Route = createFileRoute("/api/public/calendar/$token")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { tokenFromPathSegment, buildFeedCalendar } = await import("@/lib/calendar-feed");
        const token = tokenFromPathSegment(params.token);
        if (!token) return notFound();

        const { hashFeedToken } = await import("@/lib/calendar-feed.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await (supabaseAdmin as any).rpc("calendar_feed_events", {
          _token_hash: hashFeedToken(token),
        });
        if (error) {
          console.error("calendar feed lookup failed", error.message);
          return new Response("Calendar temporarily unavailable\n", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300" },
          });
        }
        if (!data) return notFound();

        const body = buildFeedCalendar(data);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": 'inline; filename="houndstack.ics"',
            // Personal data behind a bearer URL: no shared cache may keep it,
            // or a rotated link would keep serving from somebody's proxy.
            "Cache-Control": "private, no-store, max-age=0",
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "no-referrer",
          },
        });
      },
    },
  },
});
