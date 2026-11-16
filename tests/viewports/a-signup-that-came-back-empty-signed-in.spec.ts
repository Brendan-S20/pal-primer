/**
 * #882: during sign-up, after the password had been entered, a reload on
 * step 3 asked for the password again ("it is asked for again after the page
 * reloads"), for an account that already existed.
 *
 * "Create my workspace" registers the account and signs in before it builds
 * the business. A reload in between (the slow first submit #785 was about)
 * finds a session already stored on this device, and #785's restore asked
 * for the password anyway. Now the session is read back first
 * (lib/signup-resume.ts): signed in as the draft's address, step 3 carries
 * on without a password and finishes from where it stopped.
 *
 * Named so the `a-signup-that-came-back-empty` pattern in test:viewports:cases
 * selects it alongside #785's spec, the one it extends.
 *
 * Also pinned: a reload before anything was created still asks, and says why;
 * the password is never written to storage; and both states measure clean at
 * phone, tablet and desktop widths.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { installStubBackend } from "./fixtures/stub-backend";
import { SWEEP_USER_EMAIL } from "./fixtures/session";
import { findControlsOffTheSide, findControlsUnder44px, measurePageOverflow } from "./rules";

// The stub's sign-in answers with the sweep user's session, so the address
// typed is that user's: the session on the device belongs to this sign-up.
const EMAIL = SWEEP_USER_EMAIL;
const PASSWORD = "a-long-enough-password";
const BUSINESS = "Great Lakes Yard Patrol";
const NAME = "Robin Okafor-Lindqvist";

const WIDTHS = [
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

function serverFnName(route: Route): string {
  try {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}

async function measured(page: Page, where: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: no sideways page scroll`).toBeLessThanOrEqual(innerW);
  expect(await findControlsOffTheSide(page), `${where}: every control on the page`).toEqual([]);
  if ((page.viewportSize()?.width ?? 0) < 768) {
    expect(await findControlsUnder44px(page), `${where}: 44px controls`).toEqual([]);
  }
}

async function toFinishStep(page: Page) {
  await page.goto("/get-started");
  await page.waitForFunction(() =>
    Object.keys(document.querySelector("#gs-email") ?? {}).some((k) => k.startsWith("__react")),
  );
  await page.locator("#gs-email").fill(EMAIL);
  await page.locator("#gs-pass").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator("#gs-org").fill(BUSINESS);
  await page.locator("#gs-name").fill(NAME);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: "Create my workspace" })).toBeVisible();
}

async function nothingKept(page: Page) {
  const stored = await page.evaluate(() =>
    JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]),
  );
  expect(stored, "the password is never written to storage").not.toContain(PASSWORD);
}

for (const size of WIDTHS) {
  test.describe(`${size.width}px`, () => {
    test.use({ viewport: size, hasTouch: size.width < 1280 });

    test("a reload on step 3 after the account was made does not ask for the password", async ({
      page,
      context,
    }) => {
      const calls: string[] = [];
      let passwordGrants = 0;
      await installStubBackend(context, {
        overrides: {
          checkEmailAccount: { exists: false, pendingInvite: false },
          registerAccount: { ok: true },
          bootstrapOrganization: { promoStored: null },
        },
      });
      // No invitation waits for this address.
      await context.route("**/rest/v1/rpc/accept_org_invite_for_current_user", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: "null" }),
      );
      await context.route("**/auth/v1/token**", (route) => {
        if (new URL(route.request().url()).searchParams.get("grant_type") === "password") {
          passwordGrants++;
        }
        return route.fallback();
      });
      // The first business build never answers: the account exists, the
      // device is signed in, and the page is reloaded in that window.
      await context.route("**/_serverFn/**", (route) => {
        const name = serverFnName(route);
        calls.push(name);
        if (name === "bootstrapOrganization" && calls.filter((c) => c === name).length === 1) {
          return undefined;
        }
        return route.fallback();
      });

      await toFinishStep(page);
      await page.getByRole("button", { name: "Create my workspace" }).click();
      await expect(page.getByRole("button", { name: "Creating your workspace…" })).toBeVisible();
      await expect.poll(() => calls.includes("bootstrapOrganization")).toBe(true);

      await page.reload();

      await expect(
        page.getByText(/your account is created and you are still signed in/i),
      ).toBeVisible({ timeout: 20_000 });
      // Step 3, with no password prompt anywhere on it.
      await expect(page.getByRole("heading", { name: "Create your account" })).toHaveCount(0);
      await expect(page.locator("#gs-pass-again")).toHaveCount(0);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      await expect(page.getByText(/asked for again/i)).toHaveCount(0);
      const go = page.getByRole("button", { name: "Try again" });
      await expect(go).toBeEnabled();
      await nothingKept(page);
      await measured(page, "step 3, reloaded after the account was made");

      await go.click();
      await page.waitForURL(/\/onboarding/, { timeout: 20_000 });
      // One account, one sign-in with the password: the resume used neither.
      expect(calls.filter((c) => c === "registerAccount")).toHaveLength(1);
      expect(passwordGrants).toBe(1);
      expect(calls.filter((c) => c === "bootstrapOrganization")).toHaveLength(2);
    });

    test("a reload on step 3 before anything was made asks once, and says why", async ({
      page,
      context,
    }) => {
      await installStubBackend(context, {
        overrides: { checkEmailAccount: { exists: false, pendingInvite: false } },
      });
      await toFinishStep(page);
      await page.reload();

      const field = page.locator("#gs-pass-again");
      await expect(field).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(`Your account for ${EMAIL} is not created yet.`)).toBeVisible();
      await expect(page.getByRole("button", { name: "Create my workspace" })).toBeDisabled();
      await nothingKept(page);
      await measured(page, "step 3, reloaded before anything was made");
      await field.fill(PASSWORD);
      await expect(page.getByRole("button", { name: "Create my workspace" })).toBeEnabled();
    });
  });
}
