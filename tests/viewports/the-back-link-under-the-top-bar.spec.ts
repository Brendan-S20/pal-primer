/**
 * #925 and #926, follow-ups from #911's shot review of the import result
 * page.
 *
 * #925: at 390px "← All imports" sat under the sticky top bar. Measured at
 * rest with the trial banner dismissed (a banner pushes the page down and
 * hides the fault): the link's whole box is inside the viewport, below the
 * bar, a 44px target, and below md a full bar height is reserved above it.
 * Then again after scrolling down and back. 390 / 768 / 1280, touch on.
 *
 * #926: a failed import showed "Errors 0", which reads as a clean result.
 * The tile now counts the rows that failed, and says "Stopped" when the
 * import stopped with no row to blame. It never invents a number.
 *
 * Labelled TEST data only, on the stubbed backend: nothing here reaches a
 * real business. Screenshots land in .helm/screenshots/issue-925/ (and
 * issue-926/) when SHOTS=1, prefixed with SHOTS_PREFIX (default "after").
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { measurePageOverflow, findControlsOffTheSide } from "./rules";

const WIDTHS = [390, 768, 1280];
const BATCH_ID = "7a11e000-0000-4000-8000-000000000925";
const PREFIX = process.env.SHOTS_PREFIX ?? "after";
const FIRST_PAINT = { timeout: 45_000 };

type Kind = "committed" | "failed-stopped" | "failed-rows";

function batchFor(kind: Kind) {
  const base = {
    id: BATCH_ID,
    source: "jobber",
    entity: "services",
    filename: "QA TEST 925 plans.csv",
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    commit_started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    committed_at: new Date().toISOString(),
  };
  const warnings = [
    "Billing frequency was not changed for QA TEST 925 Client: billing update refused.",
  ];
  if (kind === "committed") {
    return {
      ...base,
      status: "committed",
      error: null,
      stats: { total: 1, create: 1, created: 1, updated: 0, skipped: 0, failed: 0, warnings },
    };
  }
  return {
    ...base,
    status: "failed",
    error: "The import stopped after the plan was created.",
    stats:
      kind === "failed-stopped"
        ? { total: 1, create: 1, created: 1, failed: 0, errors: 0, warnings }
        : { total: 4, create: 4, created: 0, failed: 3, errors: 0 },
  };
}

async function serveBatch(page: Page, kind: Kind) {
  await page.context().route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "";
    } catch {
      /* Not a named server function. */
    }
    if (!name.startsWith("getImportBatch")) return route.fallback();
    const failed = kind !== "committed";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          batch: batchFor(kind),
          rows: [],
          commitBlock: failed
            ? { reason: "failed", committedBatchId: null, committedAt: null }
            : { reason: "committed", committedBatchId: BATCH_ID, committedAt: null },
          retryBlock: failed ? "Some rows went in before this import stopped." : null,
          undoBlock: failed ? null : "This import cannot be undone in this TEST.",
        },
      }),
    });
  });
}

async function shoot(page: Page, issue: string, name: string, width: number) {
  if (!process.env.SHOTS) return;
  const dir = join(process.cwd(), `.helm/screenshots/${issue}`);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${PREFIX}-${name}-${width}.png`) });
}

test.use({ hasTouch: true });

for (const width of WIDTHS) {
  test(`"All imports" is below the top bar and tappable at ${width}px (#925)`, async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await serveBatch(page, "committed");
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1100 });
    await page.goto(`/imports/${BATCH_ID}`);
    await expect(page.getByText("Check these import warnings")).toBeVisible(FIRST_PAINT);
    const back = page.getByRole("link", { name: /All imports/ });
    await expect(back).toBeVisible();

    // The #911 case: no trial or billing banner above the bar. A banner
    // pushes the page down by its own height and hides the fault, so it is
    // dismissed here and proved gone before anything is measured.
    const hideTrial = page.getByRole("button", { name: "Hide the trial notice" });
    if (await hideTrial.isVisible()) await hideTrial.click();
    await expect(page.getByText("Your free trial has ended")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await shoot(page, "issue-925", "import-result-back-link", width);
    const header = page.locator('header[data-vt="header"]');
    const headerBottom = async () =>
      (await header.isVisible())
        ? await header.evaluate((h) => h.getBoundingClientRect().bottom)
        : 0;
    const clearOfTheBar = async (label: string) => {
      const box = (await back.boundingBox())!;
      const bar = await headerBottom();
      expect(
        box.y,
        `@${width} ${label}: the back link starts under the top bar`,
      ).toBeGreaterThanOrEqual(bar);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      // What a tap at its centre lands on is the link itself, not the bar.
      const hit = await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest("a[href='/imports']"),
        { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 },
      );
      expect(hit, `@${width} ${label}: a tap on the back link reaches it`).toBe(true);
      return box;
    };

    // At rest, no banner: fully inside the viewport, under no part of the bar.
    const box = await clearOfTheBar("at rest with no banner");
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(width < 768 ? 844 : 1100);
    expect.soft(box.height, `@${width}: the back link is a 44px target`).toBeGreaterThanOrEqual(44);
    // Below md the page reserves the bar's full height above the link, so it
    // is clear even where the bar sits over the column. Before #925's fix the
    // link was 16px below the bar here: clear in a desktop browser, with no
    // room to spare anywhere the bar overlays the page.
    if (width < 768) {
      const bar = await header.evaluate((h) => h.getBoundingClientRect());
      expect(
        box.y - bar.bottom,
        `@${width}: a full bar height (${bar.height}px) is reserved above the back link`,
      ).toBeGreaterThanOrEqual(bar.height);
    }

    // Scrolled down, then brought back into view the way the browser does it
    // (focus, scrollIntoView): it stops below the sticky bar, not under it.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await back.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shoot(page, "issue-925", "import-result-back-link-scrolled-into-view", width);
    await clearOfTheBar("scrolled back into view");

    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW).toBeLessThanOrEqual(innerW + 1);
    expect(await findControlsOffTheSide(page)).toEqual([]);
  });

  test(`a failed import's Errors tile does not read as a clean 0 at ${width}px (#926)`, async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await serveBatch(page, "failed-stopped");
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1100 });
    await page.goto(`/imports/${BATCH_ID}`);
    await expect(page.getByText("The import stopped after the plan was created.")).toBeVisible(
      FIRST_PAINT,
    );
    await shoot(page, "issue-926", "import-failed-errors-tile", width);
    const tile = page.locator("[data-stat='errors']");
    await expect(tile).toContainText("Stopped");
    await expect(tile).not.toContainText(/^Errors\s*0$/);
  });
}

test("a failed import with refused rows counts them in Errors (#926)", async ({
  page,
  context,
}) => {
  await installSignedInSession(context);
  await installStubBackend(context);
  await serveBatch(page, "failed-rows");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/imports/${BATCH_ID}`);
  await expect(page.getByText("The import stopped after the plan was created.")).toBeVisible(
    FIRST_PAINT,
  );
  await expect(page.locator("[data-stat='errors']")).toContainText("3");
});
