// Four items from the native round-2 audit, each with its own describe:
//
//   R2-28  android-r2-01  Android, system dark mode: dark status-bar icons on
//                         a dark band after sign-in. Acceptance: clock
//                         contrast >= 4.5:1 on /dashboard and /my-day.
//   R2-36  ios-r2-04      the completion photo was camera-only.
//   R2-53  android-r2-09  "Back online · 1 pending" while every request failed.
//   R2-54  android-r2-10  location-denied guidance in iOS words, with no way
//                         to Settings on Android.
//
// What a unit test cannot prove, and is listed on the PR for a device: the
// band's colour as actually composited by Android 15+ behind the clock, the
// native photo sheet, and the Settings page opening.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  native: true,
  platform: "android" as "ios" | "android" | "web",
  calls: [] as Array<[string, unknown]>,
  bridgeFails: false,
  photo: null as null | Record<string, unknown>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => h.native, getPlatform: () => h.platform },
  registerPlugin: (name: string) => {
    h.calls.push(["registerPlugin", name]);
    return {
      setSystemBarBackground: async (o: unknown) => {
        if (h.bridgeFails) throw new Error("not implemented");
        h.calls.push(["setSystemBarBackground", o]);
      },
      openAppSettings: async () => {
        h.calls.push(["openAppSettings", null]);
      },
    };
  },
}));

vi.mock("@capacitor/status-bar", () => ({
  Style: { Dark: "DARK", Light: "LIGHT", Default: "DEFAULT" },
  StatusBar: {
    setStyle: async (o: unknown) => h.calls.push(["setStyle", o]),
    setBackgroundColor: async (o: unknown) => h.calls.push(["setBackgroundColor", o]),
  },
}));

vi.mock("@capacitor/camera", () => ({
  CameraResultType: { Uri: "uri" },
  CameraSource: { Prompt: "PROMPT", Camera: "CAMERA", Photos: "PHOTOS" },
  Camera: {
    getPhoto: async (o: Record<string, unknown>) => {
      h.photo = o;
      return { webPath: undefined };
    },
  },
}));

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// No DOM in this suite's environment: the two things the code reads are the
// class list on <html> and window's events and location.
const classes = new Set<string>();
const attrs = new Map<string, string>();
const fakeWindow = Object.assign(new EventTarget(), { location: { href: "" } });
vi.stubGlobal("document", {
  documentElement: {
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    // lib/i18n sets lang and dir on <html> when the language changes.
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => attrs.set(k, v),
  },
});
vi.stubGlobal("window", fakeWindow);

