// The app-rating prompt (issue #508): when HoundStack may ask a person to rate
// the app in the App Store or Google Play. Every rule is in the pure function
// in src/lib/rating-prompt.ts, so every rule is a case here, boundaries
// included. The second half drives the native wrapper with the plugins faked.
//
// What this cannot check: whether a sheet appears. Apple shows it at most
// three times a year and may show nothing; Google applies its own quota; in a
// development build from Xcode the sheet always shows and in TestFlight it
// never does. Neither store says what happened.
/* eslint-disable @typescript-eslint/no-explicit-any -- fakes of plugin and server-fn shapes */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATING_PROMPT_CAP_DAYS,
  isCalmPath,
  isRatingPromptEligible,
  isTestAccountEmail,
  parseRatingPromptState,
  ratingPromptKey,
  ratingPromptTrigger,
  withinRatingPromptCap,
  type RatingPromptInput,
} from "@/lib/rating-prompt";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

const owner = (over: Partial<RatingPromptInput> = {}): RatingPromptInput => ({
  platform: "ios",
  isNative: true,
  role: "owner",
  paidInvoiceCount: 1,
  completedVisitCount: 0,
  sessions: 2,
  lastPromptedAt: null,
  lastPromptedVersion: null,
  appVersion: "1.1.0",
  now: NOW,
  isTestAccount: false,
  onCalmScreen: true,
  ...over,
});

const tech = (over: Partial<RatingPromptInput> = {}) =>
  owner({ role: "tech", paidInvoiceCount: 0, completedVisitCount: 10, ...over });

describe("the two positive moments", () => {
  it("an owner after the business's first paid invoice", () => {
    expect(isRatingPromptEligible(owner())).toBe(true);
    expect(ratingPromptTrigger(owner())).toBe("first_paid_invoice");
  });

  it("an office manager and a dispatcher the same way", () => {
    expect(isRatingPromptEligible(owner({ role: "office_manager" }))).toBe(true);
    expect(isRatingPromptEligible(owner({ role: "dispatcher" }))).toBe(true);
  });

  it("0 paid invoices is not yet; 1 is", () => {
    expect(isRatingPromptEligible(owner({ paidInvoiceCount: 0 }))).toBe(false);
    expect(ratingPromptTrigger(owner({ paidInvoiceCount: 0 }))).toBeNull();
    expect(isRatingPromptEligible(owner({ paidInvoiceCount: 1 }))).toBe(true);
  });

  it("a technician after their tenth completed visit: 9 is not, 10 is", () => {
    expect(isRatingPromptEligible(tech({ completedVisitCount: 9 }))).toBe(false);
    expect(ratingPromptTrigger(tech({ completedVisitCount: 9 }))).toBeNull();
    expect(isRatingPromptEligible(tech({ completedVisitCount: 10 }))).toBe(true);
    expect(ratingPromptTrigger(tech({ completedVisitCount: 10 }))).toBe("tenth_completed_visit");
  });

  it("each role is judged on its own moment, not the other's", () => {
    expect(isRatingPromptEligible(owner({ paidInvoiceCount: 0, completedVisitCount: 50 }))).toBe(
      false,
    );
    expect(isRatingPromptEligible(tech({ completedVisitCount: 0, paidInvoiceCount: 50 }))).toBe(
      false,
    );
  });

  it("any other role, or none, never", () => {
    for (const role of ["platform_admin", "accountant", "", null]) {
      expect(
        isRatingPromptEligible(owner({ role, paidInvoiceCount: 99, completedVisitCount: 99 })),
      ).toBe(false);
    }
  });
});

