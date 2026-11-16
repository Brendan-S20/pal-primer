/**
 * #785, the third time: "After sign-out, the sign-in form reset itself to the
 * blank email step after Continue (stale fill). It worked on retry." Tester,
 * live 3a028504, isolated Incognito, 2026-11-11. The fix in #799
 * (a-good-password-that-came-back-to-the-start.spec.ts) held for the case it
 * was written for and missed three others, each of which ends on the same
 * screen: the empty Work email step, Continue disabled, no error.
 *
 * ── WHAT THIS REPRODUCES ─────────────────────────────────────────────────
 *
 *   1. A STALE FILL. Signing out is a full page load of /auth, and in a cold
 *      Incognito window the server-rendered form is on screen, and takes
 *      typing, for seconds before React attaches. What was typed (or what the
 *      browser autofilled) is in the box and NOT in React's state, so Continue
 *      stays disabled, and the next render writes the empty state back over
 *      the box. Measured here before the fix: the email typed before
 *      hydration sat in the box with Continue disabled for good.
 *   2. A BOUNCE AFTER THE FIRST PAGE. #799 watched only the FIRST navigation
 *      after a good password. It landed, the hand-off was dropped, and when
 *      the session was lost a moment later the next navigation sent the
 *      person to a blank /auth with nothing to say why.
 *   3. A SLOW OR FAILING ANSWER. The form must stay on the password step,
 *      with what was typed, for as long as the auth server takes, and a
 *      failure of any shape must be said in words.
 *
 * And the Tester's own sequence end to end: sign in, sign out, sign in once.
 *
 * Desktop Chrome, as QA ran it. Nothing here is about width.
 */
import { test, expect, type Page } from "@playwright/test";
import { installStubBackend } from "./fixtures/stub-backend";
import { SUPABASE_ORIGIN, SWEEP_USER_EMAIL } from "./fixtures/session";

const PASSWORD = "correct horse battery staple";
const BOUNCED = /password was accepted, but we couldn't finish signing you in/i;

async function stubSignIn(page: Page) {
  await installStubBackend(page.context(), {
    overrides: { checkEmailAccount: { exists: true } },
  });
  // An owner is not a platform admin (see the #799 spec for why `[]` is not
  // a usable answer here).
  await page
    .context()
    .route(`${SUPABASE_ORIGIN}/rest/v1/rpc/is_platform_admin`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "false" }),
    );
}

const hydrated = (page: Page) =>
  page.waitForFunction(() =>
    Object.keys(document.querySelector("#si-email") ?? {}).some((k) => k.startsWith("__react")),
  );

