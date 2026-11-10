/**
 * #807 follow-up (Product should-fix on #810): the two forms a teammate
 * sets a password on, in a real browser. #810 drove them in happy-dom only.
 *
 *   - The invitation link, /get-started?invite=… (JoinTeamPage). A staff
 *     invite (dispatcher, tech, manager) lands here from /invite/:token and
 *     /auth?invite=…; it is the only place a teammate chooses a password.
 *   - The pending-invite join (#651): an address typed on Get started that
 *     has an invitation waiting joins that business instead of building one.
 *     Its password was typed on the first step, so the join form has no
 *     password field until the auth server refuses that password.
 *
 * For each, at four widths with touch on below 1280:
 *   - the rules are listed under the password field before anything is typed
 *     (the pending-invite join's first step is that field);
 *   - a password that breaks a rule keeps "Create account and join" (or
 *     Continue) disabled and names the rule;
 *   - the auth server's leaked-password refusal, given RAW (GoTrue's own
 *     text, not the app's prefix), keeps the person on the form with the
 *     server's reason beside a password field and every other input intact.
 *
 * Every state is asserted on screen before it is measured.
 */
import { test, expect, type Page } from "@playwright/test";
import { installStubBackend, StubRefusal } from "./fixtures/stub-backend";
import { findControlsOffTheSide, findControlsUnder44px, measurePageOverflow } from "./rules";

// What Supabase Auth says when its leaked-password check refuses a password.
const LEAKED = "Password is known to be weak and easy to guess, please choose a different one.";
const INVITED_EMAIL = "dispatch.lead@houndstack-sweep.test";
const NAME = "Dee Spatcher-Okonkwo";
const PASSWORD = "password1234";
const BUSINESS = "Great Lakes Yard Patrol";

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

const refuseTheLeakedPassword = () => {
  throw new StubRefusal(LEAKED);
};

for (const size of WIDTHS) {
  test.describe(`${size.width}px`, () => {
    test.use({ viewport: size, hasTouch: size.width < 1280 });

    test("the invitation link: rules before typing, a weak password blocked, a refusal kept on the form", async ({
      page,
    }) => {
      await installStubBackend(page.context(), {
        overrides: {
          lookupInviteByToken: {
            ok: true,
            kind: "staff",
            email: INVITED_EMAIL,
            organization_name: BUSINESS,
            role: "dispatcher",
            role_label: "Dispatcher",
          },
          registerAccount: refuseTheLeakedPassword,
        },
      });
      await page.goto("/get-started?invite=sweep-invite-token");
      const join = page.getByRole("button", { name: "Create account and join" });
      await expect(page.getByRole("heading", { name: `Join ${BUSINESS}` })).toBeVisible({
        timeout: 20_000,
      });
      await hydrated(page, "#gs-pass");
      await expect(page.locator("#gs-email")).toHaveValue(INVITED_EMAIL);
      await expect(page.locator("[data-password-rules]")).toContainText("At least 8 characters");
      await expect(page.locator("[data-password-problem]")).toHaveCount(0);
      await measured(page, "invite join, nothing typed");

      await page.locator("#gs-name").fill(NAME);
      await page.locator("#gs-pass").fill("short");
      await expect(join).toBeDisabled();
      await expect(page.locator("[data-password-problem]")).toContainText("at least 8 characters");
      await measured(page, "invite join, weak password");

      await page.locator("#gs-pass").fill(PASSWORD);
      await expect(join).toBeEnabled();
      await join.click();

      await expect(page.locator("[data-password-server-error]")).toContainText("known to be weak", {
        timeout: 20_000,
      });
      await expect(page.locator("#gs-email")).toHaveValue(INVITED_EMAIL);
      await expect(page.locator("#gs-name")).toHaveValue(NAME);
      await expect(page.locator("#gs-pass")).toHaveValue(PASSWORD);
      await expect(page.getByRole("heading", { name: `Join ${BUSINESS}` })).toBeVisible();
      await expect(page).toHaveURL(/\/get-started\?invite=sweep-invite-token/);
      // Until a different password is typed, the same one is not sent again.
      await expect(join).toBeDisabled();
      await measured(page, "invite join, password refused");

      await page.locator("#gs-pass").fill("a much better passphrase");
      await expect(page.locator("[data-password-server-error]")).toHaveCount(0);
      await expect(join).toBeEnabled();
    });

    test("the pending-invite join: rules before typing, a weak password blocked, a refusal shows a password field", async ({
      page,
    }) => {
      await installStubBackend(page.context(), {
        overrides: {
          checkEmailAccount: { exists: false, pendingInvite: true },
          registerAccount: refuseTheLeakedPassword,
        },
      });
      await page.goto("/get-started");
      await hydrated(page, "#gs-pass");
      await expect(page.locator("[data-password-rules]")).toContainText("At least 8 characters");
      await page.locator("#gs-email").fill(INVITED_EMAIL);
      await page.locator("#gs-pass").fill("short");
      await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
      await expect(page.locator("[data-password-problem]")).toContainText("at least 8 characters");
      await measured(page, "account step, weak password");

      await page.locator("#gs-pass").fill(PASSWORD);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { name: "You have been invited" })).toBeVisible({
        timeout: 20_000,
      });
      // No password field yet: it was typed on the step before.
      await expect(page.locator("#gs-pass-join")).toHaveCount(0);
      await page.locator("#gs-name").fill(NAME);
      const join = page.getByRole("button", { name: "Create account and join" });
      await join.click();

      const field = page.locator("#gs-pass-join");
      await expect(field).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("[data-password-server-error]")).toContainText("known to be weak");
      await expect(field).toHaveValue(PASSWORD);
      await expect(page.locator("#gs-name")).toHaveValue(NAME);
      await expect(page.getByText(INVITED_EMAIL)).toBeVisible();
      await expect(page.getByRole("heading", { name: "You have been invited" })).toBeVisible();
      await expect(page.locator("[data-password-rules]")).toContainText("At least 8 characters");
      await expect(join).toBeDisabled();
      await measured(page, "pending-invite join, password refused");

      // The field stays while a replacement is typed, and checks it live.
      await field.fill("short");
      await expect(field).toBeVisible();
      await expect(join).toBeDisabled();
      await expect(page.locator("[data-password-problem]")).toContainText("at least 8 characters");
      await field.fill("a much better passphrase");
      await expect(join).toBeEnabled();
    });
  });
}
