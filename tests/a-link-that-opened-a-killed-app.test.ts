// #621: a link that opened a killed app landed on the role page instead.
//
// Cold start boots at `/`, which redirects to /auth, whose landing effect
// sends a signed-in person to My Day or the dashboard. The tapped link
// (Android App Link, iPhone Live Activity link) arrived as appUrlOpen in the
// middle of that and was pushed at once, so it lost to the launch's own
// redirect. It is now held (src/lib/pending-deep-link.ts) and delivered when
// the router is idle, or by /auth at the moment it would have landed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  __resetDeepLinkForTests,
  DEEP_LINK_TTL_MS,
  forgetDeepLink,
  holdDeepLink,
  markLanded,
  needsSession,
  peekDeepLink,
  routeDeepLink,
  takeDeepLink,
  type DeepLinkEnv,
} from "@/lib/pending-deep-link";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function env(pathname: string, idle: () => Promise<void> = async () => {}) {
  const push = vi.fn();
  const e: DeepLinkEnv = { pathname: () => pathname, idle, push };
  return { e, push };
}

beforeEach(() => __resetDeepLinkForTests());

describe("routeDeepLink", () => {
  it("holds a staff link while the app is still on the launch screens", async () => {
    for (const at of ["/", "/auth"]) {
      __resetDeepLinkForTests();
      const { e, push } = env(at);
      await routeDeepLink("/my-day?visit=v1&action=start", e);
      expect(push).not.toHaveBeenCalled();
      expect(peekDeepLink()).toBe("/my-day?visit=v1&action=start");
    }
  });

  it("pushes it straight away when the app is already past sign-in", async () => {
    const { e, push } = env("/dashboard");
    await routeDeepLink("/clients/abc", e);
    expect(push).toHaveBeenCalledWith("/clients/abc");
    expect(peekDeepLink()).toBeNull();
  });

  it("pushes an invitation from /auth too: it needs no session", async () => {
    const { e, push } = env("/auth");
    await routeDeepLink("/invite/tok", e);
    expect(push).toHaveBeenCalledWith("/invite/tok");
    expect(peekDeepLink()).toBeNull();
  });

  it("waits for the router to settle before deciding", async () => {
    // Cold start: the event fires while `/` is still redirecting to /auth.
    let settle!: () => void;
    let at = "/";
    const push = vi.fn();
    const pending = routeDeepLink("/routes", {
      pathname: () => at,
      idle: () => new Promise<void>((r) => (settle = r)),
      push,
    });
    expect(peekDeepLink()).toBe("/routes");
    at = "/auth";
    settle();
    await pending;
    expect(push).not.toHaveBeenCalled();
    expect(peekDeepLink()).toBe("/routes");
  });

  it("does nothing more if /auth took the link while the router settled", async () => {
    let settle!: () => void;
    const push = vi.fn();
    const pending = routeDeepLink("/routes", {
      pathname: () => "/my-day",
      idle: () => new Promise<void>((r) => (settle = r)),
      push,
    });
    expect(takeDeepLink()).toBe("/routes");
    settle();
    await pending;
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the last tap, and ignores a bare open-the-app link", () => {
    holdDeepLink("/clients/a");
    holdDeepLink("/clients/b");
    holdDeepLink("/");
    expect(takeDeepLink()).toBe("/clients/b");
    expect(takeDeepLink()).toBeNull();
  });

  it("pushes a link that arrives after /auth has already landed", async () => {
    // land() has navigated, but the router still reads /auth: nobody is
    // left to take a held link.
    markLanded();
    const { e, push } = env("/auth");
    await routeDeepLink("/routes", e);
    expect(push).toHaveBeenCalledWith("/routes");
  });

  it("sign-out forgets the held link and the landing", async () => {
    markLanded();
    holdDeepLink("/clients/a");
    forgetDeepLink();
    expect(peekDeepLink()).toBeNull();
    const { e, push } = env("/auth");
    await routeDeepLink("/routes", e);
    expect(push).not.toHaveBeenCalled();
  });

  it("drops a link held longer than the TTL", () => {
    holdDeepLink("/clients/a", 1_000);
    expect(peekDeepLink(1_000 + DEEP_LINK_TTL_MS)).toBe("/clients/a");
    expect(takeDeepLink(1_000 + DEEP_LINK_TTL_MS + 1)).toBeNull();
  });

  it("only an invitation is a page that needs no session", () => {
    expect(needsSession("/invite/tok")).toBe(false);
    expect(needsSession("/my-day")).toBe(true);
    expect(needsSession("/invoices/1")).toBe(true);
  });
});

