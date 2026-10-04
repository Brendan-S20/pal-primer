// Android notifications: the icon, the channel, and the tap.
//
// Three faults, none of which any build or web test can see, because each is
// a decision the OS makes on a device:
//
//   * ICON. With no default_notification_icon, Android uses the launcher icon
//     as the status-bar glyph and renders it from its alpha channel only. A
//     full-colour square icon becomes a solid white square.
//   * CHANNEL. From Android 8 every notification needs a channel. With none
//     named, Firebase invents one called "Miscellaneous", which is what a
//     technician would find, and have to guess at, in Settings.
//   * TAP. The server used to send click_action "FCM_PLUGIN_ACTIVITY", a
//     cordova-plugin-fcm convention no activity here declares, so every tap
//     on a notification carrying a link went nowhere. That half is pinned in
//     every-android-notification-went-to-a-decommissioned-endpoint.test.ts;
//     this file pins that nothing on the device side depends on it either.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const manifest = () =>
  read("android/app/src/main/AndroidManifest.xml").replace(/<!--[\s\S]*?-->/g, "");

const metaData = (name: string) => {
  const m = manifest().match(
    new RegExp(
      `<meta-data\\s+android:name="${name.replace(/\./g, "\\.")}"\\s+android:(resource|value)="([^"]+)"`,
    ),
  );
  return m?.[2] ?? null;
};

describe("the small icon is a monochrome drawable", () => {
  it("is named as FCM's default icon", () => {
    expect(metaData("com.google.firebase.messaging.default_notification_icon")).toBe(
      "@drawable/ic_stat_notification",
    );
    expect(metaData("com.google.firebase.messaging.default_notification_color")).toBe(
      "@color/notificationAccent",
    );
    expect(read("android/app/src/main/res/values/colors.xml")).toMatch(
      /<color name="notificationAccent">#[0-9a-fA-F]{6}<\/color>/,
    );
  });

  it("draws in white only, because the status bar keeps nothing else", () => {
    const icon = read("android/app/src/main/res/drawable/ic_stat_notification.xml");
    expect(icon).toContain("<vector");
    const fills = [...icon.matchAll(/android:fillColor="([^"]+)"/g)].map((m) => m[1].toUpperCase());
    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) expect(["#FFFFFF", "#FFFFFFFF"]).toContain(f);
    // No bitmap, no gradient: either one would be flattened to a blob.
    expect(icon).not.toMatch(/<bitmap|<gradient|android:src=/);
  });
});

describe("push arrives on a channel the app named", () => {
  it("points FCM at the same channel id the app creates", async () => {
    const strings = read("android/app/src/main/res/values/strings.xml");
    const id = strings.match(/<string name="default_notification_channel_id"[^>]*>([^<]+)</)?.[1];
    expect(metaData("com.google.firebase.messaging.default_notification_channel_id")).toBe(
      "@string/default_notification_channel_id",
    );
    const { ANDROID_PUSH_CHANNEL } = await import("@/lib/native");
    expect(id).toBe(ANDROID_PUSH_CHANNEL.id);
  });

  it("creates the channel before registering, on Android, once permission is granted", async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock("@capacitor/core", () => ({
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
    }));
    vi.doMock("@/lib/native-build", () => ({ FCM_CONFIGURED: true, IS_NATIVE_BUNDLE: true }));
    vi.doMock("@capacitor/push-notifications", () => ({
      PushNotifications: {
        requestPermissions: async () => ({ receive: "granted" }),
        createChannel: async (c: { id: string }) => void calls.push(`channel:${c.id}`),
        register: async () => void calls.push("register"),
        addListener: async () => ({ remove: async () => {} }),
      },
    }));
    try {
      const { registerPushNotifications } = await import("@/lib/native");
      await registerPushNotifications(() => {});
      expect(calls).toEqual(["channel:general", "register"]);
    } finally {
      vi.doUnmock("@capacitor/core");
      vi.doUnmock("@/lib/native-build");
      vi.doUnmock("@capacitor/push-notifications");
      vi.resetModules();
    }
  });

  it("still refuses to register without a Firebase config, which would crash", async () => {
    vi.resetModules();
    const register = vi.fn();
    vi.doMock("@capacitor/core", () => ({
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
    }));
    vi.doMock("@/lib/native-build", () => ({ FCM_CONFIGURED: false, IS_NATIVE_BUNDLE: true }));
    vi.doMock("@capacitor/push-notifications", () => ({
      PushNotifications: { requestPermissions: vi.fn(), createChannel: vi.fn(), register },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { registerPushNotifications } = await import("@/lib/native");
      await registerPushNotifications(() => {});
      expect(register).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.doUnmock("@capacitor/core");
      vi.doUnmock("@/lib/native-build");
      vi.doUnmock("@capacitor/push-notifications");
      vi.resetModules();
    }
  });
});

describe("a tap is routed by the app, not by an intent action", () => {
  it("declares no FCM_PLUGIN_ACTIVITY filter for the server to depend on", () => {
    // If one reappears, someone is re-adding click_action server-side; the
    // Capacitor path (launch intent -> pushNotificationActionPerformed ->
    // initPushDeepLinks) does not need it.
    expect(manifest()).not.toContain("FCM_PLUGIN_ACTIVITY");
    expect(read("src/lib/push.server.ts").replace(/^\s*\/\/.*$/gm, "")).not.toContain(
      "FCM_PLUGIN_ACTIVITY",
    );
  });
});