async function toPasswordStep(page: Page) {
  await page.goto("/auth");
  await hydrated(page);
  await page.locator("#si-email").pressSequentially(SWEEP_USER_EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#si-pw")).toBeVisible();
}

async function signInFromPasswordStep(page: Page) {
  await page.locator("#si-pw").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

const onDashboard = (page: Page) =>
  expect(
    page.getByText("Today's schedule", { exact: false }).first(),
    "a good password lands on the dashboard",
  ).toBeVisible({ timeout: 30_000 });

/** Still on the password step, with what was typed in it. */
async function stillOnPasswordStep(page: Page, why: string) {
  await expect(page.locator("#si-email"), `${why}: not the email step`).toHaveCount(0);
  await expect(page.locator("#si-pw"), `${why}: the password is still there`).toHaveValue(PASSWORD);
  await expect(page.getByText(SWEEP_USER_EMAIL), `${why}: and the email`).toBeVisible();
}

test("a slow sign-in holds the password step until it answers, then lands", async ({ page }) => {
  await stubSignIn(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let asked = false;
  await page.context().route(`${SUPABASE_ORIGIN}/auth/v1/token**`, async (route) => {
    asked = true;
    await held;
    return route.fallback();
  });

  await toPasswordStep(page);
  await signInFromPasswordStep(page);
  await expect.poll(() => asked).toBe(true);
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();

  // Longer than the router's pending delay and the skeleton's, on purpose:
  // whatever was going to redraw the page while it waited has had its chance.
  await page.waitForTimeout(4_000);
  await stillOnPasswordStep(page, "while the auth server is slow");
  await expect(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);

  release();
  await onDashboard(page);
});

for (const failure of [
  {
    name: "a wrong password",
    reply: {
      status: 400,
      body: { error: "invalid_grant", error_description: "Invalid login credentials" },
    },
    says: /invalid login credentials/i,
  },
  {
    name: "a server error with nothing useful in it",
    reply: { status: 500, body: {} },
    says: /couldn't sign you in|try again/i,
  },
  { name: "no answer at all", reply: null, says: /couldn't sign you in|connection|try again/i },
]) {
  test(`${failure.name} stays on the password step and says so`, async ({ page }) => {
    await stubSignIn(page);
    await page.context().route(`${SUPABASE_ORIGIN}/auth/v1/token**`, (route) =>
      failure.reply
        ? route.fulfill({
            status: failure.reply.status,
            contentType: "application/json",
            body: JSON.stringify(failure.reply.body),
          })
        : route.abort("connectionreset"),
    );

    await toPasswordStep(page);
    await signInFromPasswordStep(page);

    const alert = page.getByRole("alert");
    await expect(alert, "a failure is said in words").toContainText(failure.says, {
      timeout: 20_000,
    });
    await expect(alert).not.toHaveText(/^\s*(\{\}|undefined|null)?\s*$/);
    await stillOnPasswordStep(page, `after ${failure.name}`);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/\/auth/);
  });
}

test("an email typed before the page was ready is kept, and Continue works", async ({ page }) => {
  await stubSignIn(page);
  // A cold Incognito load: warm the dev server first so the delay below is
  // the only slow thing, then hold every module long enough to type into
  // the server-rendered form before React attaches.
  await page.goto("/auth");
  await hydrated(page);
  await page.context().route(/\/(src|node_modules|@vite|@id|@fs)\//, async (route) => {
    await new Promise((r) => setTimeout(r, 60));
    return route.fallback();
  });
  await page.goto("/auth", { waitUntil: "commit" });
  await page.locator("#si-email").waitFor();
  await page.locator("#si-email").pressSequentially(SWEEP_USER_EMAIL);
  const early = await page.evaluate(() =>
    Object.keys(document.querySelector("#si-email") ?? {}).some((k) => k.startsWith("__react")),
  );
  expect(early, "the email went in before React attached, or this measures nothing").toBe(false);

  await hydrated(page);
  await expect(page.locator("#si-email")).toHaveValue(SWEEP_USER_EMAIL);
  const go = page.getByRole("button", { name: "Continue" });
  await expect(go, "what is in the box is what the form submits").toBeEnabled();
  await go.click();
  await expect(page.locator("#si-pw")).toBeVisible();
  await expect(page.getByText(SWEEP_USER_EMAIL)).toBeVisible();
});

test("a session lost after the first page drew still comes back with a reason", async ({
  page,
}) => {
  await stubSignIn(page);
  await toPasswordStep(page);
  await signInFromPasswordStep(page);
  await onDashboard(page);

  // Signed out underneath the page (another tab, a refused refresh), and
  // then the person goes somewhere: the guard sends them to /auth. #799 had
  // dropped the hand-off the moment /dashboard drew, so this was the blank
  // email step.
  await page.evaluate(() => {
    localStorage.removeItem("sb-houndstack-auth-token");
    const channel = new BroadcastChannel("sb-houndstack-auth-token");
    channel.postMessage({ event: "SIGNED_OUT", session: null });
    channel.close();
  });
  await page.getByRole("link", { name: "Clients" }).first().click();

  await expect(page.getByRole("alert"), "the bounce says what happened").toContainText(BOUNCED, {
    timeout: 20_000,
  });
  await expect(page).toHaveURL(/\/auth/);
  await stillOnPasswordStep(page, "after a bounce from a later page");
});

test("sign in, sign out, sign in once: lands, and is never called a failure", async ({ page }) => {
  await stubSignIn(page);
  await toPasswordStep(page);
  await signInFromPasswordStep(page);
  await onDashboard(page);

  await page.getByRole("button", { name: "Your account" }).first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL(/\/auth/);
  await hydrated(page);
  // A sign-out on purpose is a first visit: the email step, and no
  // "couldn't finish signing you in" left over from the sign-in before it.
  await expect(page.locator("#si-email")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.locator("#si-email").pressSequentially(SWEEP_USER_EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#si-pw")).toBeVisible();
  await signInFromPasswordStep(page);
  await onDashboard(page);
  await expect(page).toHaveURL(/\/dashboard/);
});