describe("never ask", () => {
  it("not on the web", () => {
    expect(isRatingPromptEligible(owner({ platform: "web", isNative: false }))).toBe(false);
  });

  it("not in the PWA, or anywhere Capacitor says it is not native", () => {
    expect(isRatingPromptEligible(owner({ isNative: false }))).toBe(false);
  });

  it("not on a platform that is neither iOS nor Android", () => {
    expect(isRatingPromptEligible(owner({ platform: "electron" }))).toBe(false);
  });

  it("Android is asked the same as iOS", () => {
    expect(isRatingPromptEligible(owner({ platform: "android" }))).toBe(true);
  });

  it("not in the first session; from the second", () => {
    expect(isRatingPromptEligible(owner({ sessions: 0 }))).toBe(false);
    expect(isRatingPromptEligible(owner({ sessions: 1 }))).toBe(false);
    expect(isRatingPromptEligible(owner({ sessions: 2 }))).toBe(true);
  });

  it("not for an @demo.test account", () => {
    expect(isRatingPromptEligible(owner({ isTestAccount: true }))).toBe(false);
    expect(isRatingPromptEligible(tech({ isTestAccount: true }))).toBe(false);
  });

  it("not off a calm screen", () => {
    expect(isRatingPromptEligible(owner({ onCalmScreen: false }))).toBe(false);
  });

  it("not without an app version, since the version cap could not hold", () => {
    expect(isRatingPromptEligible(owner({ appVersion: "" }))).toBe(false);
  });
});

describe("our cap: once per 120 days, once per version", () => {
  it("is 120 days", () => {
    expect(RATING_PROMPT_CAP_DAYS).toBe(120);
  });

  it("day 119 is still capped; day 120 is free", () => {
    const base = { appVersion: "1.2.0", lastPromptedVersion: "1.1.0" };
    expect(isRatingPromptEligible(owner({ ...base, lastPromptedAt: NOW - 119 * DAY }))).toBe(false);
    expect(isRatingPromptEligible(owner({ ...base, lastPromptedAt: NOW - 120 * DAY }))).toBe(true);
  });

  it("the boundary is elapsed time to the millisecond", () => {
    expect(withinRatingPromptCap(NOW - 120 * DAY + 1, NOW)).toBe(true);
    expect(withinRatingPromptCap(NOW - 120 * DAY, NOW)).toBe(false);
    expect(withinRatingPromptCap(null, NOW)).toBe(false);
  });

  it("asked yesterday is capped", () => {
    expect(
      isRatingPromptEligible(
        owner({ lastPromptedAt: NOW - DAY, lastPromptedVersion: "1.0.0", appVersion: "1.1.0" }),
      ),
    ).toBe(false);
  });

  it("never again on a version that was already asked, however long ago", () => {
    expect(
      isRatingPromptEligible(
        owner({
          lastPromptedAt: NOW - 400 * DAY,
          lastPromptedVersion: "1.1.0",
          appVersion: "1.1.0",
        }),
      ),
    ).toBe(false);
  });

  it("a new version after the cap is asked again", () => {
    expect(
      isRatingPromptEligible(
        owner({
          lastPromptedAt: NOW - 400 * DAY,
          lastPromptedVersion: "1.0.0",
          appVersion: "1.1.0",
        }),
      ),
    ).toBe(true);
  });
});

describe("a calm screen", () => {
  it("the dashboard and the My Day list", () => {
    expect(isCalmPath("/dashboard")).toBe(true);
    expect(isCalmPath("/dashboard/")).toBe(true);
    expect(isCalmPath("/my-day")).toBe(true);
    expect(isCalmPath("/my-day", "?date=2026-10-18")).toBe(true);
    expect(isCalmPath("/my-day", "date=2026-10-18")).toBe(true);
  });

  it("not a visit open on My Day", () => {
    const visit = "?visit=0b6e2d1c-2f7a-4c8e-9d3a-1f2e3d4c5b6a";
    expect(isCalmPath("/my-day", visit)).toBe(false);
    expect(isCalmPath("/my-day", `${visit}&action=arrived`)).toBe(false);
  });

  it("never a payment flow, a visit detail, or anything else", () => {
    for (const p of [
      "/payments",
      "/pay/acme/abc123",
      "/invoices/0b6e2d1c",
      "/visits/0b6e2d1c",
      "/settings/billing",
      "/clients",
      "/",
      "/dashboard-old",
      "/my-day-extra",
    ]) {
      expect(isCalmPath(p)).toBe(false);
    }
  });
});

