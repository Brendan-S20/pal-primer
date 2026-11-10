import { test, expect } from "@playwright/test";
import { watchForFreeze, describeFrames } from "./fixtures/frozen-renderer";

/**
 * #813, pinned. The "/my-day · log an expense" surface failed twice on CI
 * with a 10s `toBeVisible` that ran for 95s and a message about a sheet that
 * "never appeared". `fixtures/frozen-renderer.ts` explains why that shape
 * means the page's main thread had stopped, not that the sheet was slow.
 *
 * These are the two halves of that argument, run against pages built for
 * the purpose, so they need no dev server and no fixture data:
 *
 *   1. Playwright really does wait past an assertion's own timeout when the
 *      page is frozen. If a Playwright upgrade bounds that first look, this
 *      fails, and the comment in openExtras is the thing to revisit.
 *   2. The check the sweep now makes before that assertion fails a frozen
 *      page in its own deadline, and names the function the page is stuck in.
 *
 * And the control: a page that is merely missing the dialog is not called
 * frozen.
 */

// A function with a name, so the stack has something to name.
const FROZEN_PAGE = `
  <button onclick="setTimeout(spinForever, 0)">open</button>
  <script>function spinForever() { for (;;) {} }</script>`;

test.describe.configure({ mode: "parallel" });

test("a page that answers passes at once, and a missing dialog is an ordinary miss", async ({
  page,
}) => {
  await page.setContent("<p>nothing here</p>");
  const freeze = await watchForFreeze(page);
  const started = Date.now();
  await freeze.expectAnswers("control", "after nothing", 2_000);
  expect(Date.now() - started).toBeLessThan(2_000);

  const miss = await expect(page.getByRole("dialog", { name: "Log an expense" }))
    .toBeVisible({ timeout: 500 })
    .then(
      () => null,
      (e: Error) => e.message,
    );
  expect(miss).toContain("element(s) not found");
});

test("a frozen page outlives an assertion's timeout", async ({ page }) => {
  await page.setContent(FROZEN_PAGE);
  await page.getByRole("button", { name: "open" }).click();

  const started = Date.now();
  const outcome = await Promise.race([
    expect(page.getByRole("dialog", { name: "Log an expense" }))
      .toBeVisible({ timeout: 1_000 })
      .then(
        () => "visible",
        () => "failed",
      ),
    new Promise<string>((r) => setTimeout(() => r("still waiting"), 4_000)),
  ]);
  // With a 1s timeout, anything but "still waiting" at 4s means the first
  // look is bounded now.
  expect(outcome, `after ${Date.now() - started}ms`).toBe("still waiting");
});

test("the sweep's check fails a frozen page in its deadline, with the stuck function", async ({
  page,
}) => {
  await page.setContent(FROZEN_PAGE);
  const freeze = await watchForFreeze(page);
  await page.getByRole("button", { name: "open" }).click();

  const started = Date.now();
  const message = await freeze.expectAnswers("frozen", "after opening it", 2_000).then(
    () => "answered",
    (e: Error) => e.message,
  );
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(message).toContain("frozen: the page stopped answering after opening it");
  expect(message).toContain("spinForever");
});

test("frames read as repo paths", () => {
  expect(
    describeFrames([
      {
        functionName: "VisitCard",
        url: "http://127.0.0.1:5599/src/routes/_authenticated/my-day.tsx?t=123",
        location: { lineNumber: 3180, columnNumber: 4 },
      },
      { functionName: "", url: "", location: { lineNumber: 0 } },
    ]),
  ).toEqual(["VisitCard src/routes/_authenticated/my-day.tsx:3181:5", "(anonymous) (native):1"]);
});
