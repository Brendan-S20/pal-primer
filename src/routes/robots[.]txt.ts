// GET https://app.houndstack.com/robots.txt
//
// Issue #1023. This used to fall through to the SPA's 404 page: HTML, status
// 404. The app is behind sign-in and every public page lives on
// www.houndstack.com, so crawlers are told to stay out.

import { createFileRoute } from "@tanstack/react-router";
import { ROBOTS_TXT } from "@/lib/security-headers";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(ROBOTS_TXT, {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