describe("isTestAccountEmail", () => {
  it("matches @demo.test whatever the case", () => {
    expect(isTestAccountEmail("owner@demo.test")).toBe(true);
    expect(isTestAccountEmail("Tech.One@DEMO.TEST")).toBe(true);
    expect(isTestAccountEmail(" owner@demo.test ")).toBe(true);
  });

  it("nothing else", () => {
    expect(isTestAccountEmail("owner@demo.testing.com")).toBe(false);
    expect(isTestAccountEmail("owner@example.com")).toBe(false);
    expect(isTestAccountEmail("demo.test@example.com")).toBe(false);
    expect(isTestAccountEmail("")).toBe(false);
    expect(isTestAccountEmail(null)).toBe(false);
    expect(isTestAccountEmail(undefined)).toBe(false);
  });
});

describe("what is stored on the device", () => {
  it("is keyed per person", () => {
    expect(ratingPromptKey("u-1")).toBe("rating_prompt:u-1");
  });

  it("reads back what was written, and forgives anything malformed", () => {
    expect(
      parseRatingPromptState(
        JSON.stringify({ lastPromptedAt: NOW, lastPromptedVersion: "1.1.0", sessions: 3 }),
      ),
    ).toEqual({ lastPromptedAt: NOW, lastPromptedVersion: "1.1.0", sessions: 3 });
    const empty = { lastPromptedAt: null, lastPromptedVersion: null, sessions: 0 };
    expect(parseRatingPromptState(null)).toEqual(empty);
    expect(parseRatingPromptState("not json")).toEqual(empty);
    expect(parseRatingPromptState("[]")).toEqual(empty);
    expect(parseRatingPromptState(JSON.stringify({ sessions: "two" }))).toEqual(empty);
  });
});

// ── THE NATIVE WRAPPER, WITH THE PLUGINS FAKED ─────────────────────────────

const h = vi.hoisted(() => ({
  native: true,
  platform: "ios" as string,
  version: "1.1.0",
  store: new Map<string, string>(),
  reviewCalls: 0,
  reviewError: null as Error | null,
  counts: { role: "owner", paidInvoiceCount: 1, completedVisitCount: 0, isTestAccount: false },
  countCalls: 0,
  listeners: {} as Record<string, (arg: any) => void>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => h.native, getPlatform: () => h.platform },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: h.store.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      h.store.set(key, value);
    },
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: async () => ({ version: h.version, build: "400", id: "x", name: "HoundStack" }),
    addListener: async (name: string, cb: (arg: any) => void) => {
      h.listeners[name] = cb;
      return { remove: async () => delete h.listeners[name] };
    },
  },
}));

vi.mock("@capacitor-community/in-app-review", () => ({
  InAppReview: {
    requestReview: async () => {
      h.reviewCalls++;
      if (h.reviewError) throw h.reviewError;
    },
  },
}));

vi.mock("@/lib/rating-prompt.functions", () => ({
  getRatingPromptCounts: async () => {
    h.countCalls++;
    return h.counts;
  },
}));

