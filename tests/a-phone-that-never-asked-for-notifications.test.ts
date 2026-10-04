// The owner signed in on iOS and never saw the notifications prompt.
//
// TestFlight build from main c1b4562b, 2026-10-04: a business account signed
// in, no "Allow notifications" prompt appeared, nothing in the app could bring
// it up, and production push_subscriptions had 0 rows. Two explanations fit
// and nothing could tell them apart:
//
//   (a) iOS already held an answer. It asks once per install; after that
//       requestPermissions() is a silent no-op and the way back is Settings.
//   (b) Something in the signed-in shell's start-up threw before the prompt,
//       into a `catch { /* ignore */ }`.
//
// So this file pins three things. Failure is visible: every branch that ends
// without a token says so to monitoring (once, at the right level), and the
// shell no longer swallows a throw. There is ONE path to a saved token, shared
// by the shell and the Preferences button. And the test push a person can send
// themselves cannot be pointed at anybody else.
//
// What it cannot check: that iOS shows the prompt, that Settings opens, or
// that a push arrives. Those need a signed build on a phone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const h = vi.hoisted(() => ({
  native: true,
  platform: "ios" as "ios" | "android" | "web",
  fcm: false,
  check: "prompt" as string,
  request: "granted" as string,
  calls: [] as string[],
  listeners: {} as Record<string, (arg: any) => void>,
  saved: [] as any[],
  saveError: null as Error | null,
  issues: [] as Array<{ message: string; tags: Record<string, string>; level?: string }>,
  errors: [] as Array<{ error: unknown; tags: Record<string, string> }>,
  pushedTo: [] as Array<{ userId: string; payload: any }>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => h.native, getPlatform: () => h.platform },
}));

vi.mock("@/lib/native-build", () => ({
  get FCM_CONFIGURED() {
    return h.fcm;
  },
}));

vi.mock("@capacitor/push-notifications", () => {
  h.calls.push("import");
  return {
    PushNotifications: {
      checkPermissions: async () => {
        h.calls.push("checkPermissions");
        return { receive: h.check };
      },
      requestPermissions: async () => {
        h.calls.push("requestPermissions");
        return { receive: h.request };
      },
      addListener: async (name: string, cb: (arg: any) => void) => {
        h.calls.push(`addListener:${name}`);
        h.listeners[name] = cb;
        return { remove: async () => h.calls.push(`remove:${name}`) };
      },
      createChannel: async () => h.calls.push("createChannel"),
      register: async () => h.calls.push("register"),
    },
  };
});

vi.mock("@/lib/monitoring/client", () => ({
  reportClientIssue: (message: string, tags: Record<string, string>, level?: string) =>
    h.issues.push({ message, tags, level }),
  reportClientError: (error: unknown, tags: Record<string, string>) =>
    h.errors.push({ error, tags }),
}));

// The server-function module, as the device sees it: the save the shell and
// the button both end in, and the test push, run through a fake createServerFn
// that hands the handler whatever context the call supplies.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown; context?: unknown } = {}) => {
          // The native save is replaced below; everything else runs for real.
          return fn({ data: validate(opts.data), context: opts.context ?? {} });
        },
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/push.server", () => ({
  sendPushToUser: async (userId: string, payload: any) => {
    h.pushedTo.push({ userId, payload });
    return { sent: 1, failed: 0 };
  },
}));

async function loadNative() {
  // subscribeStaffNativePush talks to Supabase for real; on the device side
  // what matters is that it is the function called, with what.
  vi.doMock("@/lib/push.functions", async (orig) => ({
    ...(await orig<typeof import("@/lib/push.functions")>()),
    subscribeStaffNativePush: async (opts: { data: unknown }) => {
      if (h.saveError) throw h.saveError;
      h.saved.push(opts.data);
      return { ok: true };
    },
  }));
  const native = await import("@/lib/native");
  native.resetPushReportingForTests();
  return native;
}

const TOKEN = "f00dfeed".repeat(8);

beforeEach(() => {
  h.native = true;
  h.platform = "ios";
  h.fcm = false;
  h.check = "prompt";
  h.request = "granted";
  h.calls = [];
  h.listeners = {};
  h.saved = [];
  h.saveError = null;
  h.issues = [];
  h.errors = [];
  h.pushedTo = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.doUnmock("@/lib/push.functions");
  vi.resetModules();
});

// ── the shared helper ─────────────────────────────────────────────────────

