// The route on a technician's lock screen: an iOS Live Activity.
//
// What this file can check without a phone:
//   1. the content state My Day and the server both build -- stop number,
//      next stop, window, counts, a finished route -- in the tech's language;
//   2. the APNs request for a remote update, against Apple's documented shape
//      (liveactivity push type, <bundle>.push-type.liveactivity topic, aps
//      timestamp/event/content-state), and what a 410 or BadDeviceToken does,
//      with fetch mocked and the JWT signed by a throwaway key;
//   3. that the JS wrappers do nothing at all on the web and on Android;
//   4. that the native project is wired: the extension target embedded with
//      its own bundle id, the plugin registered, the Swift ContentState
//      carrying exactly the keys the TS builder writes;
//   5. that each office action that changes a tech's day pushes to it.
//
// What it cannot: that iOS draws it (the simulator screenshots in the PR do
// that), and that Apple delivers a remote update (needs a real .p8 and a
// phone; docs/ios-build.md › Live Activity).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const h = vi.hoisted(() => ({
  native: false,
  platform: "web",
  registered: 0,
  plugin: null as any,
  errors: [] as Array<{ e: unknown; tags: Record<string, string> }>,
  issues: [] as Array<{ m: string; tags: Record<string, string>; level?: string }>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => h.native, getPlatform: () => h.platform },
  registerPlugin: () => {
    h.registered++;
    return h.plugin;
  },
}));

vi.mock("@/lib/monitoring/client", () => ({
  reportClientError: (e: unknown, tags: Record<string, string>) => h.errors.push({ e, tags }),
  reportClientIssue: (m: string, tags: Record<string, string>, level?: string) =>
    h.issues.push({ m, tags, level }),
}));

import i18n from "@/lib/i18n";
import {
  buildRouteActivityState,
  routeChangePriority,
  routeHasStopsLeft,
  stopName,
  type RouteActivityState,
  type RouteActivityVisit,
} from "@/lib/live-activity-state";
import {
  liveActivityRequestFor,
  liveActivityTopic,
  sendLiveActivityPush,
} from "@/lib/push-liveactivity.server";
import { resetApnsTokenCacheForTests } from "@/lib/push.server";
import {
  endRouteActivity,
  liveActivityAvailable,
  liveActivitySupport,
  onRouteActivityEvents,
  resetLiveActivityForTests,
  startRouteActivity,
  updateRouteActivity,
} from "@/lib/live-activity";

const TZ = "America/Chicago";
const ctx = (lang: string) => ({
  t: i18n.getFixedT(lang) as unknown as (k: string, o?: Record<string, unknown>) => string,
  tz: TZ,
  locale: lang === "en" ? undefined : lang === "es" ? "es-US" : undefined,
  rtl: lang === "ar",
});

const prop = (street: string, label: string | null = null, w: [string, string] | null = null) => ({
  street,
  label,
  earliest_service_time: w?.[0] ?? null,
  latest_service_time: w?.[1] ?? null,
});

/** Twelve stops: three done, one skipped, the fifth next. */
function day(): RouteActivityVisit[] {
  const out: RouteActivityVisit[] = [];
  for (let i = 1; i <= 12; i++) {
    out.push({
      id: `v${i}`,
      status: i <= 3 ? "completed" : i === 4 ? "skipped" : "scheduled",
      properties: prop(`${100 + i} Elm St`),
    });
  }
  // 10:40-11:00 Chicago on 2026-10-05 (CDT, UTC-5).
  out[4].eta_start = "2026-10-05T15:40:00Z";
  out[4].eta_end = "2026-10-05T16:00:00Z";
  return out;
}

// ── 1. the content state ──────────────────────────────────────────────────

