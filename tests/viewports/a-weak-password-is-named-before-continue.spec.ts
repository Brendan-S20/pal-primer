/**
 * #807 in a real browser, at the four widths. Brendan, 2026-11-09: "it
 * doesn't tell you that the password is weak til you're all the way through,
 * it should tell you as you try to move from then."
 *
 * tests/a-weak-password-was-only-named-at-the-end.test.tsx drives the same
 * forms in happy-dom and proves the behaviour; this measures the states that
 * the public sweep never draws, because it only loads each page as it first
 * paints:
 *
 *   - Get started's Finish step after the auth server refused the password
 *     (its leaked-password check): a password field on that step, the
 *     server's reason beside it, everything else kept;
 *   - /reset-password's form itself (the sweep draws only its expired-link
 *     state), with the rules listed, a weak password blocked, and the
 *     server's refusal beside the field.
 *
 * Each state is asserted to be on screen before anything is measured, so a
 * page that drew something else cannot pass by being empty.
 */
import { test, expect, type Page } from "@playwright/test";
import { installStubBackend, StubRefusal } from "./fixtures/stub-backend";
import { installSignedInSession, SUPABASE_ORIGIN } from "./fixtures/session";
import { findControlsOffTheSide, findControlsUnder44px, measurePageOverflow } from "./rules";

const LEAKED = "Password is known to be weak and easy to guess, please choose a different one.";
const EMAIL = "new.owner@houndstack-sweep.test";
const PASSWORD = "password1234";
const BUSINESS = "Great Lakes Yard Patrol";
const NAME = "Robin Okafor-Lindqvist";

const WIDTHS = [
  { width: 360, height: 780 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

async function measured(page: Page, where: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: no sideways page scroll`).toBeLessThanOrEqual(innerW);
  expect(await findControlsOffTheSide(page), `${where}: every control on the page`).toEqual([]);
  if ((page.viewportSize()?.width ?? 0) < 768) {
    expect(await findControlsUnder44px(page), `${where}: 44px controls`).toEqual([]);
  }
}

async function hydrated(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => Object.keys(document.querySelector(sel) ?? {}).some((k) => k.startsWith("__react")),
    selector,
  );
}

for (const size of WIDTHS) {
  test.describe(`${size.width}px`, () => {
    test.use({ viewport: size, hasTouch: size.width < 1280 });

    test("Get started: rules before typing, a weak password blocked, a refusal kept on the Finish step", async ({
      page,
    }) => {
      await installStubBackend(page.context(), {
        overrides: {
          checkEmailAccount: { exists: false, pendingInvite: false },
          registerAccount: () => {
            // The auth server's own words, raw. registerAccount adds the
            // app's prefix on the server, which this stub stands in for;
            // the browser has to recognise the raw text too (#807
            // follow-up). The prefixed shape is pinned in
            // the-auth-servers-own-refusal-reaches-the-password-field.test.ts.
            throw new StubRefusal(LEAKED);
          },
        },
      });
      await page.goto("/get-started");
      await hydrated(page, "#gs-pass");
      const rules = page.locator("[data-password-rules]");
      await expect(rules).toContainText("At least 8 characters");
      await measured(page, "account step, nothing typed");

      await page.locator("#gs-email").fill(EMAIL);
      await page.locator("#gs-pass").fill("short");
      await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
      await expect(page.locator("[data-password-problem]")).toContainText("at least 8 characters");
      await measured(page, "account step, weak password");

      await page.locator("#gs-pass").fill(PASSWORD);
      await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator("#gs-org").fill(BUSINESS);
      await page.locator("#gs-name").fill(NAME);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Create my workspace" }).click();

      const field = page.locator("#gs-pass-again");
      await expect(field).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-password-server-error]")).toContainText("known to be weak");
      await expect(field).toHaveValue(PASSWORD);
      await expect(page.getByRole("heading", { name: "Create your account" })).toHaveCount(0);
      await measured(page, "Finish step, password refused");

      await page.getByRole("button", { name: "Back" }).click();
      await expect(page.locator("#gs-org")).toHaveValue(BUSINESS);
      await expect(page.locator("#gs-name")).toHaveValue(NAME);
    });

    test("Reset password: rules before typing, a weak password blocked, a refusal beside the field", async ({
      page,
    }) => {
      await installStubBackend(page.context());
      await installSignedInSession(page.context());
      await page.context().route(`${SUPABASE_ORIGIN}/auth/v1/user`, (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({
              status: 422,
              contentType: "application/json",
              body: JSON.stringify({
                code: 422,
                error_code: "weak_password",
                msg: LEAKED,
                weak_password: { reasons: ["pwned"] },
              }),
            })
          : route.fallback(),
      );
      await page.goto("/reset-password");
      const pw = page.locator("#pw");
      await expect(pw).toBeVisible({ timeout: 20_000 });
      await hydrated(page, "#pw");
      await expect(page.locator("[data-password-rules]")).toContainText("At least 8 characters");
      await measured(page, "reset form, nothing typed");

      await pw.fill("short");
      await page.locator("#pw2").fill("short");
      await expect(page.getByRole("button", { name: "Update password" })).toBeDisabled();
      await expect(page.locator("[data-password-problem]")).toContainText("at least 8 characters");
      await measured(page, "reset form, weak password");

      await pw.fill(PASSWORD);
      await page.locator("#pw2").fill(PASSWORD);
      await page.getByRole("button", { name: "Update password" }).click();
      await expect(page.locator("[data-password-server-error]")).toContainText("known to be weak", {
        timeout: 20_000,
      });
      await expect(pw).toHaveValue(PASSWORD);
      await expect(page.locator("#pw2")).toHaveValue(PASSWORD);
      await expect(page.getByText("This link can't be used.")).toHaveCount(0);
      await measured(page, "reset form, password refused");
    });
  });
}