describe("turnOnPushNotifications", () => {
  it("prompt, then granted: asks, listens, registers, saves the token, reports nothing", async () => {
    const native = await loadNative();
    const { permission, cleanup } = await native.turnOnPushNotifications();
    expect(permission).toBe("granted");
    expect(h.calls.filter((c) => c !== "import")).toEqual([
      "checkPermissions",
      "requestPermissions",
      "addListener:registration",
      "addListener:registrationError",
      "register",
    ]);

    h.listeners.registration({ value: TOKEN });
    await vi.waitFor(() => expect(h.saved).toHaveLength(1));
    expect(h.saved[0]).toMatchObject({ token: TOKEN, platform: "ios" });
    expect(typeof h.saved[0].userAgent).toBe("string");
    // The working path is every launch of every working phone: never sent.
    expect(h.issues).toEqual([]);
    expect(h.errors).toEqual([]);

    cleanup();
    expect(h.calls).toContain("remove:registration");
    expect(h.calls).toContain("remove:registrationError");
  });

  it("prompt, then denied: no register, and one warning that says the prompt WAS shown", async () => {
    h.request = "denied";
    const native = await loadNative();
    const { permission } = await native.turnOnPushNotifications();
    expect(permission).toBe("denied");
    expect(h.calls).toContain("requestPermissions");
    expect(h.calls).not.toContain("register");
    expect(h.calls).not.toContain("addListener:registration");
    expect(h.issues).toEqual([
      {
        message: "Push permission not granted",
        tags: {
          area: "native_push",
          step: "permission",
          push_permission: "denied",
          push_prompt: "asked",
        },
        level: "warning",
      },
    ]);

    // Once per launch: the shell remounts and the button can run it again.
    await native.turnOnPushNotifications();
    await native.registerPushNotifications(() => {});
    expect(h.issues).toHaveLength(1);
  });

  it("already denied: does not ask (iOS would not show it), and says the prompt was NOT shown", async () => {
    h.check = "denied";
    const native = await loadNative();
    const { permission } = await native.turnOnPushNotifications();
    expect(permission).toBe("denied");
    expect(h.calls).not.toContain("requestPermissions");
    expect(h.calls).not.toContain("register");
    expect(h.issues).toHaveLength(1);
    expect(h.issues[0].tags).toMatchObject({ push_permission: "denied", push_prompt: "not_asked" });
    expect(h.issues[0].level).toBe("warning");
  });

  it("a registrationError from APNs is reported as an error, with its message", async () => {
    const native = await loadNative();
    await native.turnOnPushNotifications();
    const apns = "no valid 'aps-environment' entitlement string found for application";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.listeners.registrationError({ error: apns });
    await vi.waitFor(() => expect(h.issues).toHaveLength(1));
    expect(h.issues[0]).toEqual({
      message: `Push registration failed: ${apns}`,
      tags: { area: "native_push", step: "registration_error" },
      level: "error",
    });
    warn.mockRestore();
  });

  it("android without a Firebase config: unavailable, and the plugin is never touched", async () => {
    h.platform = "android";
    h.fcm = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const native = await loadNative();
    const { permission } = await native.turnOnPushNotifications();
    expect(permission).toBe("unavailable");
    expect(await native.getPushPermission()).toBe("unavailable");
    // Not checkPermissions, not requestPermissions, and above all not
    // register(), which kills the process on such a build.
    expect(h.calls.filter((c) => c !== "import")).toEqual([]);
    expect(h.issues).toEqual([]);
    warn.mockRestore();
  });

  it("android WITH a Firebase config makes the channel before it registers", async () => {
    h.platform = "android";
    h.fcm = true;
    const native = await loadNative();
    await native.turnOnPushNotifications();
    h.listeners.registration({ value: TOKEN });
    await vi.waitFor(() => expect(h.saved).toHaveLength(1));
    expect(h.saved[0].platform).toBe("android");
    expect(h.calls.indexOf("createChannel")).toBeLessThan(h.calls.indexOf("register"));
  });

  it("a token the server would not keep is reported, not left on the console", async () => {
    h.saveError = new Error("Not authorized");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const native = await loadNative();
    await native.turnOnPushNotifications();
    h.listeners.registration({ value: TOKEN });
    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    expect(h.errors[0].error).toBe(h.saveError);
    expect(h.errors[0].tags).toEqual({ area: "native_push", step: "save_token" });
    warn.mockRestore();
  });

  it("a token arriving after the shell unmounted is not saved", async () => {
    const native = await loadNative();
    let cancelled = false;
    await native.turnOnPushNotifications({ isCancelled: () => cancelled });
    cancelled = true;
    h.listeners.registration({ value: TOKEN });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.saved).toEqual([]);
  });

  it("a second call replaces the first one's listeners, so a token is saved once", async () => {
    h.check = "granted";
    const native = await loadNative();
    await native.turnOnPushNotifications();
    await native.turnOnPushNotifications();
    expect(h.calls.filter((c) => c === "remove:registration")).toHaveLength(1);
  });
});

describe("getPushPermission", () => {
  it("reads without asking, folds Android's second chance into prompt, and is null on web", async () => {
    const native = await loadNative();
    h.check = "prompt-with-rationale";
    expect(await native.getPushPermission()).toBe("prompt");
    h.check = "granted";
    expect(await native.getPushPermission()).toBe("granted");
    h.check = "denied";
    expect(await native.getPushPermission()).toBe("denied");
    expect(h.calls).not.toContain("requestPermissions");
    h.native = false;
    expect(await native.getPushPermission()).toBeNull();
  });
});

