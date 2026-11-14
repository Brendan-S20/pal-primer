// POST https://app.houndstack.com/api/public/directory/quotes
//
// The directory quote, for the standalone directory app (DIRECTORY_BRAND in lib/directory-site.ts,
// #630). The same handler as /api/public/leads -- the same honeypot, time
// check, rate limit, published-profile lookup and write -- with two
// differences:
//
//   * it takes a directory quote only (a body with `directory_slug`); a
//     tenant's lead form keeps posting to /api/public/leads;
//   * CORS answers only the directory app's origins (lib/directory-quote-cors.ts),
//     echoing the Origin rather than `*`. A browser request from any other
//     page is refused before the body is read. A caller with no Origin (not a
//     browser) is let through to the same server-side checks as every lead.
//
// /api/public/leads stays `*`: narrowing it would break every tenant website
// that embeds the lead form.
import { createFileRoute } from "@tanstack/react-router";
import { CALM_REFUSAL } from "@/lib/public-form-guard";
import { directoryQuoteCors, isDirectoryAppOrigin } from "@/lib/directory-quote-cors";

export const Route = createFileRoute("/api/public/directory/quotes")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const origin = request.headers.get("Origin");
        return new Response(null, {
          status: isDirectoryAppOrigin(origin) ? 204 : 403,
          headers: directoryQuoteCors(origin),
        });
      },
      POST: async ({ request }) => {
        const origin = request.headers.get("Origin");
        const cors = directoryQuoteCors(origin);
        if (origin && !isDirectoryAppOrigin(origin)) {
          return new Response(JSON.stringify({ error: CALM_REFUSAL }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...cors },
          });
        }
        const { handlePublicLeadPost } = await import("../leads");
        return handlePublicLeadPost(request, { cors, directoryOnly: true });
      },
    },
  },
});
