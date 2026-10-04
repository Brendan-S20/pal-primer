// Android App Links: which https://app.houndstack.com links open the app.
//
// The claim lives in two places that cannot import each other: the intent
// filter in AndroidManifest.xml, which is what Android obeys, and
// src/lib/android-app-links.ts, which is what the app, assetlinks.json and
// this test read. This file holds them together, and holds both against
// src/routes so that a new page is a decision rather than a default.
//
// The failure each block guards against is silent on a device:
//   * a manifest that claims /auth breaks WEB sign-in for anyone with the app
//     (the OAuth redirect lands in the app, mid-flow);
//   * one that claims /pay or /portal sends a customer's link into an app the
//     customer does not have, or an owner checking it into the wrong screen;
//   * one that claims /settings/billing opens a "managed outside the app"
//     page from an email whose only purpose was to get billing updated;
//   * an assetlinks.json served with a placeholder fingerprint fails Android's
//     verification while looking, in a browser, like it works.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ANDROID_PACKAGE_NAME,
  APP_LINK_EXACT_PATHS,
  APP_LINK_HOST,
  APP_LINK_PATH_PREFIXES,
  STAYS_IN_BROWSER,
  appLinkClaims,
  appLinkTarget,
  assetLinksBody,
  isRealFingerprint,
  publishedFingerprints,
} from "@/lib/android-app-links";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The App Link intent filter, i.e. the one with autoVerify. */
function appLinkFilter(): string {
  const manifest = read("android/app/src/main/AndroidManifest.xml").replace(/<!--[\s\S]*?-->/g, "");
  const filters = [...manifest.matchAll(/<intent-filter\b[^>]*>[\s\S]*?<\/intent-filter>/g)].map(
    (m) => m[0],
  );
  const verified = filters.filter((f) => /android:autoVerify="true"/.test(f));
  expect(verified, "exactly one autoVerify intent filter").toHaveLength(1);
  return verified[0];
}

const attrValues = (xml: string, attr: string) =>
  [...xml.matchAll(new RegExp(`android:${attr}="([^"]*)"`, "g"))].map((m) => m[1]).sort();

describe("the manifest claims exactly what android-app-links.ts says", () => {
  it("is a verified https VIEW filter for the app host", () => {
    const f = appLinkFilter();
    expect(f).toContain('android:name="android.intent.action.VIEW"');
    expect(f).toContain('android:name="android.intent.category.DEFAULT"');
    expect(f).toContain('android:name="android.intent.category.BROWSABLE"');
    expect(attrValues(f, "scheme")).toEqual(["https"]);
    expect(attrValues(f, "host")).toEqual([APP_LINK_HOST]);
  });

  it("lists the same exact paths and prefixes, no more and no fewer", () => {
    const f = appLinkFilter();
    expect(attrValues(f, "path")).toEqual([...APP_LINK_EXACT_PATHS].sort());
    expect(attrValues(f, "pathPrefix")).toEqual([...APP_LINK_PATH_PREFIXES].sort());
    // A pattern would bypass the review this list is built for.
    expect(attrValues(f, "pathPattern")).toEqual([]);
    expect(attrValues(f, "pathAdvancedPattern")).toEqual([]);
  });

  it("names the package capacitor.config.ts builds", () => {
    expect(read("capacitor.config.ts")).toContain(`appId: "${ANDROID_PACKAGE_NAME}"`);
    expect(read("android/app/build.gradle")).toContain(`applicationId "${ANDROID_PACKAGE_NAME}"`);
  });
});

describe("customer links, purchases and sign-in stay in the browser", () => {
  it.each([
    "/auth",
    "/pay/i/tok",
    "/portal/acme/tok",
    "/portal/acme/tok/pay/inv",
    "/q/tok",
    "/track/tok",
    "/lead/acme",
    "/signup/acme",
    "/sign-up",
    "/get-started",
    "/invite/tok",
    "/reset-password",
    "/unsubscribe",
    "/legal/privacy",
    "/billing",
    "/settings/billing",
    "/settings/addons",
    "/platform",
    "/api/public/invoice-pdf",
    "/.well-known/assetlinks.json",
  ])("%s is not claimed", (path) => {
    expect(appLinkClaims(path)).toBe(false);
  });

  it.each(["/", "/my-day", "/routes", "/clients/abc", "/settings", "/settings/users", "/dashboard"])(
    "%s is claimed",
    (path) => expect(appLinkClaims(path)).toBe(true),
  );

  it("does not let a claimed prefix swallow a browser path by spelling", () => {
    // pathPrefix is a raw string prefix on Android. "/lead" would claim
    // "/leads" (staff) AND "/lead/acme" (public form); only "/leads" may be
    // here. Same shape for every pair.
    for (const stays of Object.keys(STAYS_IN_BROWSER)) {
      for (const p of APP_LINK_PATH_PREFIXES) {
        expect(stays.startsWith(p), `${p} would claim ${stays}`).toBe(false);
      }
    }
  });
});

