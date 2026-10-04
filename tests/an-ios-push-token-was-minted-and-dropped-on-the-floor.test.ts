// iOS push had every piece except the ones that connect them.
//
// On 2026-10-03, with the owner asking for native push at launch, the chain
// from "something happens" to "a phone buzzes" was broken at FIVE links, each
// silently, and each hidden behind the one before it:
//
//   1. App.entitlements had no `aps-environment`, so iOS would not issue a
//      device token to the app at all.
//   2. AppDelegate.swift did not forward the token. @capacitor/push-notifications
//      listens on NotificationCenter for it; iOS hands it only to the app
//      delegate. Even with the entitlement, the token went nowhere.
//   3. The JS added its `registration` listener AFTER `register()`, and the
//      plugin does not retain that event, so a fast token could be missed.
//   4. `subscribeStaffNativePush` upserted with `onConflict: "native_token"`,
//      which names a PARTIAL unique index. Postgres cannot infer one from a
//      bare ON CONFLICT column list, so every call failed — reproduced on a
//      scratch Postgres 18 with the same index:
//        ERROR: there is no unique or exclusion constraint matching the ON
//        CONFLICT specification
//      The web-push `onConflict: "endpoint"` upserts had the same flaw.
//   5. `sendPushToUser` had no caller. Nothing in the product ever sent a
//      push to a staff member, on any platform.
//
// And on the server, the APNs sender minted a new provider token per send
// (Apple rate-limits that with 429 TooManyProviderTokenUpdates) and a
// malformed APNS_AUTH_KEY threw into the caller.
//
// ── WHAT THIS FILE CANNOT CHECK ───────────────────────────────────────────
//
// That Apple accepts a send. There is no .p8 in this environment and the
// suite makes no network calls; APNs is asserted against Apple's documented
// request shape, with fetch mocked. The JWT IS verified cryptographically,
// against a throwaway P-256 key generated here. The first real proof is a
// TestFlight install receiving one — docs/ios-build.md › Push notifications.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, verify } from "node:crypto";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── fakes ─────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  rows: [] as any[],
  updates: [] as Array<{ fields: any; col: string; val: any }>,
  inserts: [] as any[],
  insertError: null as any,
  updateMatches: [] as boolean[],
  pushCalls: [] as string[],
  platform: "ios",
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(_table: string) {
    let pendingUpdate: any = null;
    const q: any = {
      select: () => q,
      eq: (col: string, val: any) => {
        if (pendingUpdate) h.updates.push({ fields: pendingUpdate, col, val });
        return q;
      },
      update: (fields: any) => {
        pendingUpdate = fields;
        return q;
      },
      insert: (row: any) => {
        h.inserts.push(row);
        return Promise.resolve({ error: h.insertError });
      },
      then: (res: any) => {
        if (pendingUpdate) {
          const matched = h.updateMatches.length ? h.updateMatches.shift()! : false;
          return Promise.resolve({ data: matched ? [{ id: "r1" }] : [], error: null }).then(res);
        }
        return Promise.resolve({ data: h.rows, error: null }).then(res);
      },
    };
    return q;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => h.platform },
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    checkPermissions: async () => {
      h.pushCalls.push("checkPermissions");
      return { receive: "prompt" };
    },
    requestPermissions: async () => {
      h.pushCalls.push("requestPermissions");
      return { receive: "granted" };
    },
    addListener: async (name: string) => {
      h.pushCalls.push(`addListener:${name}`);
      return { remove: async () => h.pushCalls.push(`remove:${name}`) };
    },
    register: async () => {
      h.pushCalls.push("register");
    },
  },
}));

import {
  APNS_DEFAULT_TOPIC,
  APNS_HOSTS,
  apnsConfigFromEnv,
  apnsErrorIsGone,
  apnsHost,
  apnsProviderToken,
  apnsRequestFor,
  p8ToDer,
  resetApnsTokenCacheForTests,
  savePushSubscription,
  sendPushToUser,
} from "@/lib/push.server";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const P8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const TOKEN = "A1B2C3D4".repeat(8);

