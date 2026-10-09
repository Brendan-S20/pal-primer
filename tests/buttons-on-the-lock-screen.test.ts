// Buttons on the route's Live Activity: Navigate, and Start or Complete.
//
// The owner asked (2026-10-07) "can we add actions to the live
// notifications?". What this file pins, without a phone:
//
//   1. the content state carries what the buttons need -- the stop's visit
//      id, where to navigate to, which of My Day's buttons the stop needs,
//      and the labels in the tech's language -- and nothing about the
//      customer; and "skip unchanged state" still skips;
//   2. a state written before the buttons existed still decodes: the Swift
//      decoder reads every new key as optional, so a build-261 state, or one
//      the server saved in last_state, draws the card without buttons;
//   3. the links back into the app: only consulting.thenorth.houndstack://
//      open/my-day, rebuilt from validated parts, with `action` on an
//      allowlist; anything else, and every foreign origin, is refused;
//   4. the widget side: Navigate and Complete are plain Links, and nothing
//      runs in the extension (no network, no session); Start is an App
//      Intent since 2026-10-08, which runs in the APP, and is pinned in
//      tests/the-lock-screen-starts-the-stop.test.ts; all behind iOS 17,
//      44pt tall, built from the same scheme and host the JS accepts, and
//      Navigate opening the URL My Day's own Navigate opens;
//   5. My Day takes the tech to Start and does not press it (the lock screen
//      could not start it, so the app opened); Complete opens the stop's
//      photo capture, through the card.
//
// What it cannot: that iOS draws and opens them. The simulator screenshots
// in the PR do that.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const listeners: Record<string, (e: any) => void> = {};
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
  registerPlugin: () => ({}),
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (name: string, fn: (e: any) => void) => {
      listeners[name] = fn;
      return { remove: vi.fn(async () => delete listeners[name]) };
    }),
  },
}));

import i18n from "@/lib/i18n";
import {
  buildRouteActivityState,
  routeChangePriority,
  stopDestination,
  type RouteActivityState,
  type RouteActivityVisit,
} from "@/lib/live-activity-state";
import {
  APP_URL_SCHEME,
  LIVE_ACTIVITY_ACTIONS,
  LIVE_ACTIVITY_LINK_HOST,
  LIVE_ACTIVITY_LINK_PATH,
  isLiveActivityAction,
  liveActivityLinkTarget,
} from "@/lib/live-activity-links";
import { findActionButton } from "@/components/my-day/use-live-activity-action";

const ctx = (lang: string) => ({
  t: i18n.getFixedT(lang) as unknown as (k: string, o?: Record<string, unknown>) => string,
  tz: "America/Chicago",
  rtl: lang === "ar",
});

const V1 = "0f8c2a51-6d3e-4b7a-9c1d-2e5f8a9b0c4d";
const V2 = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function route(): RouteActivityVisit[] {
  return [
    {
      id: "done-1",
      status: "completed",
      properties: { street: "1 Oak Ave", city: "Springfield", postal_code: "62704" },
    },
    {
      id: V1,
      status: "scheduled",
      clients: { display_name: "Jane Doe", primary_phone: "555-0100" },
      properties: {
        street: "412 Elm St",
        city: "Springfield",
        postal_code: "62704",
        latitude: 39.7817,
        longitude: -89.6501,
      },
    } as RouteActivityVisit,
    {
      id: V2,
      status: "scheduled",
      properties: { street: "88 Birch Ave", city: "Springfield", postal_code: "62701" },
    },
  ];
}

// ── 1. the content state ──────────────────────────────────────────────────

