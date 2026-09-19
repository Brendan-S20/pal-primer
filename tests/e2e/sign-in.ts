// Sign in the way a person does, and wait for the things a person does not
// have to think about.
//
// Extracted from the first spec so every later one gets the two lessons that
// cost the most to learn, rather than rediscovering them.

import { expect, type Page } from "@playwright/test";

export const OWNER = { email: "owner@e2e.houndstack.test", password: "e2e-owner-password-1" };

/**
 * Wait until React has actually attached.
 *
 * ── THE TRAP ──────────────────────────────────────────────────────────────
 *
 * This app is server-rendered. `page.goto()` resolves on `load`, which is
 * correct HTML with NO event handlers -- so the browser will happily type
 * into an input while React is not listening. The keystrokes land in the DOM,
 * React's state stays empty, and the server-rendered `disabled` on the submit
 * button never lifts.
 *
 * That cost two wrong diagnoses. `fill()` was blamed and swapped for real
 * keystrokes: no change. Then the page was blamed. A probe with a settle
 * before typing returned `{value: "owner@...", disabled: false,
 * hydrated: true}` -- the page had been right the whole time and the test was
 * early.
 *
 * It waits for a React fiber rather than for `networkidle` plus a sleep,
 * because a sleep passes today and rots into a flake on a slower machine. The
 * fiber is present exactly when handlers are attached and absent exactly when
 * typing would be swallowed, which is the real condition.
 */
export async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return Boolean(el && Object.keys(el).some((k) => k.startsWith("__react")));
    },
    selector,
    { timeout: 30_000 },
  );
}

/**
 * `/auth` is TWO stages: an email, submitted, and only then a password field.
 * A spec that fills both at once finds no password input, times out, and
 * reports "sign-in is broken" about a page working exactly as designed.
 */
export async function signIn(page: Page, who = OWNER) {
  await page.goto("/auth");
  await waitForHydration(page, 'input[type="email"]');

  const email = page.getByRole("textbox", { name: /email/i });
  await expect(email, "the email field on /auth").toBeVisible();
  await email.pressSequentially(who.email, { delay: 10 });

  const cont = page.getByRole("button", { name: /^continue$/i });
  await expect(cont, "Continue enables once the email is valid").toBeEnabled();
  await cont.click();

  const password = page.getByLabel(/password/i);
  await expect(password, "the password stage after submitting an email").toBeVisible();
  await password.fill(who.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await expect(page, "signed in and away from /auth").not.toHaveURL(/\/auth/, { timeout: 20_000 });
}
