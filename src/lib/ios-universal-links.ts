// Which https://app.houndstack.com links open the iPhone app, and the file
// that lets iOS believe us.
//
// iOS opens a Universal Link in the app only when the app's entitlement
// (ios/App/App/App.entitlements, com.apple.developer.associated-domains)
// names the domain AND the domain serves /.well-known/apple-app-site-association
// naming the app. Apple's CDN fetches that file on install and caches it, so a
// change here reaches a phone on its next install or CDN refresh, not at once.
//
// The list is deliberately short. Today it is the team invitation only
// (#621): a tech who already installed the app accepts there. Everything else
// on the Android list stays in Safari on iOS until someone decides it should
// not; the Live Activity uses the app's own URL scheme instead
// (src/lib/live-activity-links.ts). Customer pages (/portal, /pay, ...) are
// never listed, for the reasons src/lib/android-app-links.ts gives.
//
// A path here must also be claimed by android-app-links.ts, because the app
// routes every https link through appLinkTarget there, whichever OS opened it.
// tests/a-link-that-opened-a-killed-app.test.ts checks that.

import { APP_LINK_HOST } from "@/lib/android-app-links";

/** The Apple Developer team that signs the app (project.pbxproj DEVELOPMENT_TEAM). */
export const APPLE_TEAM_ID = "6NB6QXT2TU";

/** The app's bundle id (project.pbxproj PRODUCT_BUNDLE_IDENTIFIER). */
export const IOS_BUNDLE_ID = "consulting.thenorth.houndstack";

/** What the entitlement names. */
export const ASSOCIATED_DOMAIN = `applinks:${APP_LINK_HOST}`;

/** Path patterns that open the app (AASA `components`, `*` matches anything). */
export const UNIVERSAL_LINK_PATHS: readonly string[] = ["/invite/*"];

/** The apple-app-site-association body. */
export function appleAppSiteAssociationBody(): string {
  return JSON.stringify(
    {
      applinks: {
        details: [
          {
            appIDs: [`${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`],
            components: UNIVERSAL_LINK_PATHS.map((p) => ({ "/": p })),
          },
        ],
      },
    },
    null,
    2,
  );
}
