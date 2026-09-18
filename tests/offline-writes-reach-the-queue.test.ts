import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_DEADLINE_MS,
  ActionTimeout,
  isTransportFailure,
  runOrQueue,
  withDeadline,
} from "@/lib/offline/run-or-queue";

// QA-P4. The offline queue, its replay loop, its retry cap, the dead-letter
// path and the UI that reports it were all built and all correct. NOTHING
// REACHED THEM.
//
// Observed in a live browser: offline, a tech taps Start. No toast. The button
// goes disabled and stays disabled. `scoop-offline.actions` holds zero rows
// for as long as anyone watches. Close the app and the work is gone. When
// signal comes back with the tab still open, the visit starts — five to ten
// seconds later.
//
// That last detail is the whole diagnosis. The request had never failed. It
// was still in flight, because the decision to queue was:
//
//     if (navigator.onLine) { try the server } else { queue }
//
// and `navigator.onLine` does not mean "the server is reachable". It means
// "this device has an interface that thinks it is up" — true for one bar in a
// back yard, a van whose data session has dropped, a café captive portal. In
// that state the request neither resolves nor rejects, so the catch that
// queues is never reached and the mutation never settles.
//
// Every symptom follows from the hang. None of them follows from the queue.

/** A promise that never settles — the condition being fixed. */
const hangs = () => new Promise<never>(() => {});