describe("the wiring", () => {
  it("the root listener holds the link instead of pushing it on arrival", () => {
    const src = read("src/routes/__root.tsx");
    expect(src).toMatch(/initAppLinks\(\(path\) => \{\s*void routeDeepLink\(path,/);
    expect(src).not.toMatch(/initAppLinks\(\(path\) => router\.history\.push\(path\)\)/);
  });

  it("every role landing on /auth goes through land(), which takes the held link", () => {
    const src = read("src/routes/auth.tsx");
    expect(src).toMatch(
      /const link = takeDeepLink\(\);\s*if \(link\) router\.history\.push\(link\);/,
    );
    // Three ways a session arrives: a cold start on either build (one path
    // since #661), password, native OAuth / Apple. Each lands through land().
    expect(
      src.match(/land\(await landingPathForUser\(|land\(to\)|land\(\s*data\.user \?/g)?.length,
    ).toBe(3);
    // And none still navigates to the role landing directly: the one
    // `navigate({ to })` left is land()'s own fallback.
    expect(src.match(/navigate\(\{ to \}\)/g)?.length).toBe(1);
  });

  it("an invitation link opens the app on Android", async () => {
    const { appLinkTarget } = await import("@/lib/android-app-links");
    expect(appLinkTarget("https://app.houndstack.com/invite/tok")).toBe("/invite/tok");
    expect(read("android/app/src/main/AndroidManifest.xml")).toContain(
      '<data android:pathPrefix="/invite" />',
    );
  });

  it("sign-out clears the held link, inside the app only", () => {
    const src = read("src/routes/__root.tsx");
    expect(src).toMatch(/if \(event === "SIGNED_OUT"\) forgetDeepLink\(\);/);
    expect(read("src/routes/auth.tsx")).toMatch(/markLanded\(\);\s*const link = takeDeepLink\(\);/);
  });
});

describe("an invitation link opens the iPhone app", () => {
  it("the entitlement names the domain", async () => {
    const { ASSOCIATED_DOMAIN } = await import("@/lib/ios-universal-links");
    const ent = read("ios/App/App/App.entitlements");
    expect(ent).toContain("<key>com.apple.developer.associated-domains</key>");
    expect(ent).toContain(`<string>${ASSOCIATED_DOMAIN}</string>`);
    expect(ASSOCIATED_DOMAIN).toBe("applinks:app.houndstack.com");
  });

  it("the association file names this app, and only /invite", async () => {
    const { appleAppSiteAssociationBody, APPLE_TEAM_ID, IOS_BUNDLE_ID } =
      await import("@/lib/ios-universal-links");
    const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain(`DEVELOPMENT_TEAM = ${APPLE_TEAM_ID};`);
    expect(pbx).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${IOS_BUNDLE_ID};`);
    const body = JSON.parse(appleAppSiteAssociationBody());
    expect(body).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["6NB6QXT2TU.consulting.thenorth.houndstack"],
            components: [{ "/": "/invite/*" }],
          },
        ],
      },
    });
  });

  it("every iOS path is one the app routes (appLinkTarget), and none is a customer page", async () => {
    const { UNIVERSAL_LINK_PATHS } = await import("@/lib/ios-universal-links");
    const { appLinkTarget, STAYS_IN_BROWSER } = await import("@/lib/android-app-links");
    for (const p of UNIVERSAL_LINK_PATHS) {
      const sample = p.replace("*", "tok");
      expect(appLinkTarget(`https://app.houndstack.com${sample}`), p).toBe(sample);
      for (const stays of Object.keys(STAYS_IN_BROWSER)) {
        expect(sample.startsWith(stays + "/") || sample === stays, `${p} vs ${stays}`).toBe(false);
      }
    }
  });

  it("is served at /.well-known/apple-app-site-association", () => {
    const route = read("src/routes/[.]well-known.apple-app-site-association.ts");
    expect(route).toContain('createFileRoute("/.well-known/apple-app-site-association")');
    expect(route).toContain('"Content-Type": "application/json"');
    expect(read("src/routeTree.gen.ts")).toContain(
      "path: '/.well-known/apple-app-site-association'",
    );
  });

  it("SceneDelegate hands a Universal Link to Capacitor on cold and warm launch", () => {
    const d = read("ios/App/App/SceneDelegate.swift");
    expect(d).toContain("for activity in connectionOptions.userActivities");
    expect(d).toContain("func scene(_ scene: UIScene, continue userActivity: NSUserActivity)");
    expect(d).toContain(
      "ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: userActivity",
    );
  });
});
