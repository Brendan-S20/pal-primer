// GET https://app.houndstack.com/.well-known/apple-app-site-association
//
// iOS Universal Links verification. Apple's CDN fetches this file when the
// app is installed and opens the listed https://app.houndstack.com links in
// the app instead of Safari. Which links, and why so few, is in
// src/lib/ios-universal-links.ts.
//
// Rules Apple applies to this response, all of which this meets: HTTPS, no
// redirect, Content-Type application/json, reachable without a cookie, and no
// file extension in the path.

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/.well-known/apple-app-site-association")({
  server: {
    handlers: {
      GET: async () => {
        const { appleAppSiteAssociationBody } = await import("@/lib/ios-universal-links");
        return new Response(appleAppSiteAssociationBody(), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
