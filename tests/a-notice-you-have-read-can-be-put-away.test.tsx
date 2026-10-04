// A notice you have read can be put away, and comes back when it has
// something new to say.
//
// Owner, 2026-10-03: "there's in-app notifications that are not able to be
// cleared away on certain screens, and it would be nice to dismiss or hide
// them if they are not necessary." src/lib/dismissible.ts is the one rule every
// such banner uses; this file pins that rule as a table, because the failure
// modes are all quiet ones:
//
//   * a version that never changes turns "dismiss" into "delete forever", and
//     the trial notice's reason for once being undismissable comes true;
//   * a snooze that never expires does the same thing more slowly;
//   * storage that throws (private-mode Safari throws on ACCESS) either takes
//     the page down or makes the X a button that does nothing.
//
// There is no DOM test renderer in this repo, so the hook is exercised through
// the pieces it is made of (the pure rule and the store it reads and writes),
// plus a server render to prove it never hides a banner it cannot see.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DAY_MS,
  DISMISS_EVENT,
  dismissKey,
  isDismissed,
  readRaw,
  resetDismissMemory,
  useDismissed,
  writeDismissal,
} from "@/lib/dismissible";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/lib/trial.functions", () => ({ getTrialState: vi.fn() }));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));

/** A Storage that behaves, for the cases where it should. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

/** A Storage that refuses everything, the way a locked-down WebView does. */
function throwingStorage(): Storage {
  const boom = () => {
    throw new DOMException("denied", "SecurityError");
  };
  return {
    length: 0,
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  } as unknown as Storage;
}

const NOW = Date.UTC(2026, 9, 3, 12);
const KEY = dismissKey("user-1", "org-1", "sms-consent-gap");

beforeEach(() => resetDismissMemory());

describe("the rule", () => {
  it("shows a banner nobody has dismissed", () => {
    expect(isDismissed("", "56/198", undefined, NOW)).toBe(false);
  });

  it("dismiss hides it, for the same version", () => {
    const store = memoryStorage();
    writeDismissal(KEY, "56/198", NOW, store);
    expect(isDismissed(readRaw(KEY, store), "56/198", undefined, NOW)).toBe(true);
    // And a year later, with no snooze: an unchanged gap is not news.
    expect(isDismissed(readRaw(KEY, store), "56/198", undefined, NOW + 365 * DAY_MS)).toBe(true);
  });

  it("a new version brings it back, because the facts changed", () => {
    const store = memoryStorage();
    writeDismissal(KEY, "56/198", NOW, store);
    expect(isDismissed(readRaw(KEY, store), "57/199", undefined, NOW)).toBe(false);
  });

  it("a snooze brings it back when it runs out, and not a moment before", () => {
    const store = memoryStorage();
    writeDismissal(KEY, "expired", NOW, store);
    const raw = readRaw(KEY, store);
    expect(isDismissed(raw, "expired", 7, NOW + 7 * DAY_MS - 1)).toBe(true);
    expect(isDismissed(raw, "expired", 7, NOW + 7 * DAY_MS)).toBe(false);
  });

  it("a banner with nothing to say is never reported dismissed", () => {
    const store = memoryStorage();
    writeDismissal(KEY, "56/198", NOW, store);
    expect(isDismissed(readRaw(KEY, store), null, undefined, NOW)).toBe(false);
  });

  it("garbage in storage means show, not crash", () => {
    for (const raw of ["{", "null", "42", '{"v":1}', '{"v":"56/198"}', '{"v":"56/198","at":"x"}']) {
      expect(isDismissed(raw, "56/198", undefined, NOW), raw).toBe(false);
    }
  });

  it("is per person and per business", () => {
    expect(dismissKey("user-1", "org-1", "trial")).not.toBe(dismissKey("user-2", "org-1", "trial"));
    expect(dismissKey("user-1", "org-1", "trial")).not.toBe(dismissKey("user-1", "org-2", "trial"));
    expect(dismissKey("user-1", "org-1", "trial")).not.toBe(dismissKey("user-1", "org-1", "zone"));
    // Not under the read cache's prefix, which is swept on sign-out.
    expect(dismissKey("u", "o", "b")).not.toMatch(/^hs:offline-reads:/);
  });
});

describe("when storage throws", () => {
  it("reading cannot throw, and reads as not dismissed", () => {
    expect(() => readRaw(KEY, throwingStorage())).not.toThrow();
    expect(readRaw(KEY, throwingStorage())).toBe("");
  });

  it("the X still works for the rest of the session, from memory", () => {
    const store = throwingStorage();
    expect(() => writeDismissal(KEY, "56/198", NOW, store)).not.toThrow();
    expect(isDismissed(readRaw(KEY, store), "56/198", undefined, NOW)).toBe(true);
    // And the memory copy follows the same rule: a new version re-shows.
    expect(isDismissed(readRaw(KEY, store), "57/199", undefined, NOW)).toBe(false);
  });

  it("no storage at all (a server, a test) is the same as one that throws", () => {
    expect(() => writeDismissal(KEY, "v", NOW, null)).not.toThrow();
    expect(isDismissed(readRaw(KEY, null), "v", undefined, NOW)).toBe(true);
  });
});

describe("the hook, on the client", () => {
  let store: Storage;
  const fired: string[] = [];

  beforeEach(() => {
    store = memoryStorage();
    store.setItem("hs:offline-reads:last-user", "user-1");
    const target = new EventTarget();
    target.addEventListener(DISMISS_EVENT, () => fired.push(DISMISS_EVENT));
    vi.stubGlobal("window", {
      localStorage: store,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fired.length = 0;
  });

  it("writes under the signed-in person and the business, and announces it", () => {
    writeDismissal(dismissKey("user-1", "org-1", "trial"), "expired", NOW);
    expect(store.getItem(dismissKey("user-1", "org-1", "trial"))).toContain('"v":"expired"');
    expect(fired).toEqual([DISMISS_EVENT]);
  });

  it("a server render shows the banner, whatever this device stored", () => {
    // The server cannot see this device's storage. Hiding by default there
    // would hide every banner for everybody on first paint.
    writeDismissal(dismissKey("user-1", "org-1", "trial"), "expired", NOW);
    function Probe() {
      const { dismissed } = useDismissed("trial", "expired", { orgId: "org-1", snoozeDays: 7 });
      return <span>{dismissed ? "hidden" : "shown"}</span>;
    }
    expect(renderToStaticMarkup(<Probe />)).toBe("<span>shown</span>");
  });
});

describe("the trial notice comes back as the end gets closer", () => {
  it("one version per stretch: more than a week, a week, three days, the last day", async () => {
    const { trialDismissVersion } = await import("@/components/TrialBanner");
    const v = (d: number) => trialDismissVersion({ phase: "trialing", daysRemaining: d });
    expect(v(14)).toBe(v(8));
    expect(v(8)).not.toBe(v(7));
    expect(v(7)).toBe(v(4));
    expect(v(4)).not.toBe(v(3));
    expect(v(3)).toBe(v(2));
    expect(v(2)).not.toBe(v(1));
    // An ended trial is its own notice, and so is an ended plan.
    expect(trialDismissVersion({ phase: "expired", daysRemaining: null })).toBe("expired");
    expect(trialDismissVersion({ phase: "lapsed", daysRemaining: null })).toBe("lapsed");
  });
});