describe("openAppNotificationSettings", () => {
  it("navigates to app-settings: on iOS, which Capacitor hands to UIApplication.open", async () => {
    const location = { href: "capacitor://localhost/settings/preferences" };
    vi.stubGlobal("window", { location });
    const native = await loadNative();
    expect(native.openAppNotificationSettings()).toBe(true);
    expect(location.href).toBe("app-settings:");
  });

  it("does nothing on Android or the web", async () => {
    const location = { href: "x" };
    vi.stubGlobal("window", { location });
    const native = await loadNative();
    h.platform = "android";
    expect(native.openAppNotificationSettings()).toBe(false);
    h.native = false;
    expect(native.openAppNotificationSettings()).toBe(false);
    expect(location.href).toBe("x");
  });

  // The claim the helper rests on, checked against the Capacitor actually
  // installed rather than remembered: a top-level navigation to an origin
  // that is not the app's goes to UIApplication.shared.open.
  it("the installed Capacitor still hands foreign navigations to the system", () => {
    const swift = read(
      "node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift",
    );
    const decide = swift.slice(swift.indexOf("decidePolicyFor navigationAction"));
    expect(decide).toMatch(/if !isApplicationNavigation, toplevelNavigation \{/);
    expect(decide).toMatch(/UIApplication\.shared\.open\(navURL/);
  });
});

// ── one path, and nothing swallowed ───────────────────────────────────────

describe("the shell and the Preferences button take the same path", () => {
  it("both call turnOnPushNotifications; only native.ts calls subscribeStaffNativePush", () => {
    const shell = codeOnly(read("src/routes/_authenticated/route.tsx"));
    const card = codeOnly(read("src/components/settings/NativePushCard.tsx"));
    expect(shell).toMatch(/turnOnPushNotifications\(/);
    expect(card).toMatch(/turnOnPushNotifications\(/);
    expect(shell).not.toMatch(/subscribeStaffNativePush/);
    expect(card).not.toMatch(/subscribeStaffNativePush/);
    expect(codeOnly(read("src/lib/native.ts"))).toMatch(/subscribeStaffNativePush\(/);
  });

  it("the shell's native start-up reports what it catches", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    // Line comments out (the history is told in one), block comments kept,
    // because `catch { /* ignore */ }` is exactly the thing being looked for.
    const effect = src
      .slice(src.indexOf("Native Capacitor bootstrap"), src.indexOf("}, [router]);"))
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(effect).not.toMatch(/catch\s*(\(\w*\))?\s*\{\s*(\/\*[^*]*\*\/)?\s*\}/);
    expect(effect).toMatch(/reportClientError\(e, \{ area: "native_startup", step: name \}\)/);
    for (const step of ["status_bar", "connectivity", "push_deep_links", "push_registration"]) {
      expect(effect).toContain(`"${step}"`);
    }
  });

  it("the card renders nothing on the web, where PushToggle is the control", () => {
    const card = codeOnly(read("src/components/settings/NativePushCard.tsx"));
    expect(card).toMatch(/if \(!native\) return null;/);
  });
});

// ── the test push ─────────────────────────────────────────────────────────

describe("sendMyselfTestPush", () => {
  const words = { title: "Test notification", body: "If you can read this, it works." };

  async function load() {
    vi.doUnmock("@/lib/push.functions");
    const fns = await import("@/lib/push.functions");
    fns.resetTestPushLimitForTests();
    return fns;
  }

  it("sends to the caller and nobody else, and says how many devices it reached", async () => {
    const { sendMyselfTestPush } = await load();
    const r = await (sendMyselfTestPush as any)({
      data: words,
      context: { userId: "owner-1" },
    });
    expect(r).toEqual({ ok: true, sent: 1, failed: 0 });
    expect(h.pushedTo).toHaveLength(1);
    expect(h.pushedTo[0].userId).toBe("owner-1");
    expect(h.pushedTo[0].payload).toMatchObject(words);
  });

  it("has no way to name a recipient: any extra field is refused before anything is sent", async () => {
    const { sendMyselfTestPush } = await load();
    for (const extra of [
      { userId: "tech-2" },
      { user_id: "tech-2" },
      { organizationId: "org-2" },
      { token: TOKEN },
      { endpoint: "https://push.example/x" },
    ]) {
      expect(() =>
        (sendMyselfTestPush as any)({
          data: { ...words, ...extra },
          context: { userId: "owner-1" },
        }),
      ).toThrow();
    }
    expect(h.pushedTo).toEqual([]);
  });

  it("once per 30 seconds per person", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
    const { sendMyselfTestPush, TEST_PUSH_INTERVAL_MS } = await load();
    const call = (userId: string) =>
      (sendMyselfTestPush as any)({ data: words, context: { userId } });

    expect((await call("owner-1")).ok).toBe(true);
    vi.setSystemTime(new Date(Date.now() + 10_000));
    expect(await call("owner-1")).toEqual({ ok: false, reason: "too_soon", retryAfterSeconds: 20 });
    // Somebody else's limit is their own.
    expect((await call("tech-2")).ok).toBe(true);
    vi.setSystemTime(new Date(Date.now() + TEST_PUSH_INTERVAL_MS));
    expect((await call("owner-1")).ok).toBe(true);
    expect(h.pushedTo.map((p) => p.userId)).toEqual(["owner-1", "tech-2", "owner-1"]);
  });
});