describe("the content state", () => {
  it("says which stop, where, when, and how the day stands", () => {
    const s = buildRouteActivityState(day(), ctx("en"));
    expect(s).toEqual({
      stopLabel: "Stop 5 of 12",
      nextLabel: "Next stop",
      nextStop: "105 Elm St",
      window: "10:40 AM–11:00 AM",
      doneLabel: "3 done",
      skippedLabel: "1 skipped",
      done: 3,
      skipped: 1,
      total: 12,
      position: 5,
      allDone: false,
      rtl: false,
      // The buttons (tests/buttons-on-the-lock-screen.test.ts). No
      // coordinates in this fixture, so Navigate goes by the address.
      visitId: "v5",
      destLat: null,
      destLng: null,
      destAddress: "105 Elm St",
      nextAction: "start",
      navigateLabel: "Navigate",
      actionLabel: "Start",
    } satisfies RouteActivityState);
  });

  it("points at the job under way before the next scheduled one, by its place in the route", () => {
    const v = day();
    v[6].status = "in_progress"; // stop 7 started early
    const s = buildRouteActivityState(v, ctx("en"));
    expect(s.stopLabel).toBe("Stop 7 of 12");
    expect(s.nextLabel).toBe("In progress");
    expect(s.nextStop).toBe("107 Elm St");
  });

  it("names a stop by the property's label, else its street, and never by the customer", () => {
    expect(stopName({ id: "a", status: "scheduled", properties: prop("9 Oak Ave", "Rear lot") })).toBe(
      "Rear lot",
    );
    expect(stopName({ id: "a", status: "scheduled", properties: prop("9 Oak Ave", "  ") })).toBe(
      "9 Oak Ave",
    );
    // A visit row carries the client too; the builder must not read it.
    const withClient = [
      { id: "a", status: "scheduled", clients: { display_name: "Jane Doe" }, properties: prop("9 Oak Ave") },
    ] as RouteActivityVisit[];
    expect(JSON.stringify(buildRouteActivityState(withClient, ctx("en")))).not.toMatch(/Jane/);
    expect(codeOnly(read("src/lib/live-activity-state.ts"))).not.toMatch(/clients|display_name/);
  });

  it("falls back to the property's service window when the route has no ETA", () => {
    const v: RouteActivityVisit[] = [
      { id: "a", status: "scheduled", properties: prop("1 A St", null, ["08:00:00", "10:30:00"]) },
      { id: "b", status: "scheduled", properties: prop("2 B St", null, ["13:00:00", ""]) },
    ];
    expect(buildRouteActivityState(v, ctx("en")).window).toBe("8:00 AM–10:30 AM");
    v[0].status = "completed";
    expect(buildRouteActivityState(v, ctx("en")).window).toBe("After 1:00 PM");
    v[1].properties = prop("2 B St");
    expect(buildRouteActivityState(v, ctx("en")).window).toBeNull();
  });

  it("is finished when nothing is left, done or skipped, and says so", () => {
    const v = day().map((x) => ({ ...x, status: x.id === "v12" ? "skipped" : "completed" }));
    const s = buildRouteActivityState(v, ctx("en"));
    expect(s.allDone).toBe(true);
    expect(s.stopLabel).toBe("All stops done");
    expect(s.nextLabel).toBe("Route finished");
    expect(s.nextStop).toBeNull();
    expect(s.window).toBeNull();
    expect([s.done, s.skipped, s.total, s.position]).toEqual([11, 1, 12, 12]);
    expect(routeHasStopsLeft(v)).toBe(false);
    expect(routeHasStopsLeft(day())).toBe(true);
  });

  it("leaves a canceled visit off the route", () => {
    const v = day();
    v[11].status = "canceled";
    const s = buildRouteActivityState(v, ctx("en"));
    expect(s.total).toBe(11);
    expect(s.stopLabel).toBe("Stop 5 of 11");
  });

  it("is written in the tech's language, and Arabic is marked right to left", () => {
    const es = buildRouteActivityState(day(), ctx("es"));
    expect(es.stopLabel).toBe("Parada 5 de 12");
    expect(es.nextLabel).toBe("Siguiente parada");
    expect(es.doneLabel).toBe("3 hechas");
    const ar = buildRouteActivityState(day(), ctx("ar"));
    expect(ar.stopLabel).toBe("المحطة 5 من 12");
    expect(ar.rtl).toBe(true);
    const zh = buildRouteActivityState(day(), ctx("zh"));
    expect(zh.stopLabel).toBe("第 5 站，共 12 站");
  });

  it("rates a change by whether a person not looking at the phone needs it", () => {
    const a = buildRouteActivityState(day(), ctx("en"));
    expect(routeChangePriority(null, a)).toBe(10);
    expect(routeChangePriority(a, { ...a })).toBeNull();
    expect(routeChangePriority(a, { ...a, window: "11:00 AM–11:20 AM" })).toBe(5);
    expect(routeChangePriority(a, { ...a, nextStop: "1 Other Rd" })).toBe(10);
    expect(routeChangePriority(a, { ...a, total: 13, stopLabel: "Stop 5 of 13" })).toBe(10);
  });
});

