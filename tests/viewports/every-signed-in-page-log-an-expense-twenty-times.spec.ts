import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { SURFACES } from "./fixtures/surfaces";
import { settle } from "./fixtures/settle-surface";

/**
 * Issue #813: in the signed-in sweep, "/my-day · log an expense" failed twice
 * on CI, once at 360 (canonical widths, mouse) and once at 402x874 (Apple
 * pass, touch), and passed on the rerun at the same commit both times. The
 * acceptance for that issue is twenty clean runs at each of those two sizes
 * on CI, and the sweep file belongs to another open PR, so the repeat lives
 * here.
 *
 * It runs exactly the sweep's path to that sheet: the same minted session,
 * the same stub backend, the same `settle()` proof that My Day rendered, the
 * same `open` step from `fixtures/surfaces.ts` (a card's More options, then
 * Log an expense), and the same `opened` locator. It does not measure the
 * layout again; the sweep does that once per size. What it adds is the count.
 *
 * The file name starts with `every-signed-in-page` so the
 * `test:viewports:auth` step in sandboxes.yml selects it with no new script.
 * That step runs the canonical pass. The Apple pass selects it too, by the
 * same filter, and skips it there: this file sets its own sizes and its own
 * touch, so a second run under APPLE_SIZES=1 would repeat the same forty
 * tests and prove nothing new.
 *
 * Twenty is the number the issue asked for, not a retry count: each run is a
 * fresh context, and one failure fails the step. No retries, no timeout
 * change.
 */

const RUNS = 20;

/** The two sizes CI failed at, each with the input it failed under. */
const SIZES = [
  { w: 360, h: 780, label: "360 · a real phone", touch: false },
  { w: 402, h: 874, label: "402×874 · iPhone 16 Pro", touch: true },
] as const;

const surface = SURFACES.find((s) => s.id === "/my-day · log an expense");

test.describe.configure({ mode: "parallel" });

test.skip(
  process.env.APPLE_SIZES === "1",
  "this file chooses its own sizes and touch; the canonical pass already runs all forty",
);

for (const size of SIZES) {
  test.describe(size.label, () => {
    test.use({ hasTouch: size.touch });

    for (let run = 1; run <= RUNS; run++) {
      test(`the Log an expense sheet opens at ${size.w}px, run ${run} of ${RUNS}`, async ({
        page,
        context,
      }) => {
        expect(
          surface,
          "the /my-day · log an expense surface is gone from fixtures/surfaces.ts",
        ).toBeTruthy();
        const s = surface!;
        await installSignedInSession(context, s.prefs);
        await installStubBackend(context);

        await page.setViewportSize({ width: size.w, height: size.h });
        await page.goto(s.path);
        await settle(page, s, size.label);

        await s.open!(page);
        await expect(
          s.opened!(page).first(),
          `${s.id} at ${size.label}, run ${run}: ${s.openedLabel} never appeared`,
        ).toBeVisible({ timeout: 10_000 });
      });
    }
  });
}

/**
 * #813 again, at the size it was last seen: 375×667 (iPhone SE), touch on,
 * in the Apple pass of run 42941238203. That failure, like the two before it,
 * was not a missed click: the page's main thread stopped answering just after
 * the sheet opened. Caught locally on 2026-11-12 under gdb, the frozen
 * renderer's main thread was parked in Chromium's `cc::CompletionEvent::Wait`
 * (a wait on the compositor), with the compositor and raster threads idle and
 * `Runtime.terminateExecution` unable to free it, so no page script was
 * running. See the PR for #813 for what was tried.
 *
 * Opening is not the only half a tech does, so each run here opens, closes by
 * Escape, opens again and closes with the X, twenty fresh pages in a row. One
 * failure fails the step. No retry, no wait added, no timeout raised: the 10s
 * on each assertion is the one the sweep already uses for this sheet.
 */
const SE = { w: 375, h: 667, label: "375×667 · iPhone SE (2nd/3rd)" } as const;

test.describe(`${SE.label}, opened and closed`, () => {
  test.use({ hasTouch: true });

  for (let run = 1; run <= RUNS; run++) {
    test(`the Log an expense sheet opens and closes at ${SE.w}px, run ${run} of ${RUNS}`, async ({
      page,
      context,
    }) => {
      expect(
        surface,
        "the /my-day · log an expense surface is gone from fixtures/surfaces.ts",
      ).toBeTruthy();
      const s = surface!;
      await installSignedInSession(context, s.prefs);
      await installStubBackend(context);

      await page.setViewportSize({ width: SE.w, height: SE.h });
      await page.goto(s.path);
      await settle(page, s, SE.label);

      const sheet = s.opened!(page).first();
      const card = page.locator("ol > li").first();

      await s.open!(page);
      await expect(sheet, `run ${run}: the sheet never opened`).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(sheet, `run ${run}: Escape did not close the sheet`).toBeHidden({
        timeout: 10_000,
      });

      // More options is still open on the card, so the button is one tap away.
      await card.getByRole("button", { name: "Log an expense" }).click();
      await expect(sheet, `run ${run}: the sheet did not open a second time`).toBeVisible({
        timeout: 10_000,
      });
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(sheet, `run ${run}: the X did not close the sheet`).toBeHidden({
        timeout: 10_000,
      });
    });
  }
});
