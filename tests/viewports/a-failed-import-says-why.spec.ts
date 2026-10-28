/**
 * #569: an import whose rows were all refused sat on "Committing" for ever,
 * with 0 rows, no error and no way to try again. A failed import now says
 * why, and offers "Try again" when nothing of it went in, or says why not.
 *
 * Both states are proved on screen by their own words before anything is
 * measured, at 360 / 768 / 1280 / 1920 with touch on. A screenshot of each
 * lands in .helm/screenshots/issue-569/ when SHOTS=1.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 768, 1280, 1920];
const SHOTS = join(process.cwd(), ".helm/screenshots/issue-569");
const BATCH_ID = "7a11e000-0000-4000-8000-000000000569";
const REASON = "These account fields can only be changed by the platform.";

const rows = Array.from({ length: 4 }, (_, i) => ({
  id: `7a11e000-0000-4000-8000-00000000057${i}`,
  row_num: i + 1,
  raw: {},
  mapped: {
    display_name: [
      "Riverside Dental Group and Family Practice LLC",
      "Ana Torres",
      "Ben Ode",
      "Kim Lee",
    ][i],
    account_type: "residential",
    primary_email: `client${i}@example.com`,
  },
  action: "error",
  target_id: null,
  error: REASON,
}));

async function serveBatch(page: Page, retryBlock: string | null) {
  await page.context().route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "";
    } catch {
      /* Not a named server function. */
    }
    if (!name.startsWith("getImportBatch")) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          batch: {
            id: BATCH_ID,
            source: "jobber",
            entity: "clients",
            filename: "Sample clients export.csv",
            status: "failed",
            created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
            commit_started_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            committed_at: new Date().toISOString(),
            error: REASON,
            stats: {
              total: 4,
              create: 4,
              update: 0,
              skip: 0,
              errors: 0,
              created: 0,
              updated: 0,
              failed: 4,
              skipped: 0,
            },
          },
          rows,
          commitBlock: { reason: "failed", committedBatchId: null, committedAt: null },
          retryBlock,
        },
      }),
    });
  });
}

async function measure(page: Page, label: string, width: number) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label} @${width}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label} @${width}: clipped`).toEqual([]);
  expect(
    await findControlsNarrowerThanTheirLabel(page),
    `${label} @${width}: a button narrower than its label`,
  ).toEqual([]);
  if (width < 768) {
    const small = (await findControlsUnder44px(page)).filter((c) =>
      /Try again|fresh import/.test(c),
    );
    expect(small, `${label} @${width}: under 44px`).toEqual([]);
  }
  if (process.env.SHOTS && (width === 360 || width === 1280)) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${label}-${width}.png`), fullPage: true });
  }
}

test.use({ hasTouch: true });

for (const width of WIDTHS) {
  test(`a failed import says why and offers Try again at ${width}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await serveBatch(page, null);
    await page.setViewportSize({ width, height: width < 768 ? 800 : 1100 });
    await page.goto(`/imports/${BATCH_ID}`);
    const alert = page.getByRole("alert").filter({ hasText: "This import did not finish." });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(REASON);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Start a fresh import" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Commit import/ })).toHaveCount(0);
    await measure(page, "import-failed-try-again", width);
  });

  test(`a failed import that wrote rows says why it cannot be tried again at ${width}px`, async ({
    page,
    context,
  }) => {
    const why =
      "Some rows went in before this import stopped, so committing it again could add them twice. Check the rows below, then start a new import with the ones that are missing.";
    await installSignedInSession(context);
    await installStubBackend(context);
    await serveBatch(page, why);
    await page.setViewportSize({ width, height: width < 768 ? 800 : 1100 });
    await page.goto(`/imports/${BATCH_ID}`);
    const alert = page.getByRole("alert").filter({ hasText: "This import did not finish." });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(why);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Start a fresh import" })).toBeVisible();
    await measure(page, "import-failed-no-retry", width);
  });
}