// ── 2. the remote update ──────────────────────────────────────────────────

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const fetchMock = vi.fn();

function fakeDb() {
  const updates: Array<{ fields: Record<string, unknown>; id: unknown }> = [];
  return {
    updates,
    from: (table: string) => {
      expect(table).toBe("live_activity_tokens");
      return {
        update: (fields: Record<string, unknown>) => ({
          eq: async (_col: string, id: unknown) => {
            updates.push({ fields, id });
            return { error: null };
          },
        }),
      };
    },
  };
}

describe("the remote update", () => {
  beforeEach(() => {
    resetApnsTokenCacheForTests();
    vi.stubEnv("APNS_TEAM_ID", "TEAM123456");
    vi.stubEnv("APNS_KEY_ID", "KEY1234567");
    vi.stubEnv("APNS_AUTH_KEY", P8);
    vi.stubEnv("APNS_TOPIC", "");
    vi.stubEnv("APNS_ENVIRONMENT", "production");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const state = () => buildRouteActivityState(day(), ctx("en"));

  it("is a liveactivity push on the app's .push-type.liveactivity topic", () => {
    expect(liveActivityTopic()).toBe("consulting.thenorth.houndstack.push-type.liveactivity");
    const req = liveActivityRequestFor(
      "ab12",
      { event: "update", state: state(), priority: 10, timestamp: 1_800_000_000 },
    );
    expect(req.path).toBe("/3/device/ab12");
    expect(req.headers).toEqual({
      "apns-topic": "consulting.thenorth.houndstack.push-type.liveactivity",
      "apns-push-type": "liveactivity",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    expect(req.body).toEqual({
      aps: { timestamp: 1_800_000_000, event: "update", "content-state": state() },
    });
    expect(req.body.aps).not.toHaveProperty("alert");
  });

  it("carries a dismissal date only on an end, and a minor change at priority 5", () => {
    const end = liveActivityRequestFor("ab12", {
      event: "end",
      state: state(),
      priority: 5,
      timestamp: 100,
      dismissalDate: 1000,
    });
    expect(end.headers["apns-priority"]).toBe("5");
    expect(end.body.aps).toMatchObject({ event: "end", "dismissal-date": 1000 });
    const update = liveActivityRequestFor("ab12", {
      event: "update",
      state: state(),
      priority: 10,
      timestamp: 100,
      dismissalDate: 1000,
    });
    expect(update.body.aps).not.toHaveProperty("dismissal-date");
  });

  it("follows APNS_TOPIC when the app's topic is overridden", () => {
    vi.stubEnv("APNS_TOPIC", "com.example.other");
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    return sendLiveActivityPush(
      [{ id: "r1", push_token: "ab12" }],
      { event: "update", state: state(), priority: 10, timestamp: 1 },
      fakeDb(),
    ).then(() => {
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers["apns-topic"]).toBe("com.example.other.push-type.liveactivity");
    });
  });

  it("posts to the production host with the provider token, and records what it sent", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const db = fakeDb();
    const r = await sendLiveActivityPush(
      [{ id: "r1", push_token: "ab12" }],
      { event: "update", state: state(), priority: 10, timestamp: 1 },
      db,
    );
    expect(r).toEqual({ sent: 1, failed: 0, ended: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.push.apple.com/3/device/ab12");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(init.body).aps["content-state"]).toEqual(state());
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0].fields).toMatchObject({ last_state: state(), last_error: null });
    expect(db.updates[0].fields).not.toHaveProperty("ended_at");
  });

  it("an end that lands switches the row off as finished", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const db = fakeDb();
    await sendLiveActivityPush(
      [{ id: "r1", push_token: "ab12" }],
      { event: "end", state: state(), priority: 10, timestamp: 1, dismissalDate: 2 },
      db,
    );
    expect(db.updates[0].fields).toMatchObject({ end_reason: "finished" });
    expect(db.updates[0].fields.ended_at).toEqual(expect.any(String));
  });

  it.each([
    [410, "Unregistered"],
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
  ])("a %i %s ends the token and says why", async (status, reason) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reason }), { status }));
    const db = fakeDb();
    const r = await sendLiveActivityPush(
      [{ id: "r9", push_token: "ab12" }],
      { event: "update", state: state(), priority: 10, timestamp: 1 },
      db,
    );
    expect(r).toEqual({ sent: 0, failed: 1, ended: 1 });
    expect(db.updates).toEqual([
      { id: "r9", fields: { ended_at: expect.any(String), end_reason: reason, last_error: reason } },
    ]);
  });

  it("a rate limit or Apple being down is ours, not the phone's: the token stays live", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reason: "TooManyRequests" }), { status: 429 }));
    const db = fakeDb();
    const r = await sendLiveActivityPush(
      [{ id: "r9", push_token: "ab12" }],
      { event: "update", state: state(), priority: 10, timestamp: 1 },
      db,
    );
    expect(r).toEqual({ sent: 0, failed: 1, ended: 0 });
    expect(db.updates).toEqual([{ id: "r9", fields: { last_error: "TooManyRequests" } }]);
  });

  it("a rejected provider token is signed afresh on the next send", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ reason: "InvalidProviderToken" }), { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const msg = { event: "update" as const, state: state(), priority: 10 as const, timestamp: 1 };
    await sendLiveActivityPush([{ id: "r1", push_token: "ab12" }], msg, fakeDb());
    // A new JWT means a new iat or signature; with the cache kept it would be
    // byte-for-byte the same header.
    vi.useFakeTimers({ now: Date.now() + 2000 });
    await sendLiveActivityPush([{ id: "r1", push_token: "ab12" }], msg, fakeDb());
    vi.useRealTimers();
    const a = fetchMock.mock.calls[0][1].headers.authorization;
    const b = fetchMock.mock.calls[1][1].headers.authorization;
    expect(a).not.toBe(b);
  });

  it("without APNs configured, sends nothing and touches no row", async () => {
    vi.stubEnv("APNS_AUTH_KEY", "");
    const db = fakeDb();
    const r = await sendLiveActivityPush(
      [{ id: "r1", push_token: "ab12" }],
      { event: "update", state: state(), priority: 10, timestamp: 1 },
      db,
    );
    expect(r).toEqual({ sent: 0, failed: 0, ended: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it("reuses push.server.ts's APNs code rather than a second copy of it", () => {
    const src = codeOnly(read("src/lib/push-liveactivity.server.ts"));
    expect(src).toMatch(/from "@\/lib\/push\.server"/);
    expect(src).not.toMatch(/crypto\.subtle|importKey|api\.push\.apple\.com/);
  });
});

// ── 3. the web and Android ────────────────────────────────────────────────

describe("the wrappers off iOS", () => {
  beforeEach(() => {
    h.registered = 0;
    h.errors = [];
    h.issues = [];
    h.plugin = null;
    resetLiveActivityForTests();
  });

  it.each([
    ["the web", false, "web"],
    ["Android", true, "android"],
  ])("do nothing on %s", async (_name, native, platform) => {
    h.native = native;
    h.platform = platform;
    const s = buildRouteActivityState(day(), ctx("en"));
    expect(liveActivityAvailable()).toBe(false);
    expect(await liveActivitySupport()).toEqual({ supported: false, enabled: false });
    expect(await startRouteActivity("2026-10-05", "Today's route", s)).toBeNull();
    expect(await updateRouteActivity(s)).toBeNull();
    expect(await endRouteActivity(s, "immediate")).toEqual([]);
    const off = onRouteActivityEvents({ onToken: () => {}, onEnded: () => {} });
    off();
    // The plugin was never even looked up, so nothing can reach a bridge
    // that has no such plugin.
    expect(h.registered).toBe(0);
    expect(h.errors).toEqual([]);
  });
});

describe("the wrappers on iOS", () => {
  beforeEach(() => {
    h.native = true;
    h.platform = "ios";
    h.registered = 0;
    h.errors = [];
    h.issues = [];
    resetLiveActivityForTests();
  });

  it("pass the day, the title and the state through, and turn an end into its policy", async () => {
    const calls: any[] = [];
    h.plugin = {
      start: async (o: any) => (calls.push(["start", o]), { id: "A1", pushToken: "ab12" }),
      update: async (o: any) => (calls.push(["update", o]), { updated: true, id: "A1" }),
      end: async (o: any) => (calls.push(["end", o]), { ended: 1, ids: ["A1"] }),
    };
    const s = buildRouteActivityState(day(), ctx("en"));
    expect(await startRouteActivity("2026-10-05", "Today's route", s)).toEqual({
      id: "A1",
      pushToken: "ab12",
    });
    expect(await updateRouteActivity(s)).toEqual({ updated: true, id: "A1" });
    const at = new Date(1_800_000_000_000);
    expect(await endRouteActivity(s, { after: at })).toEqual(["A1"]);
    expect(calls).toEqual([
      ["start", { attributes: { routeDate: "2026-10-05", title: "Today's route" }, state: s }],
      ["update", { state: s }],
      ["end", { state: s, dismissalPolicy: "after", dismissAt: 1_800_000_000_000 }],
    ]);
    expect(h.registered).toBe(1);
  });

  it("report a failure tagged live_activity instead of throwing, and a switched-off setting once, as info", async () => {
    const off = Object.assign(new Error("off"), { code: "DISABLED" });
    h.plugin = {
      start: async () => {
        throw off;
      },
      update: async () => {
        throw new Error("boom");
      },
    };
    const s = buildRouteActivityState(day(), ctx("en"));
    expect(await startRouteActivity("2026-10-05", "t", s)).toBeNull();
    expect(await startRouteActivity("2026-10-05", "t", s)).toBeNull();
    expect(await updateRouteActivity(s)).toBeNull();
    expect(h.issues).toEqual([
      { m: expect.stringMatching(/switched off/), tags: { area: "live_activity", step: "start" }, level: "info" },
    ]);
    expect(h.errors).toEqual([
      { e: expect.any(Error), tags: { area: "live_activity", step: "update" } },
    ]);
  });
});

// ── 4. the native project ─────────────────────────────────────────────────

describe("the native project", () => {
  const pbx = read("ios/App/App.xcodeproj/project.pbxproj");

  it("the app says it has Live Activities", () => {
    expect(read("ios/App/App/Info.plist")).toMatch(
      /<key>NSSupportsLiveActivities<\/key>\s*<true\/>/,
    );
  });

  it("has a widget extension target with its own bundle id, Info.plist and iOS 16.2 floor", () => {
    expect(pbx).toMatch(/productType = "com\.apple\.product-type\.app-extension";/);
    expect(pbx).toContain("PRODUCT_BUNDLE_IDENTIFIER = consulting.thenorth.houndstack.RouteActivity;");
    expect(pbx).toContain("INFOPLIST_FILE = RouteActivity/Info.plist;");
    expect(pbx).toContain("IPHONEOS_DEPLOYMENT_TARGET = 16.2;");
    expect(read("ios/App/RouteActivity/Info.plist")).toMatch(
      /<key>NSExtensionPointIdentifier<\/key>\s*<string>com\.apple\.widgetkit-extension<\/string>/,
    );
  });

  it("embeds the extension in the app and builds it first", () => {
    expect(pbx).toMatch(/RouteActivity\.appex in Embed Foundation Extensions/);
    expect(pbx).toMatch(/dstSubfolderSpec = 13;/);
    expect(pbx).toMatch(/isa = PBXTargetDependency;\s*target = \w+ \/\* RouteActivity \*\//);
  });

  it("signs the extension automatically with the app's team", () => {
    const team = /DEVELOPMENT_TEAM = (\w+);/.exec(pbx)?.[1];
    expect(team).toBeTruthy();
    const ext = pbx.split("/* Begin XCBuildConfiguration section */")[1];
    const extConfigs = ext
      .split(/\n\t\t\w+ \/\* (?:Debug|Release) \*\/ = \{/)
      .filter((c) => c.includes("consulting.thenorth.houndstack.RouteActivity"));
    expect(extConfigs).toHaveLength(2);
    for (const c of extConfigs) {
      expect(c).toContain("CODE_SIGN_STYLE = Automatic;");
      // No team override: the project-level DEVELOPMENT_TEAM applies.
      expect(c).not.toMatch(/DEVELOPMENT_TEAM = (?!\$)/);
    }
  });

  it("weak-links ActivityKit in the app, which still runs on iOS 15", () => {
    expect(pbx).toMatch(/ActivityKit\.framework in Frameworks \*\/ = \{[^}]*ATTRIBUTES = \(Weak, \)/);
    expect(pbx).toMatch(/IPHONEOS_DEPLOYMENT_TARGET = 15\.0;/);
  });

  it("registers the local plugin from the storyboard's bridge view controller", () => {
    // Through the module, never by a bare @objc name: the superclass is in
    // Capacitor's binary framework, so the bare name is unknown to the
    // Objective-C runtime when the storyboard loads (measured: a black screen
    // and "Unknown class HSBridgeViewController in Interface Builder file").
    expect(read("ios/App/App/Base.lproj/Main.storyboard")).toMatch(
      /customClass="HSBridgeViewController" customModule="HoundStack" customModuleProvider="target"/,
    );
    const vc = codeOnly(read("ios/App/App/HSBridgeViewController.swift"));
    expect(vc).not.toMatch(/@objc\(HSBridgeViewController\)/);
    expect(read("ios/App/App.xcodeproj/project.pbxproj")).toContain("PRODUCT_NAME = HoundStack;");
    expect(vc).toMatch(/override func capacitorDidLoad\(\)/);
    expect(vc).toMatch(/bridge\?\.registerPluginInstance\(RouteActivityPlugin\(\)\)/);
    expect(vc).toMatch(/allowsBackForwardNavigationGestures = true/);
    const plugin = read("ios/App/App/LiveActivity/RouteActivityPlugin.swift");
    expect(plugin).toMatch(/jsName = "RouteActivity"/);
    expect(read("src/lib/live-activity.ts")).toMatch(/registerPlugin<RouteActivityPlugin>\("RouteActivity"\)/);
    for (const m of ["isSupported", "start", "update", "end"]) {
      expect(plugin).toContain(`CAPPluginMethod(name: "${m}"`);
    }
  });

  it("the Swift ContentState has exactly the keys the builder writes", () => {
    const swift = read("ios/App/App/LiveActivity/RouteActivityAttributes.swift");
    const keys = [...swift.matchAll(/case ([\w, ]+)$/gm)]
      .flatMap((m) => m[1].split(",").map((k) => k.trim()))
      .sort();
    const ts = Object.keys(buildRouteActivityState(day(), ctx("en"))).sort();
    expect(keys).toEqual(ts);
  });

  it("the sample activity is Debug-only", () => {
    const demo = read("ios/App/App/LiveActivity/RouteActivityDemo.swift");
    const code = demo.split("\n").filter((l) => !l.trim().startsWith("//"));
    expect(code.find((l) => l.trim())).toBe("#if DEBUG");
    expect(code.filter((l) => l.trim()).at(-1)).toBe("#endif");
    // sceneDidBecomeActive since #570: a scene app's delegate is not told.
    expect(read("ios/App/App/SceneDelegate.swift")).toMatch(
      /#if DEBUG[\s\S]*?RouteActivityDemo\.startIfAsked\(\)[\s\S]*?#endif/,
    );
  });
});

// ── 5. the office's changes reach the lock screen ─────────────────────────

describe("an office change to a tech's day pushes to their lock screen", () => {
  const src = codeOnly(read("src/lib/visits.functions.ts"));
  const body = (name: string) => {
    const at = src.indexOf(`export const ${name} =`);
    expect(at, `${name} not found`).toBeGreaterThan(-1);
    const rest = src.slice(at + 1);
    const end = rest.indexOf("\nexport ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  it.each([
    "reassignVisit",
    "completeVisitFromOffice",
    "rescheduleVisitFromOffice",
    "cancelVisitFromOffice",
    "bulkAssignVisits",
    "bulkRescheduleVisits",
  ])("%s notes the routes before the change and pushes after it", (name) => {
    const b = body(name);
    const watch = b.indexOf("watchRouteLiveActivities(");
    const rpc = b.indexOf(".rpc(");
    const push = b.indexOf("await pushRoutes()");
    expect(watch).toBeGreaterThan(-1);
    expect(watch).toBeLessThan(rpc);
    expect(push).toBeGreaterThan(rpc);
  });

  it.each(["reorderRoute", "createOneOffVisit"])("%s pushes the days it changed", (name) => {
    expect(body(name)).toMatch(/refreshRouteLiveActivities\(/);
  });

  // CHANGED 2026-10-06: applyOptimize became a background run
  // (auto-routing.server.ts, started by routing-runs.functions.ts), and the
  // whole run is written in one transaction. The push moved with it, to just
  // after that write, for the days it wrote.
  it("an auto-routing run pushes the days it wrote, after it wrote them", () => {
    const run = codeOnly(read("src/lib/auto-routing.server.ts"));
    const write = run.indexOf("await applyRoutePlans(");
    const push = run.indexOf("refreshRouteLiveActivities(");
    expect(write).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(write);
  });

  it("redistributeStaffWork rebuilds every live route in the business", () => {
    expect(body("redistributeStaffWork")).toMatch(/refreshOrgRouteLiveActivities\(/);
  });

  it("getMyDay selects the property label the lock screen names a stop by", () => {
    expect(read("src/lib/my-day.functions.ts")).toMatch(/properties\(label, street,/);
  });
});
