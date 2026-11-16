// UI evidence for #883. Network-isolated fixture; SQL retirement semantics are
// exercised separately by an-owner-replaces-the-untouched-default.proof.sql.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { SERVICES } from "./fixtures/dataset";

test.setTimeout(180_000);

for (const width of [390, 768, 1280]) {
  test(`Add service replaces the untouched starter @${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    let services = [{ ...SERVICES[0] }];
    await installSignedInSession(page);
    await installStubBackend(page, {
      role: "owner",
      serviceLines: ["pet_waste"],
      overrides: {
        listServices: () => ({ services }),
        createService: (draft) => {
          services = services.filter((s) => s.name !== "Pet waste removal");
          const id = `aaaaaaaa-0000-4000-8000-${String(8830 + services.length).padStart(12, "0")}`;
          services.push({ ...SERVICES[0], ...draft, id });
          return { id };
        },
      },
    });
    await page.goto("/settings/services");
    const list = page.getByTestId("services-list");
    // The row's NAME, not its line badge: since #883 the pet_waste line is
    // also called "Pet waste removal", so every pet-waste row's badge reads
    // the same words as the starter's name.
    const starter = list.locator(":scope > li span.font-medium", {
      hasText: /^Pet waste removal$/,
    });
    await expect(starter).toBeVisible({
      timeout: 120_000,
    });
    for (const name of ["Weekly scoop", "One-time cleanup"]) {
      await page.getByRole("button", { name: "Add service", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill(name);
      await dialog.getByRole("button", { name: "Add service", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(list.getByText(name, { exact: true })).toBeVisible();
      await expect(starter).toHaveCount(0);
    }
    await expect(list.locator(":scope > li")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await expect(page.getByText("Service added", { exact: true })).toHaveCount(0, {
      timeout: 15000,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    mkdirSync(".helm/screenshots/issue-883", { recursive: true });
    await page.screenshot({
      path: `.helm/screenshots/issue-883/services-after-add-${width}.png`,
      fullPage: true,
    });
  });
}
