// GET https://app.houndstack.com/.well-known/assetlinks.json
//
// Android App Links verification. When the app is installed, Android fetches
// this file and opens https://app.houndstack.com staff links in the app only
// if it names the package and the SHA-256 of the certificate the app was
// signed with. Everything about WHICH links, and WHERE the fingerprint comes
// from, is in src/lib/android-app-links.ts.
//
// A route rather than a file in public/, for one reason: a static file cannot
// refuse to serve a placeholder. Until a real fingerprint is configured this
// answers 404, which Play Console's deep-link checker reports as "file not
// found" rather than as a 200 that looks nearly right.
//
// Rules Android applies to this response, all of which this meets: HTTPS, no
// redirect, Content-Type application/json, and reachable without a cookie.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/.well-known/assetlinks.json")({
  server: {
    handlers: {
      GET: async () => {
        const { assetLinksBody } = await import("@/lib/android-app-links");
        const body = assetLinksBody(process.env.ANDROID_CERT_SHA256);
        if (!body) {
          return new Response("Not configured\n", {
            status: 404,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            // Android re-verifies on install and periodically; an hour keeps a
            // corrected fingerprint from being stuck behind a long cache.
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
