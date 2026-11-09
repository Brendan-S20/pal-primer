/**
 * #785 (b): a known-good owner password, submitted once in an isolated
 * Incognito window on build 78611cf3, "returned to the initial email page
 * with no visible error". The same password worked on the retry.
 *
 * ── WHAT THIS REPRODUCES ─────────────────────────────────────────────────
 *
 * /auth accepted the password, then handed the person to the router, and
 * the _authenticated guard asked the auth server AGAIN (getUser) on the very
 * next navigation. A refusal there, moments after the server had just said
 * yes, makes supabase-js drop the session it saved, and the guard redirects
 * to /auth: a signed-out sign-in page with nothing on it to say why.
 *
 * Measured here, on the stub backend, before the fix: a 403 from that one
 * getUser left the browser on /auth with no alert and no session.
 *
 * Two cases, because there are two fixes and each needs its own proof:
 *
 *   1. The refused re-ask itself. /auth now tells lib/offline/identity.ts the
 *      server just verified this user (trustFreshSignIn), so the guard does
 *      not re-ask on the first navigation and the person lands.
 *   2. Any OTHER way a session can be lost between "password accepted" and
 *      "page drawn" (here: the refresh token is refused, so supabase-js signs
 *      out on its own). That one still bounces, and must bounce LOUDLY: the
 *      password step, the email and password still in it, and an error that
 *      says the password was fine (lib/sign-in-handoff.ts).
 *
 * And the #764 Product note: Forgot password? shared one `loading` with Sign
 * in, so asking for a reset link turned the primary button into "Signing
 * in…" for the length of the request.
 *
 * Desktop Chrome, as QA ran it. Nothing here is about width.
 */
import { test, expect, type Page } from "@playwright/test";
import { installStubBackend } from "./fixtures/stub-backend";
import { SUPABASE_ORIGIN, SWEEP_USER_EMAIL } from "./fixtures/session";

const PASSWORD = "correct horse battery staple";

async function toPasswordStep(page: Page) {
  await page.goto("/auth");
  // Server-rendered: typing before React attaches is typing into nothing
  // (tests/e2e/sign-in.ts explains the trap).
  await page.waitForFunction(() =>
    Object.keys(document.querySelector("#si-email") ?? {}).some((k) => k.startsWith("__react")),
  );
  await page.locator("#si-email").pressSequentially(SWEEP_USER_EMAIL);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator("#si-pw")).toBeVisible();
}

async function stubSignIn(page: Page) {
  await installStubBackend(page.context(), {
    overrides: { checkEmailAccount: { exists: true } },
  });
  // The fixture's is_platform_admin answers `[]`, which the landing reads as
  // truthy and sends an owner to /platform. An owner is not a platform admin.
  await page
    .context()
    .route(`${SUPABASE_ORIGIN}/rest/v1/rpc/is_platform_admin`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "false" }),
    );
}

const hasSession = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).some((k) => /auth-token/.test(k)));

test("a refusal from the auth server right after a good password does not bounce", async ({
  page,
}) => {
  await stubSignIn(page);
  let accepted = false;
  let refused = 0;
  await page.context().route(`${SUPABASE_ORIGIN}/auth/v1/token**`, (route) => {
    accepted = true;
    return route.fallback();
  });
  // Exactly once, and only after the password was accepted: the shape of the
  // QA run, where the retry worked.
  await page.context().route(`${SUPABASE_ORIGIN}/auth/v1/user`, (route) => {
    if (!accepted || refused > 0) return route.fallback();
    refused += 1;
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        code: 403,
        error_code: "session_not_found",
        msg: "Session from session_id claim in JWT does not exist",
      }),
    });
  });

  await toPasswordStep(page);
  await page.locator("#si-pw").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  // The URL moves to /dashboard the moment the navigation STARTS, before the
  // guard has answered, so the URL alone passes on the broken build. The
  // dashboard's own content is drawn only once the guard has let them in.
  await expect(
    page.getByText("Today's schedule", { exact: false }).first(),
    "a good password lands on the dashboard, not back on /auth",
  ).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.locator("#si-pw")).toHaveCount(0);
  expect(await hasSession(page), "and the session it was given is still there").toBe(true);
});

test("a session lost after the password was accepted comes back with a reason, not a blank form", async ({
  page,
}) => {
  await stubSignIn(page);
  // Signed out in another tab while this one was still working out where to
  // land: what a shared browser, or a second window, does. Exactly what
  // supabase-js's own cross-tab sign-out does: the shared storage entry goes,
  // and the other tab hears SIGNED_OUT on the channel named after the key.
  // Whatever the cause in the field, this is the state the guard finds, and
  // it sends the person to /auth.
  let signedOutElsewhere = false;
  await page.context().route(`${SUPABASE_ORIGIN}/rest/v1/rpc/is_platform_admin`, async (route) => {
    if (!signedOutElsewhere) {
      signedOutElsewhere = true;
      await page.evaluate(() => {
        localStorage.removeItem("sb-houndstack-auth-token");
        const channel = new BroadcastChannel("sb-houndstack-auth-token");
        channel.postMessage({ event: "SIGNED_OUT", session: null });
        channel.close();
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "false" });
  });

  await toPasswordStep(page);
  await page.locator("#si-pw").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  const alert = page.getByRole("alert");
  await expect(alert, "the bounce says what happened").toContainText(
    /password was accepted, but we couldn't finish signing you in/i,
    { timeout: 20_000 },
  );
  await expect(page).toHaveURL(/\/auth/);
  // The password step, with what was typed still in it. Not the email step.
  await expect(page.locator("#si-email")).toHaveCount(0);
  await expect(page.locator("#si-pw")).toHaveValue(PASSWORD);
  await expect(page.getByText(SWEEP_USER_EMAIL)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("Forgot password? says it is sending a link, never Signing in…", async ({ page }) => {
  await stubSignIn(page);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.context().route(`${SUPABASE_ORIGIN}/auth/v1/recover**`, async (route) => {
    await held;
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await toPasswordStep(page);
  await page.getByRole("button", { name: "Forgot password?" }).click();

  await expect(page.getByRole("button", { name: "Sending reset link…" })).toBeVisible();
  await expect(page.getByText("Signing in…")).toHaveCount(0);
  // The primary button is still the sign-in button, just not pressable.
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();

  release();
  await expect(page.getByRole("status")).toContainText(/reset link/i);
  await expect(page.getByRole("button", { name: "Forgot password?" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
});
