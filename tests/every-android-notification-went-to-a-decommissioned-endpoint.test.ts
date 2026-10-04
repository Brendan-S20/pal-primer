// Android push posted to an endpoint Google turned off.
//
// `sendFcm` sent to `https://fcm.googleapis.com/fcm/send` with an
// `Authorization: key=<FCM_SERVER_KEY>` header. That is the legacy FCM HTTP
// API, and it is gone — so every Android notification this app has attempted
// has failed, silently, into `push_subscriptions.last_error`. The comment
// above the function said to migrate to HTTP v1 "if Google fully sunsets",
// which is exactly what happened.
//
// It has not cost anything yet, and that is worth stating rather than
// implying: the Capacitor Android build is not shipped, so the only rows with
// `platform = 'android'` would be from a test device. This is a fix ahead of a
// launch rather than a repair after an outage — which is also why the parts
// that can be got wrong quietly are the parts tested here.
//
// ── WHAT V1 CHANGES, BEYOND THE URL ───────────────────────────────────────
//
// Three things, and only the first announces itself:
//
//   The auth is an OAuth2 access token minted by signing a JWT with the
//   service account's key, not a static header. Wrong, and everything 401s
//   loudly — this is the failure that cannot hide.
//
//   `data` values must all be strings. `PushPayload.data` is
//   `Record<string, unknown>`, and legacy accepted whatever was in it, so a
//   caller passing a number or an object now poisons the WHOLE send with
//   INVALID_ARGUMENT — not just that key. Nothing in the app passes a
//   non-string today, which is precisely why a future caller would not find
//   out until a device did not buzz.
//
//   `tag`, `icon` and `click_action` moved under `android.notification`. A
//   dropped `tag` is the quiet one: tag is what collapses repeats on the
//   device, so losing it turns one updating notification into twelve rows in
//   a technician's shade over a morning.
//
// ── WHAT THIS FILE CANNOT CHECK ───────────────────────────────────────────
//
// That a real FCM project accepts the message. There is no service account in
// this environment and this test suite makes no network calls, so the wire
// format is asserted against Google's documented v1 schema rather than
// against Google. The first real send is still the first real proof.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  fcmDataStrings,
  fcmErrorIsGone,
  fcmMessageFor,
  parseFcmCredentials,
} from "@/lib/push.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Lazy. A read resolved in a describe body turns a missing file into an
// import-time throw, and vitest reports that as "no tests" — which reads as a
// pass. The mutation test for this file stashes src/.
const pushSrc = () => codeOnly(readFileSync(ROOT + "src/lib/push.server.ts", "utf8"));