function useApnsEnv(extra: Record<string, string> = {}) {
  vi.stubEnv("APNS_TEAM_ID", "TEAM123456");
  vi.stubEnv("APNS_KEY_ID", "KEY1234567");
  vi.stubEnv("APNS_AUTH_KEY", P8);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

const fetchMock = vi.fn();

beforeEach(() => {
  h.rows = [];
  h.updates = [];
  h.inserts = [];
  h.insertError = null;
  h.updateMatches = [];
  h.pushCalls = [];
  h.platform = "ios";
  resetApnsTokenCacheForTests();
  for (const k of ["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_AUTH_KEY", "APNS_TOPIC", "APNS_ENVIRONMENT"]) {
    vi.stubEnv(k, "");
  }
  vi.stubEnv("VAPID_PUBLIC_KEY", "");
  vi.stubEnv("FCM_SERVICE_ACCOUNT", "");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1-2. the native project ───────────────────────────────────────────────

describe("the iOS project can be issued a token at all", () => {
  it("App.entitlements asks for aps-environment, as Xcode's capability writes it", () => {
    // `development` in the file is Apple's standard, not a mistake: "Xcode sets
    // the value of the entitlement based on your app's current provisioning
    // profile" — a distribution profile (TestFlight, App Store, i.e. every
    // Xcode Cloud archive) signs it as `production`. Writing `production` here
    // breaks signing of a Debug build against a development profile.
    const ent = read("ios/App/App/App.entitlements");
    expect(ent).toMatch(/<key>aps-environment<\/key>\s*<string>development<\/string>/);
    expect(ent, "Sign in with Apple must survive the edit").toMatch(/com\.apple\.developer\.applesignin/);
  });

  it("AppDelegate forwards both registration outcomes to the plugin", () => {
    const src = codeOnly(read("ios/App/App/AppDelegate.swift"));
    expect(src).toMatch(
      /didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data\)\s*\{\s*NotificationCenter\.default\.post\(name: \.capacitorDidRegisterForRemoteNotifications, object: deviceToken\)/,
    );
    expect(src).toMatch(
      /didFailToRegisterForRemoteNotificationsWithError error: Error\)\s*\{\s*NotificationCenter\.default\.post\(name: \.capacitorDidFailToRegisterForRemoteNotifications, object: error\)/,
    );
  });

  it("does not claim a background mode it does not use", () => {
    // UIBackgroundModes/remote-notification is for silent (content-available)
    // pushes. Every push this server sends is a visible alert, and declaring a
    // background mode an app does not use is a review question for nothing.
    // If a silent push is ever added, add both together.
    expect(read("ios/App/App/Info.plist")).not.toMatch(/remote-notification/);
    expect(codeOnly(read("src/lib/push.server.ts"))).not.toMatch(/content-available/);
  });

  it("the default APNs topic is the app's bundle id", () => {
    const appId = /appId:\s*"([^"]+)"/.exec(read("capacitor.config.ts"))?.[1];
    expect(appId).toBeTruthy();
    expect(APNS_DEFAULT_TOPIC).toBe(appId);
    expect(read("ios/App/App.xcodeproj/project.pbxproj")).toContain(
      `PRODUCT_BUNDLE_IDENTIFIER = ${APNS_DEFAULT_TOPIC};`,
    );
  });
});

// ── 3. the device side ────────────────────────────────────────────────────

describe("registerPushNotifications", () => {
  it("listens before it registers, and asks only while asking is possible", async () => {
    const { registerPushNotifications } = await import("@/lib/native");
    const cleanup = await registerPushNotifications(() => {});
    expect(h.pushCalls).toEqual([
      "checkPermissions",
      "requestPermissions",
      "addListener:registration",
      "addListener:registrationError",
      "register",
    ]);
    cleanup();
    await Promise.resolve();
    expect(h.pushCalls).toContain("remove:registration");
  });

  // Through turnOnPushNotifications since 2026-10-04, the one path the shell
  // and the Preferences card's button share (see
  // a-phone-that-never-asked-for-notifications.test.ts).
  it("is only ever called from the signed-in shell, never the root", () => {
    expect(read("src/routes/_authenticated/route.tsx")).toMatch(/turnOnPushNotifications\(/);
    expect(read("src/routes/__root.tsx")).not.toMatch(
      /registerPushNotifications|turnOnPushNotifications/,
    );
  });

  it("sign-out releases the device token before the session is gone", () => {
    const src = codeOnly(read("src/lib/offline/read-cache.ts"));
    const release = src.indexOf("releasePushRegistration()");
    const signOut = src.lastIndexOf("supabase.auth.signOut()");
    expect(release, "signOutAndClearDevice no longer releases the push token").toBeGreaterThan(-1);
    expect(release).toBeLessThan(signOut);
  });
});

// ── 4. saving the token ───────────────────────────────────────────────────

describe("savePushSubscription", () => {
  it("no subscription write is an upsert on a partial-index column", () => {
    const src = codeOnly(read("src/lib/push.functions.ts"));
    expect(src).not.toMatch(/onConflict:\s*"(native_token|endpoint)"/);
  });

  it("moves an existing token to whoever registered it now", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    h.updateMatches = [true];
    await savePushSubscription(supabaseAdmin as any, { column: "native_token", value: TOKEN }, {
      user_id: "tech-b",
      platform: "ios",
    });
    expect(h.inserts).toHaveLength(0);
    expect(h.updates[0]).toMatchObject({
      col: "native_token",
      val: TOKEN,
      fields: { user_id: "tech-b", platform: "ios", disabled: false, last_error: null },
    });
  });

  it("inserts a token it has not seen", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await savePushSubscription(supabaseAdmin as any, { column: "native_token", value: TOKEN }, {
      user_id: "tech-a",
      platform: "ios",
    });
    expect(h.inserts[0]).toMatchObject({ native_token: TOKEN, user_id: "tech-a", disabled: false });
  });

  it("survives losing a race to insert the same token", async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    h.updateMatches = [false, true];
    h.insertError = { code: "23505", message: "duplicate key" };
    await expect(
      savePushSubscription(supabaseAdmin as any, { column: "native_token", value: TOKEN }, {
        user_id: "tech-a",
      }),
    ).resolves.toBeUndefined();
    expect(h.updates).toHaveLength(2);
  });
});