const USER = "user-1";
const calm = () => ({ pathname: "/dashboard", search: "" });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the native wrapper", () => {
  beforeEach(async () => {
    const m = await import("@/lib/rating-prompt-native");
    m.resetRatingPromptForTests();
    h.native = true;
    h.platform = "ios";
    h.version = "1.1.0";
    h.store.clear();
    h.reviewCalls = 0;
    h.reviewError = null;
    h.counts = { role: "owner", paidInvoiceCount: 1, completedVisitCount: 0, isTestAccount: false };
    h.countCalls = 0;
    h.listeners = {};
  });

  it("does nothing at all on the web", async () => {
    h.native = false;
    h.platform = "web";
    const m = await import("@/lib/rating-prompt-native");
    const stop = await m.startRatingPrompt(USER, calm);
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(false);
    stop();
    expect(h.reviewCalls).toBe(0);
    expect(h.countCalls).toBe(0);
    expect(h.store.size).toBe(0);
    expect(h.listeners.appStateChange).toBeUndefined();
  });

  it("counts a session once per launch, not per foreground", async () => {
    const m = await import("@/lib/rating-prompt-native");
    await m.countRatingPromptSession(USER);
    await m.countRatingPromptSession(USER);
    expect(parseRatingPromptState(h.store.get(ratingPromptKey(USER))).sessions).toBe(1);
  });

  it("does not ask in the first session, and spends no request finding that out", async () => {
    const m = await import("@/lib/rating-prompt-native");
    await m.startRatingPrompt(USER, calm);
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(false);
    expect(h.reviewCalls).toBe(0);
    expect(h.countCalls).toBe(0);
  });

  it("asks on the second launch, then stores when and on which version", async () => {
    h.store.set(ratingPromptKey(USER), JSON.stringify({ sessions: 1 }));
    const m = await import("@/lib/rating-prompt-native");
    await m.startRatingPrompt(USER, calm);
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(true);
    expect(h.reviewCalls).toBe(1);
    expect(parseRatingPromptState(h.store.get(ratingPromptKey(USER)))).toEqual({
      sessions: 2,
      lastPromptedAt: NOW,
      lastPromptedVersion: "1.1.0",
    });
  });

  it("asks when the app comes back to the foreground", async () => {
    h.store.set(ratingPromptKey(USER), JSON.stringify({ sessions: 1 }));
    const m = await import("@/lib/rating-prompt-native");
    await m.startRatingPrompt(USER, calm);
    h.listeners.appStateChange({ isActive: false });
    await settle();
    expect(h.reviewCalls).toBe(0);
    h.listeners.appStateChange({ isActive: true });
    await vi.waitFor(() => expect(h.reviewCalls).toBe(1));
  });

  it("does not ask off a calm screen", async () => {
    h.store.set(ratingPromptKey(USER), JSON.stringify({ sessions: 5 }));
    const m = await import("@/lib/rating-prompt-native");
    const busy = () => ({ pathname: "/payments", search: "" });
    expect(await m.maybeRequestRatingPrompt(USER, busy, () => NOW)).toBe(false);
    expect(h.reviewCalls).toBe(0);
  });

  it("does not ask an @demo.test account", async () => {
    h.store.set(ratingPromptKey(USER), JSON.stringify({ sessions: 5 }));
    h.counts = { ...h.counts, isTestAccount: true };
    const m = await import("@/lib/rating-prompt-native");
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(false);
    expect(h.reviewCalls).toBe(0);
  });

  it("a plugin that rejects throws nothing, stores nothing, and is not called again this launch", async () => {
    h.store.set(ratingPromptKey(USER), JSON.stringify({ sessions: 5 }));
    h.reviewError = new Error("not implemented on this platform");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = await import("@/lib/rating-prompt-native");
    await expect(m.maybeRequestRatingPrompt(USER, calm, () => NOW)).resolves.toBe(false);
    expect(h.reviewCalls).toBe(1);
    expect(parseRatingPromptState(h.store.get(ratingPromptKey(USER))).lastPromptedAt).toBeNull();
    await m.maybeRequestRatingPrompt(USER, calm, () => NOW);
    expect(h.reviewCalls).toBe(1);
    expect(error).not.toHaveBeenCalled();
    debug.mockRestore();
    error.mockRestore();
  });

  it("holds the cap across launches", async () => {
    h.store.set(
      ratingPromptKey(USER),
      JSON.stringify({ sessions: 9, lastPromptedAt: NOW - 30 * DAY, lastPromptedVersion: "1.0.0" }),
    );
    const m = await import("@/lib/rating-prompt-native");
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(false);
    expect(h.reviewCalls).toBe(0);
  });
});

describe("nothing open on the page", () => {
  const fakeDoc = (open: { dialog?: boolean; stripe?: boolean }) =>
    ({
      querySelectorAll: (sel: string) =>
        open.dialog && sel.includes('[role="dialog"]')
          ? [{ getAttribute: () => "open", isConnected: true }]
          : [],
      querySelector: (sel: string) => (open.stripe && sel.includes("stripe") ? {} : null),
    }) as unknown as Document;

  it("an open dialog, sheet or drawer, or a Stripe element, is not calm", async () => {
    const { nothingOpenOnPage } = await import("@/lib/rating-prompt-native");
    expect(nothingOpenOnPage(fakeDoc({}))).toBe(true);
    expect(nothingOpenOnPage(fakeDoc({ dialog: true }))).toBe(false);
    expect(nothingOpenOnPage(fakeDoc({ stripe: true }))).toBe(false);
    expect(nothingOpenOnPage(undefined)).toBe(true);
  });
});
