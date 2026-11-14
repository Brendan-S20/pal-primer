import type { Page } from "@playwright/test";

/**
 * A page whose main thread has stopped answering, named as such.
 *
 * ── WHY THIS EXISTS (#813) ────────────────────────────────────────────────
 *
 * Twice on CI the "/my-day · log an expense" surface failed with
 *
 *     Test timeout of 90000ms exceeded.
 *     Error: ... the Log an expense sheet never appeared ...
 *     expect(locator).toBeVisible() failed
 *     Received: undefined
 *
 * on an assertion written as `toBeVisible({ timeout: 10_000 })`, which the
 * HTML report timed at 95 seconds. Both clicks before it had succeeded in
 * about 0.3s, and closing the context afterwards took 10s against well under
 * one for every other test in the run.
 *
 * That is not a dialog that was slow to appear. Playwright's `expect` starts
 * with one evaluation in the page that is NOT bounded by the assertion's
 * timeout (see `expect` in playwright-core's frames: the first
 * `_expectInternal` runs under `nullProgress`), so a 10s assertion can only
 * run for 95s if that one evaluation never came back: the renderer's main
 * thread was busy and never yielded. An ordinary miss reads differently:
 * `Timeout: 10000ms` and `element(s) not found`, at 10 seconds.
 * `a-frozen-page-is-named-not-waited-on.spec.ts` shows both side by side.
 *
 * So the old failure message sent the reader looking for a race between the
 * click and the sheet, which is the one thing the evidence rules out, and it
 * said nothing about where the page was stuck. This asks the page a trivial
 * question with a deadline, and if it does not answer, pauses V8 over CDP and
 * reports the JavaScript stack it was running. A loop in the app then fails
 * in seconds with the file and line of the loop, instead of in 90 with a
 * sentence about a sheet.
 *
 * Not a retry and not a longer timeout: a page that answers costs one
 * round trip, and a page that does not still fails, sooner and by name.
 */

/** Long enough that a busy CI runner rendering a big page is not mistaken
 *  for a frozen one (the slowest open on record is well under a second),
 *  short enough that the failure lands long before the test timeout. */
export const RENDERER_ANSWER_MS = 10_000;

type CallFrame = {
  functionName: string;
  url: string;
  location: { lineNumber: number; columnNumber?: number };
};

/** One readable line per frame: `fn src/path.tsx:12:5`, with the dev
 *  server's origin and Vite's `?t=` / `?v=` query taken off, so the line
 *  names a file in this repo (or a dependency in node_modules/.vite). */
export function describeFrames(frames: readonly CallFrame[], max = 25): string[] {
  return frames.slice(0, max).map((f) => {
    let where = f.url;
    try {
      const u = new URL(f.url);
      where = u.pathname.replace(/^\//, "");
    } catch {
      /* not a URL: an eval, a snippet */
    }
    const col = f.location.columnNumber != null ? `:${f.location.columnNumber + 1}` : "";
    return `${f.functionName || "(anonymous)"} ${where || "(native)"}:${f.location.lineNumber + 1}${col}`;
  });
}

const settleWithin = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then((value) => ({ value })),
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);

/**
 * Attach before the step that might freeze the page, then call `expectAnswers`
 * after it.
 *
 * Attached BEFORE, because a frozen renderer does not serve `Debugger.enable`
 * (it waits for the main thread, which is the thing that is stuck; the first
 * version of this asked for it afterwards and waited out the freeze exactly
 * like the assertion it was replacing). `Debugger.pause` is different: V8
 * takes it on an interrupt, mid-loop. So the debugger is switched on while
 * the page is idle, and the only request made of a frozen page is the pause.
 *
 * `expectAnswers` resolves if the page answers within `ms`, and switches the
 * debugger off again. Otherwise it throws an Error saying the renderer froze,
 * `after` what, and the JavaScript stack it was frozen in (or that V8 could
 * not be paused either, which narrows it to the browser outside JavaScript).
 */
export async function watchForFreeze(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Debugger.enable");

  return {
    async expectAnswers(where: string, after: string, ms = RENDERER_ANSWER_MS): Promise<void> {
      const ping = page.evaluate(() => true);
      // A frozen page is closed at teardown with this still pending.
      ping.catch(() => {});
      if (await settleWithin(ping, ms)) {
        await cdp.detach().catch(() => {});
        return;
      }

      let stack = ["(V8 could not be paused: the renderer is blocked outside JavaScript)"];
      const paused = new Promise<{ callFrames: CallFrame[] }>((r) =>
        cdp.once("Debugger.paused", (e) => r(e as { callFrames: CallFrame[] })),
      );
      const sent = cdp.send("Debugger.pause");
      sent.catch(() => {});
      const ev = await settleWithin(paused, 5_000);
      if (ev) stack = describeFrames(ev.value.callFrames);
      // Not resumed and not detached: both are requests the frozen thread
      // would have to serve. Teardown closes the page either way.

      throw new Error(
        `${where}: the page stopped answering ${after}. Its main thread did not respond for ` +
          `${ms / 1000}s, so nothing on it can be measured, and an assertion would only wait ` +
          `out the test timeout. It was running:\n    ${stack.join("\n    ")}`,
      );
    },
  };
}