describe("every route is in the claim or in the browser list", () => {
  const routes = () => readdirSync(join(root, "src/routes"));

  /** First URL segment of a flat-route filename: "portal.$slug.tsx" -> "/portal". */
  const firstSegment = (f: string) =>
    "/" +
    f
      .replace(/\.(tsx|ts)$/, "")
      .replace(/\[\.\]/g, "\u0000")
      .split(".")[0]
      .replace(/\u0000/g, ".");

  it("covers every public top-level path", () => {
    const tops = routes()
      .filter((f) => /\.(tsx|ts)$/.test(f) && !f.startsWith("__"))
      .map(firstSegment)
      .filter((p) => p !== "/index");
    // Directories are path segments too (api/, email/).
    const dirs = routes()
      .filter((f) => !/\.\w+$/.test(f) && !f.startsWith("_"))
      .map((d) => `/${d}`);
    expect(tops.length, "found the route files at all").toBeGreaterThan(20);
    const unplaced = [...new Set([...tops, ...dirs])].filter(
      (p) =>
        !(p in STAYS_IN_BROWSER) &&
        !appLinkClaims(p) &&
        // The verification file itself is neither: it is fetched by Android.
        p !== "/.well-known",
    );
    expect(unplaced, "add each to APP_LINK_* or STAYS_IN_BROWSER, with a reason").toEqual([]);
  });

  it("covers every staff page, settings page by page", () => {
    const staff = readdirSync(join(root, "src/routes/_authenticated")).filter((f) =>
      f.endsWith(".tsx"),
    );
    expect(staff.length, "found the staff routes at all").toBeGreaterThan(30);
    const unplaced: string[] = [];
    for (const f of staff) {
      const parts = f.replace(/\.tsx$/, "").split(".");
      if (parts[0] === "route") continue; // the layout, not a path
      const path =
        parts[0] === "settings" && parts[1] && parts[1] !== "index"
          ? `/settings/${parts[1]}`
          : `/${parts[0]}`;
      if (!(path in STAYS_IN_BROWSER) && !appLinkClaims(path)) unplaced.push(path);
    }
    expect([...new Set(unplaced)], "add each to APP_LINK_* or STAYS_IN_BROWSER").toEqual([]);
  });
});

describe("a tapped link becomes an in-app path", () => {
  it("keeps the query and hash", () => {
    expect(appLinkTarget("https://app.houndstack.com/my-day?date=2026-10-03#v1")).toBe(
      "/my-day?date=2026-10-03#v1",
    );
  });

  it.each([
    "consulting.thenorth.houndstack://auth-callback#access_token=x",
    "http://app.houndstack.com/my-day",
    "https://houndstack.com/my-day",
    "https://app.houndstack.com.evil.example/my-day",
    "https://app.houndstack.com/pay/i/tok",
    "not a url",
  ])("ignores %s", (url) => expect(appLinkTarget(url)).toBeNull());
});

describe("assetlinks.json refuses to publish a placeholder", () => {
  const real = Array.from({ length: 32 }, (_, i) =>
    (i * 7 + 16).toString(16).toUpperCase().padStart(2, "0"),
  ).join(":");

  it("serves nothing until a real SHA-256 is configured", () => {
    expect(assetLinksBody(undefined)).toBeNull();
    expect(assetLinksBody("")).toBeNull();
    expect(assetLinksBody("REPLACE_WITH_PLAY_APP_SIGNING_SHA256")).toBeNull();
    expect(assetLinksBody(Array(32).fill("00").join(":"))).toBeNull();
    // SHA-1 sits next to SHA-256 on the same console page, and is the wrong one.
    expect(assetLinksBody(Array(20).fill("AB").join(":"))).toBeNull();
  });

  it("ships no fingerprint in the repo until the owner adds Play's", () => {
    // If this fails, someone pasted one in: check it is the APP SIGNING key
    // certificate from Play Console, not the upload key alone, then update
    // this expectation.
    expect(publishedFingerprints(undefined)).toEqual([]);
  });

  it("publishes the package and the fingerprint, in Android's shape", () => {
    expect(isRealFingerprint(real)).toBe(true);
    expect(isRealFingerprint(real.toLowerCase())).toBe(true);
    const body = assetLinksBody(` ${real.toLowerCase()} , junk, ${real}`);
    expect(body).not.toBeNull();
    expect(JSON.parse(body!)).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: ANDROID_PACKAGE_NAME,
          sha256_cert_fingerprints: [real],
        },
      },
    ]);
  });

  it("is served from the path Android fetches", () => {
    const route = read("src/routes/[.]well-known.assetlinks[.]json.ts");
    expect(route).toContain('createFileRoute("/.well-known/assetlinks.json")');
    expect(route).toContain('"Content-Type": "application/json"');
    expect(read("src/routeTree.gen.ts")).toContain("path: '/.well-known/assetlinks.json'");
  });
});