describe("the state carries what the buttons need", () => {
  it("a stop not started: Navigate to its coordinates, and Start", () => {
    const s = buildRouteActivityState(route(), ctx("en"));
    expect(s).toMatchObject({
      visitId: V1,
      destLat: 39.7817,
      destLng: -89.6501,
      // Coordinates are exact; the address is sent only when there are none.
      destAddress: null,
      nextAction: "start",
      navigateLabel: "Navigate",
      actionLabel: "Start",
    } satisfies Partial<RouteActivityState>);
  });

  it("a stop under way: Complete", () => {
    const v = route();
    v[1].status = "in_progress";
    const s = buildRouteActivityState(v, ctx("en"));
    expect(s.visitId).toBe(V1);
    expect(s.nextAction).toBe("complete");
    expect(s.actionLabel).toBe("Complete");
  });

  it("no coordinates: Navigate goes by the address My Day's own button uses", () => {
    const v = route();
    v[1].status = "completed";
    const s = buildRouteActivityState(v, ctx("en"));
    expect(s.visitId).toBe(V2);
    expect([s.destLat, s.destLng, s.destAddress]).toEqual([null, null, "88 Birch Ave, Springfield, 62701"]);
    expect(s.navigateLabel).toBe("Navigate");
  });

  it.each([
    ["no coordinates", { latitude: null, longitude: null }],
    ["0,0, which is a geocoder's shrug", { latitude: 0, longitude: 0 }],
    ["out of range", { latitude: 123, longitude: -89 }],
  ])("%s falls back to the address", (_why, coords) => {
    const d = stopDestination({
      id: "x",
      status: "scheduled",
      properties: { street: "9 Oak", city: "Peoria", postal_code: "61602", ...coords },
    });
    expect(d).toEqual({ lat: null, lng: null, address: "9 Oak, Peoria, 61602" });
  });

  it("nowhere to go: no Navigate, and Start still there", () => {
    const s = buildRouteActivityState([{ id: V1, status: "scheduled", properties: null }], ctx("en"));
    expect(s.navigateLabel).toBeNull();
    expect([s.destLat, s.destLng, s.destAddress]).toEqual([null, null, null]);
    expect(s.nextAction).toBe("start");
  });

  it("a finished route has no buttons at all", () => {
    const v = route().map((x) => ({ ...x, status: "completed" }));
    const s = buildRouteActivityState(v, ctx("en"));
    expect(s.allDone).toBe(true);
    expect([
      s.visitId,
      s.destLat,
      s.destLng,
      s.destAddress,
      s.nextAction,
      s.navigateLabel,
      s.actionLabel,
    ]).toEqual([null, null, null, null, null, null, null]);
  });

  it("labels are in the tech's language, the same words as My Day's buttons", () => {
    for (const lang of ["en", "es", "ar", "zh"]) {
      const t = i18n.getFixedT(lang);
      const start = buildRouteActivityState(route(), ctx(lang));
      expect(start.navigateLabel).toBe(t("visit.navigate"));
      expect(start.actionLabel).toBe(t("myDay.start"));
      const v = route();
      v[1].status = "in_progress";
      expect(buildRouteActivityState(v, ctx(lang)).actionLabel).toBe(t("myDay.complete"));
    }
    expect(buildRouteActivityState(route(), ctx("es")).actionLabel).toBe("Iniciar");
    expect(buildRouteActivityState(route(), ctx("ar")).navigateLabel).toBe("ملاحة");
  });

  it("says nothing about the customer", () => {
    const json = JSON.stringify(buildRouteActivityState(route(), ctx("en")));
    expect(json).not.toMatch(/Jane|555-0100/);
  });

  it("every field is a plain value, so an unchanged route is still not pushed again", () => {
    const s = buildRouteActivityState(route(), ctx("en"));
    for (const [k, v] of Object.entries(s)) {
      expect(v === null || typeof v !== "object", `${k} is an object`).toBe(true);
    }
    // What the server reads back from live_activity_tokens.last_state is JSON.
    const fromDb = JSON.parse(JSON.stringify(s)) as RouteActivityState;
    expect(routeChangePriority(fromDb, buildRouteActivityState(route(), ctx("en")))).toBeNull();
    // A different stop is still a priority-10 change.
    const v = route();
    v[1].status = "completed";
    expect(routeChangePriority(fromDb, buildRouteActivityState(v, ctx("en")))).toBe(10);
  });

  it("a last_state saved before the buttons existed is sent over once, then left alone", () => {
    const now = buildRouteActivityState(route(), ctx("en"));
    const old = Object.fromEntries(
      Object.entries(now).filter(([k]) => !NEW_KEYS.includes(k)),
    ) as unknown as RouteActivityState;
    expect(routeChangePriority(old, now)).toBe(5);
    expect(routeChangePriority(now, buildRouteActivityState(route(), ctx("en")))).toBeNull();
  });

  it("the server reads the columns Navigate needs, with the same builder", () => {
    const src = read("src/lib/push-liveactivity.server.ts");
    expect(src).toMatch(/properties\(label, street, city, postal_code, latitude, longitude,/);
    expect(src).toMatch(/buildRouteActivityState\(route\.visits,/);
    expect(read("src/lib/my-day.functions.ts")).toMatch(
      /properties\(label, street, city, postal_code, latitude, longitude,/,
    );
  });
});

// ── 2. a state from before the buttons ────────────────────────────────────

const NEW_KEYS = [
  "visitId",
  "destLat",
  "destLng",
  "destAddress",
  "nextAction",
  "navigateLabel",
  "actionLabel",
];

/** Exactly what TestFlight build 261 sends and saves: the twelve keys. */
const BUILD_261_STATE = {
  stopLabel: "Stop 5 of 12",
  nextLabel: "Next stop",
  nextStop: "412 Elm St",
  window: "10:40 AM–11:00 AM",
  doneLabel: "3 done",
  skippedLabel: "1 skipped",
  done: 3,
  skipped: 1,
  total: 12,
  position: 5,
  allDone: false,
  rtl: false,
};

describe("a state written before the buttons still decodes", () => {
  const swift = read("ios/App/App/LiveActivity/RouteActivityAttributes.swift");

  it("the old shape is the new one minus the button fields, and nothing else", () => {
    const now = Object.keys(buildRouteActivityState(route(), ctx("en")));
    expect(now.filter((k) => !NEW_KEYS.includes(k)).sort()).toEqual(
      Object.keys(BUILD_261_STATE).sort(),
    );
  });

  it.each(NEW_KEYS)("%s is optional in Swift and decoded with decodeIfPresent under try?", (key) => {
    expect(swift).toMatch(new RegExp(`public var ${key}: (String|Double)\\?`));
    expect(swift).toMatch(
      new RegExp(`${key} = (Self\\.nonEmpty\\()?try\\? c\\.decodeIfPresent\\((String|Double)\\.self, forKey: \\.${key}\\)`),
    );
    // And defaults to nil in the memberwise init, so the demo and the plugin
    // that build a state by hand need not know about it.
    expect(swift).toMatch(new RegExp(`${key}: (String|Double)\\? = nil`));
  });

  it("no key is decoded with a bare `try`, which would throw the whole update away", () => {
    const decoder = swift.slice(swift.indexOf("public init(from decoder: Decoder)"));
    const body = decoder.slice(0, decoder.indexOf("\n        }\n"));
    expect(body).not.toMatch(/=\s*try c\./);
    expect(body).not.toMatch(/=\s*try! c\./);
  });

  it("nextAction is a String, not an enum, so a value a newer server invents cannot fail the decode", () => {
    expect(swift).toMatch(/public var nextAction: String\?/);
    expect(swift).toMatch(/static let actions: Set<String> = \["start", "complete"\]/);
  });
});

// ── 3. the links back into the app ────────────────────────────────────────

const link = (q: string) => `consulting.thenorth.houndstack://open/my-day?${q}`;

describe("a lock-screen link opens My Day and nothing else", () => {
  it("rebuilds the path from the date, the stop and the action", () => {
    expect(liveActivityLinkTarget(link(`date=2026-10-07&visit=${V1}&action=start`))).toBe(
      `/my-day?date=2026-10-07&visit=${V1}&action=start`,
    );
    expect(liveActivityLinkTarget(link(`visit=${V1}&action=complete`))).toBe(
      `/my-day?visit=${V1}&action=complete`,
    );
    expect(liveActivityLinkTarget(link(`date=2026-10-07&visit=${V1}`))).toBe(
      `/my-day?date=2026-10-07&visit=${V1}`,
    );
    expect(liveActivityLinkTarget("consulting.thenorth.houndstack://open/my-day")).toBe("/my-day");
  });

  it.each(["delete", "pay", "START", "start ", "complete;start", "", "javascript:alert(1)"])(
    "drops an action that is not on the allowlist: %j",
    (action) => {
      expect(liveActivityLinkTarget(link(`visit=${V1}&action=${encodeURIComponent(action)}`))).toBe(
        `/my-day?visit=${V1}`,
      );
    },
  );

  it("drops an action with no stop, a stop that is not a UUID, and a day that is not a day", () => {
    expect(liveActivityLinkTarget(link("action=start"))).toBe("/my-day");
    expect(liveActivityLinkTarget(link("visit=../../settings&action=start"))).toBe("/my-day");
    expect(liveActivityLinkTarget(link(`date=tomorrow&visit=${V1}`))).toBe(`/my-day?visit=${V1}`);
  });

  it("passes nothing else through", () => {
    const out = liveActivityLinkTarget(
      link(`visit=${V1}&action=start&next=https%3A%2F%2Fevil.example&staff=${V2}#frag`),
    );
    expect(out).toBe(`/my-day?visit=${V1}&action=start`);
  });

  it.each([
    ["a foreign https origin", `https://evil.example/my-day?visit=${V1}&action=start`],
    ["our own https origin, which is the Android path, not this one", `https://app.houndstack.com/my-day?visit=${V1}`],
    ["another app's scheme", `otherapp://open/my-day?visit=${V1}`],
    ["our scheme, another host", `consulting.thenorth.houndstack://evil.example/my-day?visit=${V1}`],
    ["the OAuth hand-back", "consulting.thenorth.houndstack://auth-callback#access_token=x"],
    ["another page", "consulting.thenorth.houndstack://open/settings/users"],
    ["a path that leaves", "consulting.thenorth.houndstack://open//evil.example/my-day"],
    ["a path that climbs", "consulting.thenorth.houndstack://open/my-day/../settings"],
    ["credentials", "consulting.thenorth.houndstack://u:p@open/my-day"],
    ["a port", "consulting.thenorth.houndstack://open:8080/my-day"],
    ["javascript", "javascript:alert(1)//open/my-day"],
    ["not a URL", "my-day?visit=x"],
  ])("refuses %s", (_why, url) => {
    expect(liveActivityLinkTarget(url)).toBeNull();
  });

  it("the allowlist is exactly Start and Complete", () => {
    expect([...LIVE_ACTIVITY_ACTIONS]).toEqual(["start", "complete"]);
    expect(isLiveActivityAction("start")).toBe(true);
    expect(isLiveActivityAction("complete")).toBe(true);
    expect(isLiveActivityAction("skip")).toBe(false);
    expect(isLiveActivityAction(undefined)).toBe(false);
  });

  it("arrives through the same appUrlOpen listener as an Android link", async () => {
    const { initAppLinks } = await import("@/lib/native");
    const go = vi.fn();
    await initAppLinks(go);
    listeners.appUrlOpen({ url: link(`date=2026-10-07&visit=${V1}&action=complete`) });
    expect(go).toHaveBeenLastCalledWith(`/my-day?date=2026-10-07&visit=${V1}&action=complete`);
    go.mockClear();
    listeners.appUrlOpen({ url: `https://evil.example/my-day?visit=${V1}&action=start` });
    listeners.appUrlOpen({ url: "consulting.thenorth.houndstack://auth-callback#access_token=x" });
    listeners.appUrlOpen({ url: "consulting.thenorth.houndstack://open/settings" });
    expect(go).not.toHaveBeenCalled();
  });

  it("the scheme is the app's, and the OAuth hand-back is a different host", () => {
    expect(read("ios/App/App/Info.plist")).toContain(`<string>${APP_URL_SCHEME}</string>`);
    expect(read("capacitor.config.ts")).toContain(`appId: "${APP_URL_SCHEME}"`);
    expect(read("src/lib/native-oauth.ts")).toContain(`"${APP_URL_SCHEME}://auth-callback"`);
    expect(LIVE_ACTIVITY_LINK_HOST).not.toBe("auth-callback");
  });
});

// ── 4. the widget ─────────────────────────────────────────────────────────

describe("the widget's buttons", () => {
  const attrs = read("ios/App/App/LiveActivity/RouteActivityAttributes.swift");
  const view = read("ios/App/RouteActivity/RouteLiveActivity.swift");
  const extensionCode = codeOnly(view) + codeOnly(read("ios/App/RouteActivity/RouteActivityBundle.swift"));

  it("build their links from the scheme, host and page the JS accepts", () => {
    expect(attrs).toContain(`static let scheme = "${APP_URL_SCHEME}"`);
    expect(attrs).toContain(`static let host = "${LIVE_ACTIVITY_LINK_HOST}"`);
    expect(attrs).toContain(`static let path = "${LIVE_ACTIVITY_LINK_PATH}"`);
  });

  it("Navigate opens the directions URL My Day's own Navigate opens", () => {
    const myDay = read("src/routes/_authenticated/my-day.tsx");
    expect(myDay).toContain("https://www.google.com/maps/dir/?api=1&destination=");
    expect(attrs).toContain('URLComponents(string: "https://www.google.com/maps/dir/")');
    expect(attrs).toMatch(/URLQueryItem\(name: "api", value: "1"\),\s*URLQueryItem\(name: "destination", value: destination\)/);
  });

  it("Navigate is passed on by the app, which iOS hands the card's link to, rebuilt and not echoed", () => {
    // Measured on the simulator: a Link on a Live Activity opens the app
    // that owns it with the URL, whatever the URL is. So AppDelegate has to
    // pass a directions link on, and must do it before Capacitor sees it.
    const delegate = codeOnly(read("ios/App/App/AppDelegate.swift"));
    const open = delegate.slice(delegate.indexOf("open url: URL"));
    const handOff = open.indexOf("RouteLinks.directionsHandOff(url)");
    expect(handOff).toBeGreaterThan(-1);
    expect(handOff).toBeLessThan(open.indexOf("ApplicationDelegateProxy.shared.application(app, open: url"));
    expect(open).toMatch(/app\.open\(maps\)/);
    expect(open).not.toMatch(/app\.open\(url\)/);
    // Exactly the shape directions() builds, and the result is rebuilt by it.
    const fn = attrs.slice(attrs.indexOf("static func directionsHandOff"));
    expect(fn).toMatch(/url\.scheme == "https", url\.host == "www\.google\.com", url\.path == "\/maps\/dir"/);
    expect(fn).toMatch(/return directions\(lat: lat, lng: lng, address: nil\)/);
    expect(fn).toMatch(/return directions\(lat: nil, lng: nil, address: destination\)/);
  });

  it("Navigate and Complete are plain Links, and nothing runs in the extension", () => {
    expect(extensionCode).toMatch(/Link\(destination: url\)/);
    // Start's intent is a type the view names; its work happens in the app
    // (RouteActivityIntents.swift, perform() is empty under
    // ROUTE_ACTIVITY_EXTENSION). The view itself makes no request.
    expect(extensionCode).not.toMatch(/URLSession|fetch|Authorization|api\.houndstack|supabase|Keychain|SecItem/i);
    expect(codeOnly(attrs)).not.toMatch(/URLSession|Authorization|api\.houndstack|supabase|token/i);
    // Still one extension target; the intent file is shared, not a target.
    const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx.match(/productType = "com\.apple\.product-type\.app-extension";/g)).toHaveLength(1);
  });

  it("are drawn on iOS 17 and later only, and a tap on the card opens My Day on every version", () => {
    expect(view).toMatch(/guard #available\(iOS 17\.0, \*\) else \{ return false \}/);
    expect(view.match(/\.widgetURL\(/g)?.length).toBe(2);
    // The deployment targets did not move.
    const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
    expect(pbx).toContain("IPHONEOS_DEPLOYMENT_TARGET = 16.2;");
    expect(pbx).toContain("IPHONEOS_DEPLOYMENT_TARGET = 15.0;");
    expect(pbx).not.toMatch(/IPHONEOS_DEPLOYMENT_TARGET = 1[7-9]/);
  });

  it("are at least 44pt tall, on the lock screen and in the expanded island only", () => {
    expect(view).toMatch(/\.frame\(maxWidth: \.infinity, minHeight: 44\)/);
    const compact = view.slice(view.indexOf("} compactLeading: {"), view.indexOf(".keylineTint("));
    expect(compact).not.toMatch(/ActionButtons|Link\(/);
    expect(view).toMatch(/DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*ActionButtons\(/);
    expect(view).toMatch(/LockScreenView[\s\S]*ActionButtons\(routeDate: routeDate, state: state\)/);
  });
});

// ── 5. My Day hands over Start and does not press it ──────────────────────

describe("My Day on a lock-screen link", () => {
  const labels = { start: "Start", complete: "Complete" };
  const card = (...texts: string[]) => {
    const buttons = texts.map((text) => ({ textContent: ` ${text} `, disabled: false }));
    return { buttons, node: { querySelectorAll: () => buttons } as unknown as ParentNode };
  };

  it("finds the stop's own button by its label", () => {
    const c = card("More", "Start", "Skip");
    expect(findActionButton(c.node, "start", labels)).toBe(c.buttons[1]);
  });

  it("lands on Complete when the stop was started since the lock screen said Start", () => {
    const c = card("Take photo", "Complete");
    expect(findActionButton(c.node, "start", labels)).toBe(c.buttons[1]);
    expect(findActionButton(card("More").node, "complete", labels)).toBeNull();
  });

  it("focuses Start and never clicks it, hands Complete to the card, and takes action out of the URL", () => {
    const hook = codeOnly(read("src/components/my-day/use-live-activity-action.ts"));
    expect(hook).toMatch(/\.focus\(/);
    expect(hook).not.toMatch(/\.click\(|dispatchEvent|mutate|actions\.(start|complete)/);
    expect(hook).toMatch(/if \(action === "complete" && capture\.current\?\.\(visitId\)\)/);
    const myDay = read("src/routes/_authenticated/my-day.tsx");
    expect(myDay).toMatch(/if \(out\.visit && isLiveActivityAction\(search\.action\)\) out\.action = search\.action;/);
    expect(myDay).toMatch(/useLiveActivityAction\(\{[\s\S]*?action: undefined[\s\S]*?replace: true/);
  });
});
