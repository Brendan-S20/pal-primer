// Issue #521: an Android debug/QA path for the in-app rating prompt, through
// Play's FakeReviewManager, that cannot reach a release build.
//
// Play's review sheet never appears on a debug or sideloaded build, so QA had
// no way to see when the prompt fires. A debug APK built with
// -Phoundstack.fakeReview=on|fail now registers HoundStackFakeReview, which
// runs request-then-launch against FakeReviewManager and toasts the moment
// the sheet would appear (docs/android-rating-prompt-qa.md).
//
// The Android half is tested on the JVM by
// android/app/src/testDebug/.../ReviewFlowTest.java (./gradlew
// testDebugUnitTest, no device) and on a device by the instrumented test
// beside it. This file is the half that needs neither: it pins the walls that
// keep the fake out of production, and drives the JS selection with the
// plugins faked.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_APP_URLS, ratingPromptKey } from "@/lib/rating-prompt";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const APP = "android/app";

function javaFilesUnder(rel: string): string[] {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...javaFilesUnder(child));
    else if (/\.(java|kt)$/.test(entry.name)) out.push(child);
  }
  return out;
}

describe("the fake review manager stays out of release", () => {
  it("nothing in src/main mentions FakeReviewManager or the fake plugin", () => {
    const offenders = javaFilesUnder(`${APP}/src/main`).filter((f) =>
      /FakeReviewManager|FakeReviewPlugin|FakeReviewInstaller|FailingReviewManager/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

  it("the fake's classes and their registration live in the debug source set only", () => {
    const debug = javaFilesUnder(`${APP}/src/debug`).map((f) => path.posix.basename(f));
    expect(debug).toEqual(
      expect.arrayContaining([
        "FakeReviewPlugin.java",
        "FakeReviewInstaller.java",
        "FailingReviewManager.java",
        "ReviewFlow.java",
      ]),
    );
    expect(fs.existsSync(path.join(root, `${APP}/src/release`))).toBe(false);
    expect(read(`${APP}/src/debug/AndroidManifest.xml`)).toContain(
      "consulting.thenorth.houndstack.review.FakeReviewInstaller",
    );
    expect(read(`${APP}/src/main/AndroidManifest.xml`)).not.toContain("FakeReview");
  });

  it("the build flag defaults to off, and release is off whatever it says", () => {
    const gradle = read(`${APP}/build.gradle`);
    expect(gradle).toMatch(
      /def fakeReviewFlag = \(findProperty\('houndstack\.fakeReview'\) \?: System\.getenv\('HOUNDSTACK_FAKE_REVIEW'\) \?: 'off'\)/,
    );
    const release = gradle.match(/\n {8}release \{([\s\S]*?)\n {8}\}/)?.[1] ?? "";
    expect(release).toContain(`buildConfigField "String", "FAKE_REVIEW_MANAGER", "\\"off\\""`);
    expect(release).not.toContain("fakeReviewFlag");
  });

  it("Play's review library joins the debug and test classpaths only", () => {
    const lines = read(`${APP}/build.gradle`)
      .split("\n")
      .filter((l) => l.includes("com.google.android.play:review"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.trim()).toMatch(
        /^(debugImplementation|testDebugImplementation|androidTestImplementation) /,
      );
    }
  });

  it("the JS and Java agree on the plugin's name", async () => {
    const { FAKE_REVIEW_PLUGIN } = await import("@/lib/rating-prompt-native");
    const java = read(
      `${APP}/src/debug/java/consulting/thenorth/houndstack/review/FakeReviewPlugin.java`,
    );
    expect(java).toContain(`NAME = "${FAKE_REVIEW_PLUGIN}"`);
  });

  it("the Rate HoundStack link names the package this repo builds", () => {
    const id = read(`${APP}/build.gradle`).match(/applicationId "([^"]+)"/)?.[1];
    expect(id).toBe("consulting.thenorth.houndstack");
    expect(new URL(RATE_APP_URLS.android).searchParams.get("id")).toBe(id);
    expect(RATE_APP_URLS.android.startsWith("https://play.google.com/store/apps/details?")).toBe(
      true,
    );
  });
});

// ── THE JS SIDE, WITH THE PLUGINS FAKED ────────────────────────────────────

const h = vi.hoisted(() => ({
  platform: "android" as string,
  fakeAvailable: false,
  fakeOutcome: "launched",
  fakeCalls: 0,
  realCalls: 0,
  store: new Map<string, string>(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => h.platform,
    isPluginAvailable: (name: string) => h.fakeAvailable && name === "HoundStackFakeReview",
  },
  registerPlugin: (name: string) => {
    if (name !== "HoundStackFakeReview") throw new Error(`unexpected plugin ${name}`);
    return {
      requestReview: async () => {
        h.fakeCalls++;
        return { outcome: h.fakeOutcome };
      },
    };
  },
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
    getInfo: async () => ({ version: "1.1.0", build: "1", id: "x", name: "HoundStack" }),
    addListener: async () => ({ remove: async () => {} }),
  },
}));

vi.mock("@capacitor-community/in-app-review", () => ({
  InAppReview: {
    requestReview: async () => {
      h.realCalls++;
    },
  },
}));

// An eligible owner: first paid invoice, on a second session (set in beforeEach).
vi.mock("@/lib/rating-prompt.functions", () => ({
  getRatingPromptCounts: async () => ({
    role: "owner",
    paidInvoiceCount: 1,
    completedVisitCount: 0,
    isTestAccount: false,
  }),
}));

const USER = "user-521";
const calm = () => ({ pathname: "/dashboard", search: "" });
const NOW = Date.UTC(2026, 10, 9, 12);

describe("which review plugin the prompt calls", () => {
  beforeEach(async () => {
    const m = await import("@/lib/rating-prompt-native");
    m.resetRatingPromptForTests();
    h.platform = "android";
    h.fakeAvailable = false;
    h.fakeOutcome = "launched";
    h.fakeCalls = 0;
    h.realCalls = 0;
    h.store.clear();
    h.store.set(ratingPromptKey(USER), JSON.stringify({ sessions: 2 }));
  });

  it("uses the real plugin when the fake is not registered: every release build", async () => {
    const m = await import("@/lib/rating-prompt-native");
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(true);
    expect(h.realCalls).toBe(1);
    expect(h.fakeCalls).toBe(0);
  });

  it("uses FakeReviewManager, once, when a debug APK registered it", async () => {
    h.fakeAvailable = true;
    const m = await import("@/lib/rating-prompt-native");
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(true);
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(false);
    expect(h.fakeCalls).toBe(1);
    expect(h.realCalls).toBe(0);
    expect(JSON.parse(h.store.get(ratingPromptKey(USER))!).lastPromptedAt).toBe(NOW);
  });

  it("a failed fake request is swallowed: no throw, nothing recorded as asked", async () => {
    h.fakeAvailable = true;
    h.fakeOutcome = "request_failed";
    const m = await import("@/lib/rating-prompt-native");
    await expect(m.maybeRequestRatingPrompt(USER, calm, () => NOW)).resolves.toBe(false);
    expect(h.fakeCalls).toBe(1);
    expect(JSON.parse(h.store.get(ratingPromptKey(USER))!).lastPromptedAt ?? null).toBeNull();
  });

  it("never uses the fake on iOS, even if something by that name existed", async () => {
    h.platform = "ios";
    h.fakeAvailable = true;
    const m = await import("@/lib/rating-prompt-native");
    expect(await m.maybeRequestRatingPrompt(USER, calm, () => NOW)).toBe(true);
    expect(h.realCalls).toBe(1);
    expect(h.fakeCalls).toBe(0);
  });
});