describe("a request that hangs must not swallow the tech's work", () => {
  it("queues once the deadline passes", async () => {
    vi.useFakeTimers();
    const queue = vi.fn(async () => {});
    const p = runOrQueue({ online: true, label: "Start visit", send: hangs, queue });

    // Before the deadline, nothing has happened yet — the request is still
    // being given its chance.
    await vi.advanceTimersByTimeAsync(ACTION_DEADLINE_MS - 1);
    expect(queue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toEqual({ queued: true });
    expect(queue, "the work was never written anywhere").toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("settles, so the button is released and the tech is told", async () => {
    // The disabled-for-ever button and the missing toast are the same fact:
    // the promise never settled. This is that fact, asserted directly.
    vi.useFakeTimers();
    const p = runOrQueue({
      online: true,
      label: "Start visit",
      send: hangs,
      queue: async () => {},
    });
    let settled = false;
    void p.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(ACTION_DEADLINE_MS + 1);
    expect(settled, "the mutation never settled — button stays disabled").toBe(true);
    vi.useRealTimers();
  });

  it("has a deadline a person would wait through, not a machine", async () => {
    // Long enough that a slow-but-working connection is not cut off; short
    // enough that a tech at a gate does not think the app is broken.
    expect(ACTION_DEADLINE_MS).toBeGreaterThanOrEqual(3_000);
    expect(ACTION_DEADLINE_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("what still has to reach the network", () => {
  it("does not queue when the request succeeds", async () => {
    const queue = vi.fn(async () => {});
    await expect(
      runOrQueue({ online: true, label: "x", send: async () => ({ ok: true }), queue }),
    ).resolves.toEqual({ queued: false });
    expect(queue).not.toHaveBeenCalled();
  });

  it("does not even try when the device knows it is offline", async () => {
    // `onLine === false` is trustworthy: there is definitely no network, so
    // spending the deadline proving it would leave a tech watching a spinner
    // for eight seconds per tap.
    const send = vi.fn(hangs);
    const queue = vi.fn(async () => {});
    await expect(runOrQueue({ online: false, label: "x", send, queue })).resolves.toEqual({
      queued: true,
    });
    expect(send).not.toHaveBeenCalled();
    expect(queue).toHaveBeenCalledTimes(1);
  });
});

describe("a server rejection is not a network condition", () => {
  it("surfaces an authorization refusal instead of queueing it", async () => {
    // Queueing this reports success for an action that will NEVER apply — a
    // dispatcher taps Start on someone else's visit, sees "Queued", drives
    // away, and the replay is rejected by is_visit_tech for ever.
    const queue = vi.fn(async () => {});
    await expect(
      runOrQueue({
        online: true,
        label: "Start visit",
        send: async () => {
          throw new Error("Not authorized for this visit");
        },
        queue,
      }),
    ).rejects.toThrow(/Not authorized/);
    expect(queue, "a refusal was silently queued").not.toHaveBeenCalled();
  });

  it("surfaces a validation failure the same way", async () => {
    const queue = vi.fn(async () => {});
    await expect(
      runOrQueue({
        online: true,
        label: "Skip visit",
        send: async () => {
          throw new Error("A reason is required to skip a visit");
        },
        queue,
      }),
    ).rejects.toThrow(/reason is required/);
    expect(queue).not.toHaveBeenCalled();
  });

  it("queues a genuine transport failure", async () => {
    const queue = vi.fn(async () => {});
    await expect(
      runOrQueue({
        online: true,
        label: "Start visit",
        send: async () => {
          throw new TypeError("Failed to fetch");
        },
        queue,
      }),
    ).resolves.toEqual({ queued: true });
    expect(queue).toHaveBeenCalledTimes(1);
  });
});

describe("telling the two apart", () => {
  it("counts a timeout as transport", () => {
    // An answer that never came is indistinguishable from a connection that
    // never opened, and the tech is standing in the same yard either way.
    expect(isTransportFailure(new ActionTimeout("Start visit", 8000))).toBe(true);
  });

  it("counts the browser's own fetch failures", () => {
    expect(isTransportFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransportFailure(new Error("NetworkError when attempting to fetch"))).toBe(true);
    expect(isTransportFailure(new Error("Load failed"))).toBe(true);
    expect(isTransportFailure(new Error("The operation was aborted"))).toBe(true);
  });

  it("does not count a message from the server", () => {
    expect(isTransportFailure(new Error("Not authorized for this visit"))).toBe(false);
    expect(isTransportFailure(new Error("A completion photo is required"))).toBe(false);
    expect(isTransportFailure(new Error("new row violates row-level security policy"))).toBe(false);
  });
});

describe("withDeadline", () => {
  it("passes a value through untouched", async () => {
    await expect(withDeadline(Promise.resolve(7), 100, "x")).resolves.toBe(7);
  });

  it("passes the original error through, not a timeout", async () => {
    await expect(withDeadline(Promise.reject(new Error("real")), 100, "x")).rejects.toThrow("real");
  });

  it("names what timed out", async () => {
    vi.useFakeTimers();
    const p = withDeadline(hangs(), 50, "Start visit");
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(51);
    const e = await caught;
    expect(e).toBeInstanceOf(ActionTimeout);
    expect((e as Error).message).toContain("Start visit");
    vi.useRealTimers();
  });

  it("does not leave a timer running after the promise settles", async () => {
    // A stray timer per action would keep a phone's JS timers alive all day.
    vi.useFakeTimers();
    await withDeadline(Promise.resolve(1), 10_000, "x");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

// ── the wiring ────────────────────────────────────────────────────────────
//
// runOrQueue can be perfectly correct and perfectly unreachable — which is
// precisely what happened to the queue it feeds.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("every field action goes through it", () => {
  const src = code(read("src/lib/offline/useOfflineVisitActions.ts"));

  it("all four actions use runOrQueue", () => {
    // start, complete, skip, uploadPhoto. There were four copies of the same
    // eight lines, so a fix to one would have left the other three — the shape
    // this codebase keeps deleting.
    expect((src.match(/runOrQueue\(\{/g) ?? []).length).toBe(4);
  });

  it("none of them still hand-rolls the decision", () => {
    expect(src, "an action still branches on onLine by itself").not.toMatch(
      /if \(isNavigatorOnline\(\)\) \{/,
    );
    expect(src, "the old unbounded network-error check is back").not.toMatch(
      /function isNetworkError/,
    );
  });

  it("resolves the owner through the bounded resolver", () => {
    // getSession() refreshes an expired token over the network — the second
    // unbounded network call on a path that only runs when there is no
    // network.
    expect(src).toMatch(/resolveOfflineUserId/);
    expect(src, "still calling getSession directly on the offline path").not.toMatch(
      /auth\.getSession\(\)/,
    );
  });
});

describe("the owner resolver the comment already promised", () => {
  it("exists, under the name read-cache.ts already named it", () => {
    // `rememberLastUser`'s own doc comment said "see resolveOfflineUserId".
    // There was no such function: the storage half was maintained and the
    // reader it promised had never been written, so the fallback described in
    // the comment could not happen.
    expect(code(read("src/lib/offline/action-owner.ts"))).toMatch(
      /export async function resolveOfflineUserId/,
    );
    expect(read("src/lib/offline/read-cache.ts")).toMatch(/resolveOfflineUserId/);
  });

  it("reuses the key sign-out clears, rather than one of its own", () => {
    // LAST_USER_KEY is wiped by clearPersistedReadCaches, which sign-out calls
    // FIRST so the next tech to unlock a shared crew tablet cannot inherit the
    // previous one's identity. A second key would survive that, and the
    // shared-tablet case is where getting the owner wrong is worst.
    const src = code(read("src/lib/offline/action-owner.ts"));
    expect(src).toMatch(/readLastUser/);
    expect(src).toMatch(/rememberLastUser/);
    expect(src, "invented a second identity key").not.toMatch(/localStorage\.(get|set)Item/);
  });

  it("refuses rather than queueing an action it cannot attribute", () => {
    // Same call the v1→v2 migration made when it dropped unowned rows: an
    // action nobody owns replays as the wrong person.
    const src = code(read("src/lib/offline/action-owner.ts"));
    expect(src).toMatch(/throw new Error\(/);
    expect(src, "the refusal must say what to do about it").toMatch(
      /Open the app once with signal/,
    );
  });
});