beforeEach(() => {
  h.native = true;
  h.platform = "android";
  h.calls = [];
  h.bridgeFails = false;
  h.photo = null;
  document.documentElement.classList.remove("dark");
});
afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("R2-28: the clock is readable on Android in either theme", () => {
  it("the icons the app asks for clear 4.5:1 on the band it paints, light and dark", async () => {
    const { statusBarChrome } = await import("@/lib/native");
    for (const dark of [false, true]) {
      const c = statusBarChrome(dark);
      expect(contrast(c.icons, c.band), `dark=${dark}`).toBeGreaterThanOrEqual(4.5);
      // Capacitor names the style after the content: DARK = light icons.
      expect(c.style).toBe(dark ? "DARK" : "LIGHT");
    }
  });

  it("the band is the app's own background, so the page and the band are one colour", async () => {
    const { statusBarChrome } = await import("@/lib/native");
    const css = read("src/styles.css");
    // :root --background is oklch(1 0 0), white.
    expect(css).toMatch(/:root \{[^}]*--background: oklch\(1 0 0\)/);
    expect(statusBarChrome(false).band).toBe("#FFFFFF");
    // .dark --background is slate-950, oklch(0.129 0.042 264.695) = #020617.
    expect(css).toMatch(/\.dark \{[^}]*--background: oklch\(0\.129 0\.042 264\.695\)/);
    expect(statusBarChrome(true).band).toBe("#020617");
  });

  it("a light app on Android paints a light band behind dark icons, through the app's bridge", async () => {
    const { initStatusBar } = await import("@/lib/native");
    await initStatusBar();
    expect(h.calls).toContainEqual(["setStyle", { style: "LIGHT" }]);
    expect(h.calls).toContainEqual(["setSystemBarBackground", { color: "#FFFFFF" }]);
  });

  it("a dark app paints a dark band behind light icons", async () => {
    document.documentElement.classList.add("dark");
    const { initStatusBar } = await import("@/lib/native");
    await initStatusBar();
    expect(h.calls).toContainEqual(["setStyle", { style: "DARK" }]);
    expect(h.calls).toContainEqual(["setSystemBarBackground", { color: "#020617" }]);
  });

  it("a binary without the bridge still sets the style and does not throw", async () => {
    h.bridgeFails = true;
    const { initStatusBar } = await import("@/lib/native");
    await expect(initStatusBar()).resolves.toBeUndefined();
    expect(h.calls).toContainEqual(["setStyle", { style: "LIGHT" }]);
  });

  it("iOS never reaches for the Android bridge", async () => {
    h.platform = "ios";
    const { initStatusBar } = await import("@/lib/native");
    await initStatusBar();
    expect(h.calls.map(([k]) => k)).not.toContain("setSystemBarBackground");
  });

  it("the status bar follows a theme change, not only the boot", async () => {
    const { followThemeWithStatusBar } = await import("@/lib/native");
    let fire: ((dark: boolean) => void) | null = null;
    const stop = followThemeWithStatusBar((cb) => {
      fire = cb;
      return () => {
        fire = null;
      };
    });
    document.documentElement.classList.add("dark");
    fire!(true);
    await vi.waitFor(() =>
      expect(h.calls).toContainEqual(["setSystemBarBackground", { color: "#020617" }]),
    );
    stop();
    expect(fire).toBeNull();
    expect(codeOnly(read("src/routes/__root.tsx"))).toMatch(
      /m\.followThemeWithStatusBar\(watchDarkTheme\)/,
    );
  });

  it("the plugin the JS registers is the one MainActivity registers, under the same name", () => {
    const dir = "android/app/src/main/java/consulting/thenorth/houndstack";
    const plugin = read(`${dir}/HoundStackNativePlugin.java`);
    expect(plugin).toMatch(/@CapacitorPlugin\(name = "HoundStackNative"\)/);
    expect(plugin).toMatch(/public void setSystemBarBackground\(PluginCall call\)/);
    expect(plugin).toMatch(/public void openAppSettings\(PluginCall call\)/);
    // The parent, which SystemBars pads and never repaints; not the decor view,
    // which SystemBars resets to the theme's windowBackground on every
    // configuration change.
    expect(plugin).toMatch(/getWebView\(\)\.getParent\(\)/);
    const main = codeOnly(read(`${dir}/MainActivity.java`));
    const reg = main.indexOf("registerPlugin(HoundStackNativePlugin.class)");
    expect(reg).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(main.indexOf("super.onCreate"));
    expect(codeOnly(read("src/lib/native.ts"))).toMatch(
      /registerPlugin<HoundStackNativePlugin>\("HoundStackNative"\)/,
    );
  });

  it("the window under the WebView is light from the first frame, not DayNight's black", () => {
    const xml = read("android/app/src/main/res/values/styles.xml");
    const at = xml.indexOf('<style name="AppTheme.NoActionBar"');
    const theme = xml.slice(at, xml.indexOf("</style>", at));
    expect(theme).toMatch(/<item name="android:windowBackground">@color\/appBackground<\/item>/);
    expect(theme).toMatch(/<item name="android:windowLightStatusBar">true<\/item>/);
    const colors = read("android/app/src/main/res/values/colors.xml");
    const m = colors.match(/<color name="appBackground">(#[0-9a-fA-F]{6})<\/color>/);
    expect(m).not.toBeNull();
    // Dark icons (the launch style) on it clear 4.5:1.
    expect(contrast("#000000", m![1])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the Android resources still parse", () => {
  it("no XML comment under android/app/src contains `--`, which aapt refuses", () => {
    // a2ba831 failed :app:mergeDebugResources on colors.xml:25 for exactly
    // this: a comment that named the CSS variable `--background`. XML does not
    // allow "--" inside a comment, and nothing short of Gradle reads these.
    const files = execFileSync("git", ["ls-files", "android/app/src/**/*.xml"], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const m of read(f).matchAll(/<!--([\s\S]*?)-->/g)) {
        expect(m[1], f).not.toContain("--");
      }
    }
  });
});

describe("R2-36: the completion photo can come from the library", () => {
  it("asks the native sheet for camera OR library, with translated labels", async () => {
    const i18n = (await import("@/lib/i18n")).default;
    await i18n.changeLanguage("es");
    try {
      const { takePhotoNative } = await import("@/lib/native");
      await takePhotoNative();
      expect(h.photo).toMatchObject({
        source: "PROMPT",
        promptLabelHeader: "Añadir una foto",
        promptLabelPhoto: "Elegir de la galería",
        promptLabelPicture: "Tomar foto",
        promptLabelCancel: i18n.t("common.cancel"),
      });
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("no caller sends a cancelled sheet on to a second picker", () => {
    // Prompt adds a Cancel button, so a cancel is now a normal answer.
    for (const f of [
      "src/routes/_authenticated/my-day.tsx",
      "src/lib/visit-step.ts",
      "src/components/VisitDetailDrawer.tsx",
    ]) {
      const src = codeOnly(read(f));
      const at = src.indexOf("takePhotoNative()");
      expect(at, f).toBeGreaterThan(-1);
      expect(src.slice(at, at + 900), f).toMatch(/\/cancel\/i\.test/);
    }
  });

  it("the source is not the camera alone any more", () => {
    expect(codeOnly(read("src/lib/native.ts"))).not.toMatch(/CameraSource\.Camera\b/);
  });
});

describe("R2-53: the connection line says what the last request did", () => {
  it("is honest in each state", async () => {
    const { connectionLine } = await import("@/lib/offline/last-request");
    expect(connectionLine({ online: false, pending: 0, lastOutcome: null })).toBe("offline");
    expect(connectionLine({ online: false, pending: 1, lastOutcome: "ok" })).toBe("offline");
    expect(connectionLine({ online: true, pending: 0, lastOutcome: "failed" })).toBeNull();
    // The bug: the phone has a network, the server does not answer.
    expect(connectionLine({ online: true, pending: 1, lastOutcome: "failed" })).toBe("unreachable");
    expect(connectionLine({ online: true, pending: 1, lastOutcome: "ok" })).toBe("online");
    expect(connectionLine({ online: true, pending: 1, lastOutcome: null })).toBe("online");
  });

  it("a field action that cannot reach the server records a failure; one that is answered records ok", async () => {
    const { runOrQueue } = await import("@/lib/offline/run-or-queue");
    const { lastRequestOutcome, __resetLastRequestOutcome, LAST_REQUEST_CHANGE } =
      await import("@/lib/offline/last-request");
    __resetLastRequestOutcome();
    let events = 0;
    const onEvent = () => events++;
    window.addEventListener(LAST_REQUEST_CHANGE, onEvent);
    try {
      await runOrQueue({
        online: true,
        label: "start",
        send: () => Promise.reject(new TypeError("Failed to fetch")),
        queue: async () => {},
      });
      expect(lastRequestOutcome()).toBe("failed");

      // A refusal is the server answering: it was reached.
      await expect(
        runOrQueue({
          online: true,
          label: "start",
          send: () => Promise.reject(new Error("visit already completed")),
          queue: async () => {},
        }),
      ).rejects.toThrow();
      expect(lastRequestOutcome()).toBe("ok");

      await runOrQueue({
        online: true,
        label: "start",
        send: () => Promise.reject(new TypeError("Failed to fetch")),
        queue: async () => {},
      });
      await runOrQueue({
        online: true,
        label: "start",
        send: async () => 1,
        queue: async () => {},
      });
      expect(lastRequestOutcome()).toBe("ok");
      expect(events).toBe(4);
    } finally {
      window.removeEventListener(LAST_REQUEST_CHANGE, onEvent);
      __resetLastRequestOutcome();
    }
  });

  it("My Day's line reads it, and the replay and the day's load both report to it", () => {
    const myDay = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(myDay).toMatch(/connectionLine\(\{ online, pending, lastOutcome: lastRequest \}\)/);
    expect(myDay).toMatch(/connection === "unreachable"\s*\?\s*t\("common\.unreachable"\)/);
    expect(myDay).toMatch(/recordRequestOutcome\(isTransportFailure\(e\) \? "failed" : "ok"\)/);
    const sync = codeOnly(read("src/lib/offline/sync.ts"));
    expect(sync).toMatch(/recordRequestOutcome\("ok"\)/);
    expect(sync).toMatch(/recordRequestOutcome\(isTransportFailure\(e\) \? "failed" : "ok"\)/);
  });
});

describe("R2-54: location denied, in the platform's own words, with a way to Settings", () => {
  it("Android gets Android's steps, iOS keeps iOS's", async () => {
    const { nativeGeolocationErrorMessage } = await import("@/components/RouteMap");
    const android = nativeGeolocationErrorMessage("denied", "android");
    const ios = nativeGeolocationErrorMessage("denied", "ios");
    expect(android).toMatch(/Permissions › Location/);
    expect(android).toMatch(/Allow only while using the app/);
    expect(android).not.toMatch(/While Using the App|Location Services/);
    expect(ios).toMatch(/While Using the App/);
    for (const m of [android, ios]) expect(m).toMatch(/Open Settings/);
    expect(nativeGeolocationErrorMessage("timeout", "android")).not.toMatch(/Location Services/);
  });

  it("Open Settings goes through the bridge on Android and app-settings: on iOS", async () => {
    const { openAppSettings } = await import("@/lib/native");
    expect(await openAppSettings()).toBe(true);
    expect(h.calls).toContainEqual(["openAppSettings", null]);

    h.platform = "ios";
    h.calls = [];
    fakeWindow.location.href = "";
    expect(await openAppSettings()).toBe(true);
    expect(fakeWindow.location.href).toBe("app-settings:");
    expect(h.calls.map(([k]) => k)).not.toContain("openAppSettings");

    h.native = false;
    expect(await openAppSettings()).toBe(false);
  });

  it("the map offers the button only for a native denial, and passes the platform", () => {
    const src = codeOnly(read("src/components/RouteMap.tsx"));
    expect(src).toMatch(
      /nativeGeolocationErrorMessage\(r\.reason, platform\(\) === "android" \? "android" : "ios"\)/,
    );
    expect(src).toMatch(/setGeoDenied\(r\.reason === "denied"\)/);
    expect(src).toMatch(
      /\{geoDenied && \([\s\S]{0,200}onClick=\{\(\) => void openAppSettings\(\)\}/,
    );
  });
});
