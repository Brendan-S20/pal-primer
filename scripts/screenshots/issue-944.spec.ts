// #944 PR evidence: placeholders that read as real data, before and after.
//
// Stub backend only (tests/viewports/fixtures): no hosted database, nothing
// written. PHASE=before is run against origin/main's src, PHASE=after at the
// PR head; locators match either spelling of each hint. /setup's business
// address (the same hint as Settings > Business) is not shot: the stub org has
// finished setup, so that step does not draw.
//
//   PHASE=after npx playwright test -c scripts/screenshots/issue-944.config.ts
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { installSignedInSession } from "../../tests/viewports/fixtures/session";
import { installStubBackend } from "../../tests/viewports/fixtures/stub-backend";

const directory = ".helm/screenshots/issue-944-placeholders";
const phase = process.env.PHASE === "before" ? "before" : "after";

async function open(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await installSignedInSession(page);
  await installStubBackend(page, { role: "owner" });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function shoot(page: Page, width: number, state: string, extra: Record<string, unknown>) {
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(overflow.scrollWidth, `${state} @${width}: no horizontal page scroll`).toBeLessThanOrEqual(
    width + 1,
  );
  mkdirSync(directory, { recursive: true });
  const name = `${phase}-${state}-${width}`;
  await page.screenshot({ path: `${directory}/${name}.png` });
  writeFileSync(
    `${directory}/${name}.json`,
    JSON.stringify({ phase, state, width, ...overflow, ...extra }, null, 2) + "\n",
  );
}

const hints = (page: Page, sel: string) =>
  page.locator(sel).evaluateAll((els) =>
    els.map((e) => ({
      placeholder: e.getAttribute("placeholder"),
      autocomplete: e.getAttribute("autocomplete"),
      value: (e as HTMLInputElement).value,
    })),
  );

for (const width of [390, 1440]) {
  test(`#944 new client: contact and dogs @${width}`, async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, "/clients/new", width);
    const name = page.locator("#dn");
    await expect(name).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(1000);
    await shoot(page, width, "client-contact", {
      fields: await hints(page, "#dn, input[type=tel], input[placeholder*='555']"),
    });

    const next = page.getByRole("button", { name: "Continue", exact: true });
    await name.fill("QA Placeholder Client");
    await next.click();
    await page.locator("#st").fill("4417 North Wolcott Avenue");
    await page.keyboard.press("Escape");
    await page.locator("#ci").fill("Chicago");
    await page.locator("#rg").fill("IL");
    await page.locator("#pc").fill("60640");
    const dogName = page.getByPlaceholder(/Bailey$/).first();
    for (let i = 0; i < 4 && !(await dogName.isVisible()); i++) {
      await next.click();
      await page.waitForTimeout(500);
    }
    await expect(dogName).toBeVisible();
    const breed = page.getByPlaceholder(/Lab mix$/).first();
    // The tester's steps: something typed, then both boxes cleared.
    await dogName.fill("Rex");
    await breed.fill("Beagle");
    await dogName.fill("");
    await dogName.blur();
    await breed.fill("");
    await breed.blur();
    await expect(dogName).toHaveValue("");
    await expect(breed).toHaveValue("");
    await dogName.scrollIntoViewIfNeeded();
    await shoot(page, width, "dogs-cleared", {
      fields: await hints(page, "input[placeholder$='Bailey'], input[placeholder$='Lab mix']"),
    });
  });

  test(`#944 team: route start emptied @${width}`, async ({ page }) => {
    test.setTimeout(180_000);
    await open(page, "/settings/users", width);
    const routing = page.getByRole("button", { name: /Routing & addresses/ }).first();
    await expect(routing).toBeVisible({ timeout: 90_000 });
    await page.waitForTimeout(1000);
    await routing.click();
    const start = page.getByPlaceholder(/Main St, Austin|Street, city/).first();
    await expect(start).toBeVisible();
    await start.fill("");
    await page.keyboard.press("Escape");
    await start.blur();
    await start.scrollIntoViewIfNeeded();
    await shoot(page, width, "team-route-start", {
      fields: await hints(
        page,
        "input[placeholder*='Main St, Austin'], input[placeholder^='Street, city']",
      ),
    });
  });

  for (const [state, path, id] of [
    ["business-address", "/settings/business", "#business-address"],
    ["portal-address", "/settings/client-portal", "#portal-address"],
  ] as const) {
    test(`#944 ${state} emptied @${width}`, async ({ page }) => {
      test.setTimeout(180_000);
      await open(page, path, width);
      const address = page.locator(id);
      await expect(address).toBeVisible({ timeout: 90_000 });
      await page.waitForTimeout(1000);
      await address.fill("");
      await page.keyboard.press("Escape");
      await address.blur();
      await address.scrollIntoViewIfNeeded();
      await shoot(page, width, state, { fields: await hints(page, id) });
    });
  }
}