/** Whole-line comments dropped. The file explains the migration it just made,
 *  quoting the dead endpoint and the retired variable by name, so a raw match
 *  finds the explanation as readily as a relapse. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

describe("the legacy endpoint is gone from the code, not just deprecated in a comment", () => {
  it("does not post to /fcm/send with a server key", () => {
    const src = pushSrc();
    expect(src).not.toMatch(/fcm\.googleapis\.com\/fcm\/send/);
    expect(src, "the legacy static server key is not an auth scheme any more").not.toMatch(
      /Authorization: `key=/,
    );
    expect(src).not.toMatch(/FCM_SERVER_KEY/);
  });

  it("posts to the v1 endpoint under the project the credential names", () => {
    // The project id comes from the service account rather than a separate
    // variable, so the two can never disagree.
    expect(pushSrc()).toMatch(
      /https:\/\/fcm\.googleapis\.com\/v1\/projects\/\$\{creds\.projectId\}\/messages:send/,
    );
    expect(pushSrc()).toMatch(/Authorization: `Bearer \$\{accessToken\}`/);
  });

  it("caches the access token instead of exchanging one per device", () => {
    // A fan-out to a crew of fifty would otherwise do fifty JWT signings and
    // fifty token exchanges for one notification.
    const src = pushSrc();
    expect(src).toMatch(
      /if \(fcmToken && Date\.now\(\) < fcmToken\.expiresAt\) return fcmToken\.value/,
    );
    // Expiring a minute early, so a token that dies in flight is not used.
    expect(src).toMatch(/\(ttl - 60\) \* 1000/);
  });

  it("lets a broken credential fail this channel only", () => {
    // Web and iOS go out in the same Promise.all. A throw here would take a
    // notification away from devices that had nothing wrong with them.
    const src = pushSrc();
    const fn = src.slice(src.indexOf("async function fcmAccessToken"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toMatch(/console\.error\("fcm token exchange failed"/);
    expect(fn.slice(0, fn.indexOf("\n}"))).not.toMatch(/throw /);
  });
});

describe("the credential is parsed, not trusted", () => {
  const good = JSON.stringify({
    project_id: "houndstack-app",
    client_email: "fcm@houndstack-app.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n",
  });

  it("reads the three fields it needs out of the Firebase JSON", () => {
    const c = parseFcmCredentials(good)!;
    expect(c.projectId).toBe("houndstack-app");
    expect(c.clientEmail).toBe("fcm@houndstack-app.iam.gserviceaccount.com");
  });

  it("un-escapes the newlines an env var puts in the private key", () => {
    // A PEM pasted into a .env arrives with literal backslash-n. Node's
    // createPrivateKey rejects that, and the error names neither the variable
    // nor the cause.
    const c = parseFcmCredentials(good)!;
    expect(c.privateKey).toContain("\n");
    expect(c.privateKey).not.toContain("\\n");
    expect(c.privateKey.startsWith("-----BEGIN PRIVATE KEY-----\n")).toBe(true);
  });

  it("returns null rather than throwing on absent or malformed JSON", () => {
    // Same contract as every other channel in this file: no credential means
    // the channel is skipped, not that the fan-out dies.
    expect(parseFcmCredentials(undefined)).toBeNull();
    expect(parseFcmCredentials("")).toBeNull();
    expect(parseFcmCredentials("not json")).toBeNull();
    expect(parseFcmCredentials("{}")).toBeNull();
    expect(parseFcmCredentials(JSON.stringify({ project_id: "x", client_email: "y" }))).toBeNull();
  });
});

describe("data survives the v1 string rule", () => {
  it("stringifies what would otherwise reject the whole message", () => {
    // INVALID_ARGUMENT on a v1 send is for the message, not the key — one
    // number in `data` costs the notification.
    const out = fcmDataStrings({ count: 3, urgent: true, visit: { id: "v1" } });
    expect(out).toEqual({ count: "3", urgent: "true", visit: '{"id":"v1"}' });
  });

  it("drops null and undefined instead of sending the words", () => {
    // `{ tech: null }` arriving on the device as the string "null" is worse
    // than the key being absent, because the receiver cannot tell.
    expect(fcmDataStrings({ a: null, b: undefined, c: "keep" })).toEqual({ c: "keep" });
  });

  it("handles no data at all", () => {
    expect(fcmDataStrings(undefined)).toEqual({});
  });
});

describe("the message keeps what the device needs", () => {
  const payload = {
    title: "Visit complete",
    body: "3 of 8 done",
    url: "/my-day",
    tag: "route-progress",
    icon: "/pwa-192.png",
    data: { visitId: "abc" },
  };

  it("puts tag under android.notification, where v1 moved it", () => {
    // Tag collapses repeats. Dropped, a morning of progress updates is twelve
    // rows in the shade instead of one.
    const m = fcmMessageFor("tok", payload);
    expect(m.message.android.notification.tag).toBe("route-progress");
  });

  it("never sends a web icon URL as an Android drawable name", () => {
    // `icon` is shared with web push, where it is a URL. Android reads it as
    // a drawable resource name; a URL names nothing and the device logs a
    // miss. Omitted, the manifest's monochrome default is used.
    const m = fcmMessageFor("tok", payload);
    expect(m.message.android.notification.icon).toBeUndefined();
    const named = fcmMessageFor("tok", { ...payload, icon: "ic_stat_notification" });
    expect(named.message.android.notification.icon).toBe("ic_stat_notification");
  });

  it("does not send click_action, which made every linked notification untappable", () => {
    // "FCM_PLUGIN_ACTIVITY" is a cordova-plugin-fcm intent action no activity
    // in this app declares, so a tap resolved to nothing. Without it the tap
    // launches MainActivity and Capacitor routes the url from data.
    const m = fcmMessageFor("tok", payload);
    expect(m.message.android.notification).not.toHaveProperty("click_action");
    expect(JSON.stringify(m)).not.toContain("FCM_PLUGIN_ACTIVITY");
  });

  it("carries the url in data, which is what routes the tap", () => {
    const m = fcmMessageFor("tok", payload);
    expect(m.message.data.url).toBe("/my-day");
    expect(m.message.data.visitId).toBe("abc");
    expect(m.message.token).toBe("tok");
  });

  it("keeps title and body where a notification tray reads them", () => {
    const m = fcmMessageFor("tok", payload);
    expect(m.message.notification).toEqual({ title: "Visit complete", body: "3 of 8 done" });
  });

  it("omits the android fields it has no value for rather than sending empties", () => {
    // `tag: ""` is not the same as no tag: an empty tag collapses every
    // notification in the app into one.
    const m = fcmMessageFor("tok", { title: "Hi" });
    expect(m.message.android.notification).toEqual({});
    expect(m.message.notification.body).toBe("");
    expect(m.message.data).toEqual({ url: "" });
  });
});

describe("a dead token is retired and a busy server is not", () => {
  it("treats UNREGISTERED and a 404 as gone", () => {
    expect(fcmErrorIsGone(404, {})).toBe(true);
    expect(
      fcmErrorIsGone(400, {
        error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "UNREGISTERED" }] },
      }),
    ).toBe(true);
    expect(fcmErrorIsGone(400, { error: { status: "NOT_FOUND" } })).toBe(true);
  });

  it("leaves a rate limit or an outage enabled", () => {
    // Disabling a subscription on a 429 or a 503 would silently unsubscribe a
    // working device because Google was busy for a minute.
    expect(fcmErrorIsGone(429, { error: { status: "RESOURCE_EXHAUSTED" } })).toBe(false);
    expect(fcmErrorIsGone(503, { error: { status: "UNAVAILABLE" } })).toBe(false);
    expect(fcmErrorIsGone(500, {})).toBe(false);
    expect(fcmErrorIsGone(401, { error: { status: "UNAUTHENTICATED" } })).toBe(false);
  });
});
