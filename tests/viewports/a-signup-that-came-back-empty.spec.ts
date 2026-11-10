/**
 * #785 (a): "Your business", Continue, "Create my workspace" (the first submit
 * took about 15 seconds), and the page dropped back to a BLANK "Create your
 * account": email and password empty, no error, no account. The second
 * attempt worked.
 *
 * QA flagged a possible crossover with other sessions in the same shared
 * browser, so the trigger is not pinned. What is pinned is the outcome:
 * every field on /get-started was component state, so ANY fresh draw of the
 * page in the middle of a create (a reload, a remount, a second tab) started
 * it again from nothing, silently. Here the page is reloaded while the create
 * is still working, which is the most direct way to draw it afresh.
 *
 * And the plain failure: a create the server refuses keeps everything typed
 * and says what went wrong.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { installStubBackend } from "./fixtures/stub-backend";

const EMAIL = "new.owner@houndstack-sweep.test";
const PASSWORD = "a-long-enough-password";
const BUSINESS = "Great Lakes Yard Patrol";
const NAME = "Robin Okafor-Lindqvist";

function serverFnName(route: Route): string {
  try {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
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

test.beforeEach(async ({ context }) => {
  await installStubBackend(context, {
    overrides: { checkEmailAccount: { exists: false, pendingInvite: false } },
  });
});

test("a create interrupted by a fresh page comes back where it was, and says so", async ({
  page,
}) => {
  // The create that never answers: QA's 15-second first submit, stopped
  // short by the page being drawn again.
  await page
    .context()
    .route("**/_serverFn/**", (route) =>
      serverFnName(route) === "registerAccount" ? undefined : route.fallback(),
    );
  await toFinishStep(page);
  await page.getByRole("button", { name: "Create my workspace" }).click();
  await expect(page.getByRole("button", { name: "Creating your workspace…" })).toBeVisible();

  await page.reload();

  await expect(page.getByText(/creating your workspace was interrupted/i)).toBeVisible({
    timeout: 20_000,
  });
  // Not the blank first step QA saw.
  await expect(page.getByRole("heading", { name: "Create your account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create my workspace" })).toBeVisible();
  // The password is never kept, so it is asked for once more, here.
  await expect(page.getByRole("button", { name: "Create my workspace" })).toBeDisabled();
  await page.locator("#gs-pass-again").fill(PASSWORD);
  await expect(page.getByRole("button", { name: "Create my workspace" })).toBeEnabled();
  expect(
    await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage))),
    "the password is never written to storage",
  ).not.toContain(PASSWORD);

  // And the earlier steps still hold what was typed.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#gs-org")).toHaveValue(BUSINESS);
  await expect(page.locator("#gs-name")).toHaveValue(NAME);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#gs-email")).toHaveValue(EMAIL);
});

test("a create the server refuses keeps everything and says why", async ({ page }) => {
  await page.context().route("**/_serverFn/**", (route) =>
    serverFnName(route) === "registerAccount"
      ? route.fulfill({
          status: 500,
          contentType: "text/plain",
          body: "Could not create the account right now.",
        })
      : route.fallback(),
  );
  await toFinishStep(page);
  await page.getByRole("button", { name: "Create my workspace" }).click();

  await expect(page.locator("p.text-destructive")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Create your account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create my workspace" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.locator("#gs-org")).toHaveValue(BUSINESS);
  await expect(page.locator("#gs-name")).toHaveValue(NAME);
});
