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
