import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";

for (const width of [390, 820, 1024, 1440]) {
  for (const reason of ["stale", "superseded"] as const) {
    test(`${reason} import has no Commit action at ${width}px`, async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      await context.route("**/_serverFn/**", async (route) => {
        const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
        let name = "";
        try {
          name =
            JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "";
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
                id: "7a11e000-0000-4000-8000-0000000000a1",
                source: "jobber",
                entity: "clients",
                filename: "Sample clients export.csv",
                status: "previewing",
                created_at: "2026-08-04T15:12:00Z",
                stats: { total: 311, create: 311 },
                committed_at: null,
              },
              rows: [],
              commitBlock: { reason, committedBatchId: null, committedAt: null },
            },
          }),
        });
      });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1180 });
      await page.goto("/imports/7a11e000-0000-4000-8000-0000000000a1");
      // The first load on the CI runner can take longer than 5 seconds.
      await expect(page.getByRole("link", { name: "Start a fresh import" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole("button", { name: /Commit import/ })).toHaveCount(0);
      await expect(page.getByRole("status")).toContainText(
        reason === "stale" ? "24 hours" : "already imported",
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    });
  }
}

// A removed preview, or a load that fails, used to leave the page on
// "Loading…" for good (#434, retest of Oct 24). Both now say so and link back.
for (const width of [390, 820, 1024, 1440]) {
  for (const answer of ["gone", "error"] as const) {
    test(`a ${answer} import says so and links back at ${width}px`, async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      await context.route("**/_serverFn/**", async (route) => {
        const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
        let name = "";
        try {
          name =
            JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "";
        } catch {
          /* Not a named server function. */
        }
        if (!name.startsWith("getImportBatch")) return route.fallback();
        if (answer === "error") {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Sample failure" } }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: { batch: null, rows: [], commitBlock: null, retryBlock: null },
          }),
        });
      });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1180 });
      await page.goto("/imports/7a11e000-0000-4000-8000-0000000000a2");
      await expect(page.getByRole("link", { name: "Back to Imports" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Commit import/ })).toHaveCount(0);
      await expect(page.getByRole("alert")).toContainText(
        answer === "gone" ? "no longer exists" : "could not be loaded",
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    });
  }
}
