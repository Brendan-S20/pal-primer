// Which https://app.houndstack.com links open the Android app, and the file
// that lets Android believe us.
//
// ── THE LINE ──────────────────────────────────────────────────────────────
//
// An App Link is not a preference the user picks. Once Android has verified
// the domain, a tap on a matching URL opens the app for EVERYONE who has it
// installed, from an email, a text or a chat, with no chooser. So the
// question for each path is not "could the app show this" but "is the person
// tapping this link always better off in the app".
//
// Staff pages: yes. A technician tapping "your route for tomorrow" in an
// email wants My Day, already signed in, not a browser sign-in form.
//
// Everything a CUSTOMER is sent stays in the browser: /pay, /portal, /q
// (quotes), /track, /lead, /signup, /unsubscribe. Those people do not have
// this app, but staff test their own links, and an owner who taps a
// customer's pay link to check it should see what the customer sees.
//
// So does everything that BUYS HoundStack: /billing, /settings/billing and
// /settings/addons. The binary hides those purchase flows by store rule (see
// src/lib/app-store-billing.ts), so a "your trial ends, update billing" email
// that opened the app would land the owner on a page that says billing is
// managed elsewhere, with no way to do the thing the email asked. The browser
// can.
//
// And /auth stays in the browser for a reason that has nothing to do with
// taste: it is the WEB OAuth redirect target. Claim it and a staff member
// signing in on the website with Google, on a phone that has the app, is
// handed to the app halfway through the web flow and lands nowhere.
//
// Android before 15 cannot EXCLUDE a path inside a claimed prefix, so the
// claim is written as an allowlist: whole top-level sections where every page
// is staff-only, and Settings page by page so Billing and Add-ons can be left
// out. android/app/src/main/AndroidManifest.xml carries the same list, and
// tests/an-android-link-opens-the-app-only-where-it-should.test.ts fails if
// the two differ, or if a route is added that is in neither this list nor the
// browser list below.

/** The applicationId (capacitor.config.ts `appId`). assetlinks.json names it. */
export const ANDROID_PACKAGE_NAME = "consulting.thenorth.houndstack";

/** The host the intent filter claims. */
export const APP_LINK_HOST = "app.houndstack.com";

/** Matched exactly (`android:path`). */
export const APP_LINK_EXACT_PATHS: readonly string[] = ["/", "/settings"];

/** Matched as prefixes (`android:pathPrefix`). Every page under each is
 *  staff-only and none of them sells HoundStack. */
export const APP_LINK_PATH_PREFIXES: readonly string[] = [
  "/ai-tools",
  "/analytics",
  "/campaigns",
  "/clients",
  "/concerns",
  "/dashboard",
  "/disputes",
  "/dna",
  "/expenses",
  "/franchise",
  "/help",
  "/imports",
  "/inbox",
  "/inventory",
  // A team invitation. Opens the app so a new tech who already installed it
  // accepts there and is signed in where they will work. /invite/$token
  // handles a missing session itself (#621).
  "/invite",
  "/invoices",
  "/leads",
  "/messages",
  "/my-day",
  "/my-schedule",
  "/neighbors",
  "/notifications",
  "/onboarding",
  "/payments",
  "/pricing-drift",
  "/profile",
  "/properties",
  "/quotes",
  "/reports",
  "/review",
  "/routes",
  // The guided setup. An owner's page: it sets the business up and sells
  // nothing, so a link to it from a "finish setting up" email opens the app.
  "/setup",
  "/tax-reports",
  "/timesheets",
  "/training-packages",
  "/waste-log",
  "/zones",
  // Settings, page by page, without billing and addons.
  "/settings/accounting",
  "/settings/ai",
  "/settings/automation",
  "/settings/blackouts",
  "/settings/business",
  "/settings/client-portal",
  "/settings/deep-clean",
  "/settings/directory",
  "/settings/emails",
  "/settings/franchise",
  "/settings/invoicing",
  "/settings/lead-form",
  "/settings/online-signup",
  "/settings/payments",
  "/settings/preferences",
  "/settings/promotions",
  "/settings/referrals",
  "/settings/reviews",
  "/settings/roles",
  "/settings/scheduling",
  "/settings/services",
  "/settings/skip-rules",
  "/settings/sms",
  "/settings/users",
  "/settings/webhooks",
];

/**
 * Top-level paths, and settings pages, that a link must NOT open in the app,
 * each with its reason. The test requires every route in src/routes to be in
 * the claim above or in here, so a new page is a decision rather than a
 * default.
 */