// ── 5. something actually sends ───────────────────────────────────────────

describe("sendPushToUser has a caller", () => {
  it("the notification centre pushes what it records", () => {
    expect(codeOnly(read("src/lib/notify-center.server.ts"))).toMatch(/sendPushToUser\(/);
  });
});

// ── the APNs sender ───────────────────────────────────────────────────────

describe("APNs configuration", () => {
  it("defaults to production and accepts both of Apple's names for sandbox", () => {
    expect(apnsHost(undefined)).toBe(APNS_HOSTS.production);
    expect(apnsHost("production")).toBe("https://api.push.apple.com");
    expect(apnsHost("sandbox")).toBe("https://api.sandbox.push.apple.com");
    expect(apnsHost(" Development ")).toBe("https://api.sandbox.push.apple.com");
  });

  it("names exactly what is missing, and defaults the topic", () => {
    expect(apnsConfigFromEnv({}).missing).toEqual(["APNS_TEAM_ID", "APNS_KEY_ID", "APNS_AUTH_KEY"]);
    const { config } = apnsConfigFromEnv({ APNS_TEAM_ID: "T", APNS_KEY_ID: "K", APNS_AUTH_KEY: P8 });
    expect(config?.topic).toBe(APNS_DEFAULT_TOPIC);
    expect(config?.host).toBe(APNS_HOSTS.production);
  });
});

describe("APNS_AUTH_KEY survives however a secret store flattened it", () => {
  // Secret UIs routinely turn the .p8's newlines into literal "\n", drop them,
  // or keep Windows line endings. Every one of these has to import and SIGN —
  // asserting equal bytes alone would pass a normaliser that broke them all
  // the same way.
  const der = Buffer.from(p8ToDer(P8));
  const variants: Record<string, string> = {
    "real newlines": P8,
    "literal \\n sequences": P8.replace(/\n/g, "\\n"),
    "literal \\r\\n sequences": P8.replace(/\n/g, "\\r\\n"),
    "CRLF line endings": P8.replace(/\n/g, "\r\n"),
    "flattened onto one line with spaces": P8.replace(/\n/g, " "),
    "no newlines at all": P8.replace(/\n/g, ""),
    "wrapped in quotes": `"${P8.replace(/\n/g, "\\n")}"`,
    "leading and trailing whitespace": `\n  ${P8}  \n`,
  };
  for (const [name, pasted] of Object.entries(variants)) {
    it(`${name}`, async () => {
      expect(Buffer.from(p8ToDer(pasted)).equals(der)).toBe(true);
      const jwt = await apnsProviderToken(
        { teamId: "T", keyId: "K", authKey: pasted, topic: APNS_DEFAULT_TOPIC, host: APNS_HOSTS.production },
        Date.now(),
      );
      const [a, b, s] = jwt.split(".");
      expect(
        verify("sha256", Buffer.from(`${a}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")),
      ).toBe(true);
      resetApnsTokenCacheForTests();
    });
  }

  it("names a certificate pasted where the .p8 belongs (token auth only)", () => {
    expect(() =>
      p8ToDer("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"),
    ).toThrow(/certificate.*\.p8/);
  });

  it("refuses something that is not a key at all", () => {
    expect(() => p8ToDer("not a key!")).toThrow(/\.p8/);
  });
});

describe("the APNs provider token", () => {
  it("is an ES256 JWT that verifies against the key's public half", async () => {
    const { config } = apnsConfigFromEnv({ APNS_TEAM_ID: "TEAM123456", APNS_KEY_ID: "KEY1234567", APNS_AUTH_KEY: P8 });
    const jwt = await apnsProviderToken(config!, 1_700_000_000_000);
    const [h64, c64, s64] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h64, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(c64, "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: 1_700_000_000,
    });
    const sig = Buffer.from(s64, "base64url");
    expect(sig.length, "JWS wants raw r||s, not DER").toBe(64);
    expect(
      verify("sha256", Buffer.from(`${h64}.${c64}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig),
    ).toBe(true);
  });

  it("is reused inside Apple's 20-to-60-minute window and renewed after it", async () => {
    const { config } = apnsConfigFromEnv({ APNS_TEAM_ID: "T", APNS_KEY_ID: "K", APNS_AUTH_KEY: P8 });
    const t0 = 1_700_000_000_000;
    const a = await apnsProviderToken(config!, t0);
    expect(await apnsProviderToken(config!, t0 + 30 * 60_000)).toBe(a);
    expect(await apnsProviderToken(config!, t0 + 51 * 60_000)).not.toBe(a);
  });
});

describe("the APNs request", () => {
  it("is an alert push to the bundle id, with the deep link where the tap handler reads it", () => {
    const req = apnsRequestFor(
      TOKEN,
      { title: "New text needs a reply", body: "From Pat", url: "/messages", tag: "inbound_sms", data: { type: "inbound_sms" } },
      APNS_DEFAULT_TOPIC,
    );
    expect(req.path).toBe(`/3/device/${TOKEN}`);
    expect(req.headers).toMatchObject({
      "apns-topic": "consulting.thenorth.houndstack",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": "inbound_sms",
    });
    expect(req.body).toEqual({
      aps: {
        alert: { title: "New text needs a reply", body: "From Pat" },
        sound: "default",
        "thread-id": "inbound_sms",
      },
      url: "/messages",
      data: { type: "inbound_sms" },
    });
    // initPushDeepLinks reads `data.url` — and the plugin's `data` IS this body.
    expect(read("src/lib/native.ts")).toMatch(/\[data\.url, nested\.url\]/);
  });

  it("drops a collapse id over Apple's 64-byte limit rather than failing the send", () => {
    const req = apnsRequestFor(TOKEN, { title: "t", tag: "x".repeat(65) }, APNS_DEFAULT_TOPIC);
    expect(req.headers["apns-collapse-id"]).toBeUndefined();
  });

  it("switches a device off only when the DEVICE is the problem", () => {
    expect(apnsErrorIsGone(410, "Unregistered")).toBe(true);
    expect(apnsErrorIsGone(410, undefined)).toBe(true);
    expect(apnsErrorIsGone(400, "BadDeviceToken")).toBe(true);
    expect(apnsErrorIsGone(400, "DeviceTokenNotForTopic")).toBe(true);
    expect(apnsErrorIsGone(403, "InvalidProviderToken")).toBe(false);
    expect(apnsErrorIsGone(429, "TooManyProviderTokenUpdates")).toBe(false);
    expect(apnsErrorIsGone(503, "ServiceUnavailable")).toBe(false);
  });
});

describe("sendPushToUser → APNs, with fetch mocked", () => {
  const iosRow = { id: "row-1", endpoint: null, p256dh: null, auth: null, native_token: TOKEN, platform: "ios" };

  it("posts to the environment's host with a bearer token, and marks the row sent", async () => {
    useApnsEnv({ APNS_ENVIRONMENT: "sandbox" });
    h.rows = [iosRow];
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const out = await sendPushToUser("tech-a", { title: "Hi", url: "/my-day" });
    expect(out).toEqual({ sent: 1, failed: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    expect(init.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(init.headers["apns-topic"]).toBe(APNS_DEFAULT_TOPIC);
    expect(h.updates[0]).toMatchObject({ col: "id", val: "row-1", fields: { last_error: null } });
  });

  it("uses production when APNS_ENVIRONMENT is unset", async () => {
    useApnsEnv();
    h.rows = [iosRow];
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await sendPushToUser("tech-a", { title: "Hi" });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.push.apple.com/3/device/${TOKEN}`);
  });

  it("410 Unregistered switches that device off and records why", async () => {
    useApnsEnv();
    h.rows = [iosRow];
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ reason: "Unregistered", timestamp: 1 }), { status: 410 }),
    );
    const out = await sendPushToUser("tech-a", { title: "Hi" });
    expect(out).toEqual({ sent: 0, failed: 1 });
    expect(h.updates[0]).toMatchObject({
      col: "id",
      val: "row-1",
      fields: { last_error: "Unregistered", disabled: true },
    });
  });

  it("a rejected provider token does NOT switch the device off", async () => {
    useApnsEnv();
    h.rows = [iosRow];
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ reason: "InvalidProviderToken" }), { status: 403 }));
    await sendPushToUser("tech-a", { title: "Hi" });
    expect(h.updates[0].fields.disabled).toBeUndefined();
  });

  it("missing credentials: logs which, sends nothing, throws nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.rows = [iosRow];
    const out = await sendPushToUser("tech-a", { title: "Hi" });
    expect(out).toEqual({ sent: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.updates, "an unconfigured server is not a fault in the device").toHaveLength(0);
    // Warned once per server instance — this test may or may not be the first.
    if (warn.mock.calls.length) expect(String(warn.mock.calls[0][0])).toMatch(/APNS_TEAM_ID/);
  });

  it("an unreadable APNS_AUTH_KEY is logged, never thrown into the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useApnsEnv({ APNS_AUTH_KEY: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" });
    h.rows = [iosRow];
    await expect(sendPushToUser("tech-a", { title: "Hi" })).resolves.toEqual({ sent: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a network failure is recorded on the row and not thrown", async () => {
    useApnsEnv();
    h.rows = [iosRow];
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    await expect(sendPushToUser("tech-a", { title: "Hi" })).resolves.toEqual({ sent: 0, failed: 1 });
    expect(h.updates[0].fields).toMatchObject({ last_error: "socket hang up" });
    expect(h.updates[0].fields.disabled).toBeUndefined();
  });
});