export const STAYS_IN_BROWSER: Readonly<Record<string, string>> = {
  "/auth":
    "the web OAuth redirect target; claiming it breaks web sign-in on any phone with the app",
  "/sign-up": "account creation starts on the web",
  "/signup": "a tenant's customer self-signup page",
  "/get-started": "account creation starts on the web",
  "/two-step": "part of the web sign-in flow",
  "/reset-password": "the recovery session lands in the browser that asked for it",
  "/no-workspace": "part of the web sign-in flow",
  "/access-off": "where the app sends a person whose access was turned off; never a shared link",
  "/pay": "a customer's invoice payment link",
  "/portal": "the customer portal",
  "/q": "a customer's quote acceptance link",
  "/track": "a customer's live arrival tracker",
  "/lead": "a tenant's public lead form",
  "/pros": "HoundStack's public directory of pet pros, for pet owners who do not have the app",
  "/unsubscribe": "a customer's email preference link",
  "/legal": "public policy pages, linked from store listings",
  "/email": "server endpoints for email",
  "/api": "server endpoints",
  "/admin": "operator console",
  "/impersonate": "operator support tooling",
  "/platform": "operator console, desktop work",
  "/billing": "buys HoundStack; the app hides that purchase by store rule",
  "/settings/billing": "buys HoundStack; the app hides that purchase by store rule",
  "/settings/addons": "buys HoundStack add-ons; the app hides that purchase by store rule",
};

/** Does Android open this path in the app (given a verified domain)? */
export function appLinkClaims(pathname: string): boolean {
  if (APP_LINK_EXACT_PATHS.includes(pathname)) return true;
  // pathPrefix is a plain string prefix on Android, so this is too: it is
  // what the OS does, not what a router would do.
  return APP_LINK_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * The in-app path for a URL Android handed the app, or null when it is not
 * one of ours. Same-host https only: the custom-scheme OAuth hand-back
 * (consulting.thenorth.houndstack://auth-callback) is handled by
 * src/routes/auth.tsx and must not be routed here.
 */
export function appLinkTarget(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== APP_LINK_HOST) return null;
  if (!appLinkClaims(u.pathname)) return null;
  return u.pathname + u.search + u.hash;
}

// ── /.well-known/assetlinks.json ─────────────────────────────────────────
//
// Android verifies the claim by fetching this file and checking that it names
// the package AND the SHA-256 of the certificate the installed app was signed
// with. With Play App Signing that is GOOGLE'S app signing key, not the
// upload key in android/keystore.properties: Play Console > Test and release >
// App integrity > App signing > "App signing key certificate" > SHA-256.
// Add the upload key's fingerprint as well if you install release builds that
// did not come from Play (sideloaded, or `bundletool` from a local .aab).
//
// The fingerprint is not a secret; it is printed on every installed APK.
// Paste it below, or set ANDROID_CERT_SHA256 (comma-separated) in the
// deployment's environment. Until one of those holds a REAL fingerprint the
// route answers 404, on purpose: a file that verifies against a placeholder
// fails every check anyway, and a 404 is unmistakable in the Play Console's
// deep-link report where a malformed 200 reads as "almost working".

/** The SHA-256 certificate fingerprints, uppercase hex with colons. Read
 *  from Play Console on 2026-10-07, the day the first bundle was uploaded. */
export const ANDROID_CERT_SHA256_FINGERPRINTS: readonly string[] = [
  // Google's app signing key (Play App Signing): every install from Play.
  "C1:FA:C5:F8:DA:69:E4:B6:F8:DA:E2:19:10:F8:0C:27:EA:78:6A:54:5E:B5:7D:5B:77:ED:BD:50:0B:3B:19:CC",
  // The upload key (~/keys/houndstack-upload.jks on the owner's Mac): a release
  // build installed without Play, e.g. bundletool from a local .aab. Also what
  // `keytool -printcert -jarfile app-release.aab` prints for a fresh bundle.
  "DF:73:23:9B:DF:4A:4A:A3:3D:79:D3:33:22:E8:4C:DC:39:CD:21:76:2E:FC:42:B2:B5:90:99:0F:EC:52:21:F1",
];

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** True only for a real-looking SHA-256 fingerprint. Rejects placeholders,
 *  SHA-1 (20 bytes, the other number on the same console page) and an
 *  all-zero value, which is what a template tends to ship with. */
export function isRealFingerprint(value: string): boolean {
  const v = value.trim().toUpperCase();
  return FINGERPRINT.test(v) && !/^(00:){31}00$/.test(v);
}

/** The fingerprints to publish: the constant above plus the env override,
 *  deduplicated, invalid ones dropped. */
export function publishedFingerprints(envValue: string | undefined): string[] {
  const fromEnv = (envValue ?? "").split(",").map((s) => s.trim());
  const all = [...ANDROID_CERT_SHA256_FINGERPRINTS, ...fromEnv]
    .map((s) => s.trim().toUpperCase())
    .filter(isRealFingerprint);
  return [...new Set(all)];
}

/** The assetlinks.json body, or null when there is nothing real to publish. */
export function assetLinksBody(envValue: string | undefined): string | null {
  const fingerprints = publishedFingerprints(envValue);
  if (fingerprints.length === 0) return null;
  return JSON.stringify(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: ANDROID_PACKAGE_NAME,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ],
    null,
    2,
  );
}
