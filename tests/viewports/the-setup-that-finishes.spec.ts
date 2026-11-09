/**
 * The guided setup, walked to Done, at the widths a person actually holds,
 * with touch ON.
 *
 * ── WHAT THE OWNER SAID ───────────────────────────────────────────────────
 *
 * "Onboarding process can be better, the walk through tour isn't too
 * productive and isn't allowed to continue through all the way."
 *
 * The tour was a `fixed inset-0 z-[100]` overlay walking eight menu entries.
 * At 768 and 1280 it put its own card, Next and Skip included, above the top
 * of the screen at step 6 of 8 (tests/the-tour-that-would-not-finish.test.ts
 * has the cause), and finishing it set nothing up. It is gone. The guided setup is a page,
 * /setup, walking the same six steps as the dashboard checklist, each done in
 * place; off that page a banner in the flow takes the owner back.
 *
 * ── WHAT THIS PROVES, AT EACH WIDTH ───────────────────────────────────────
 *
 *   * a first sign-in is offered the setup, by a banner, not an overlay;
 *   * every step renders its own panel and a way forward, and the controls
 *     that move through it are on screen and at least 44px on touch;
 *   * leaving for /clients/new and coming back lands on the same step, and so
 *     does a reload;
 *   * Back works, Skip works, and the last step finishes;
 *   * finishing is remembered for this person, on the device AND on the
 *     account, and survives a reload;
 *   * the dashboard checklist opens it again, at the first open step.
 *
 * Nothing here saves a form: the stub answers writes with null and the
 * fixture's progress never changes, so "Save and continue" would prove the
 * stub rather than the page. What is walked is the part that strands
 * people when it breaks: getting from step 1 to Done.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession, sweepUser, SUPABASE_ORIGIN } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  findControlsOffTheSide,
  findControlsUnder44px,
  measurePageOverflow,
} from "./rules";

/** The fixture's six steps, in order, and which are already done there. */
const STEPS = [
  { id: "business", done: true },
  { id: "zones", done: true },
  { id: "clients", done: false },
  { id: "staff", done: true },
  { id: "dump_site", done: false },
  { id: "payouts", done: false },
] as const;

const SIZES = [
  { width: 360, height: 780, label: "a small phone" },
  { width: 768, height: 1024, label: "an iPad in portrait" },
  { width: 1280, height: 800, label: "a small laptop" },
  { width: 1920, height: 1080, label: "a wide monitor" },
];

const SHOTS = "test-results/the-setup-that-finishes";

/** A user who has never seen the guide, whose metadata writes are kept. */
async function freshOwner(page: Page) {
  const context = page.context();
  await installSignedInSession(context);
  await installStubBackend(context);
  let user = { ...sweepUser(), user_metadata: { full_name: "Dana Whitfield-Ramirez" } };
  const writes: Array<Record<string, unknown>> = [];
  // Registered after the stub, so it wins for this one path: the stub would
  // answer with the sweep user, whose `tour_seen_at` closes the guide.
  await context.route(`${SUPABASE_ORIGIN}/auth/v1/user`, async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { data?: Record<string, unknown> };
      writes.push(body.data ?? {});
      user = { ...user, user_metadata: { ...user.user_metadata, ...(body.data ?? {}) } };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(user),
    });
  });
  return { writes, userId: user.id };
}

/** The step on screen, from the page's own markup. */
const currentStep = (page: Page) =>
  page.locator("[data-setup-step]").getAttribute("data-setup-step");

/** Every control that moves through the guide is on screen, reachable, and a
 *  thumb's size; and the page around it is not wider than the screen. */
async function expectStepIsUsable(page: Page, width: number, height: number, id: string) {
  await expect(page.locator(`[data-setup-step="${id}"]`)).toBeVisible();
  const forward = page.locator('[data-setup-action="next"], [data-setup-action="skip"], [data-setup-action="done"]');
  await expect(forward, `step ${id} has exactly one way forward`).toHaveCount(1);

  // From the top of the page, as the step arrives: Back and the way forward
  // must already be on screen, WITHOUT scrolling. The footer is sticky for
  // exactly this; a step taller than a phone does not get to hide them.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  for (const [name, control] of [
    ["the way forward", forward],
    ["Back", page.locator('[data-setup-action="back"]')],
    ["Finish later", page.locator('[data-setup-action="later"]')],
  ] as const) {
    if ((await control.count()) === 0) continue;
    const box = await control.boundingBox();
    expect(box, `step ${id}: ${name} has no box`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `step ${id}: ${name} runs off the right at ${width}px`).toBeLessThanOrEqual(width);
    expect(box!.y, `step ${id}: ${name} is above the screen`).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, `step ${id}: ${name} is below the screen at ${width}x${height}`).toBeLessThanOrEqual(height);
    expect(box!.height, `step ${id}: ${name} is ${box!.height}px tall on touch`).toBeGreaterThanOrEqual(44);
    // On screen (above) AND hit-testable: nothing is drawn over it. The tour
    // this replaced failed the first half at 768 and 1280, with its Next
    // button 73px above the top of the viewport under a dimmed layer.
    //
    // Polled, because a step change is a page transition (styles.css, PAGE
    // TRANSITIONS) and while one runs the whole viewport is the transition's
    // snapshot: elementFromPoint answers <html> for every point on the page.
    await expect
      .poll(
        () =>
          control.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!top && (top === el || el.contains(top));
          }),
        { message: `step ${id}: something covers ${name} at ${width}px`, timeout: 3000 },
      )
      .toBe(true);
  }

  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `step ${id} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `step ${id} @${width}`).toEqual([]);
  expect(await findControlsUnder44px(page), `step ${id} @${width}`).toEqual([]);
}

for (const size of SIZES) {
  test.describe(`the guided setup on ${size.label} (${size.width}x${size.height}, touch)`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      isMobile: size.width < 768,
      hasTouch: true,
    });

    test("a first sign-in walks every step to Done, and it stays done", async ({ page }) => {
      const { writes, userId } = await freshOwner(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));

      // ── Offered, by a banner in the flow ──────────────────────────────
      await page.goto("/dashboard");
      const banner = page.getByTestId("setup-guide-banner");
      await expect(banner).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // Three of the fixture's six steps are already done, so the banner
      // says so on a device that has never opened /setup: "Start setup"
      // here was D5 (onboarding audit 2026-11-09), "5 of 6 steps done" on
      // the dashboard under a banner offering to start.
      await expect(banner).toContainText("Setup: 3 of 6 done.");
      await expect(banner).not.toContainText("Start setup");
      await banner.getByRole("link", { name: "Continue setup (3 of 6)" }).click();

      // The first step still open in the fixture, not step 1: the owner is
      // taken to the next thing to do.
      await expect(page).toHaveURL(/\/setup\?step=clients/);
      expect(await currentStep(page)).toBe("clients");
      await expectStepIsUsable(page, size.width, size.height, "clients");

      // ── Leaving for the real form, and coming back ────────────────────
      await page.locator('[data-setup-action="add-client"]').click();
      await expect(page).toHaveURL(/\/clients\/new/);
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Next: Add or import clients");
      await banner.getByRole("link", { name: "Continue setup" }).click();
      await expect(page).toHaveURL(/\/setup\?step=clients/);

      // ── Back to the start ─────────────────────────────────────────────
      await page.locator('[data-setup-action="back"]').click();
      await expect(page.locator('[data-setup-step="zones"]')).toBeVisible();
      await page.locator('[data-setup-action="back"]').click();
      await expect(page.locator('[data-setup-step="business"]')).toBeVisible();
      await expect(page.locator('[data-setup-action="back"]')).toHaveCount(0);

      // ── And forward, every step, to Done ──────────────────────────────
      for (const [i, step] of STEPS.entries()) {
        await expect(page.locator(`[data-setup-step="${step.id}"]`)).toBeVisible();
        await expectStepIsUsable(page, size.width, size.height, step.id);
        await page.screenshot({ path: `${SHOTS}/${size.width}-${i + 1}-${step.id}.png` });

        // A reload in the middle lands on the same step.
        if (step.id === "staff") {
          await page.reload();
          await expect(page.locator('[data-setup-step="staff"]')).toBeVisible({
            timeout: FIRST_PAINT_MS,
          });
        }

        const last = i === STEPS.length - 1;
        const action = last ? "done" : step.done ? "next" : "skip";
        await page.locator(`[data-setup-action="${action}"]`).click();
      }

      // ── Finished, and remembered ──────────────────────────────────────
      await expect(page).toHaveURL(/\/dashboard/);
      await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
      await expect(banner).toHaveCount(0);
      expect(
        writes.some((w) => typeof w.tour_seen_at === "string"),
        "finishing did not reach the account",
      ).toBe(true);
      const local = await page.evaluate((id) => localStorage.getItem(`hs:tour-seen:${id}`), userId);
      expect(local, "finishing was not remembered on the device").not.toBeNull();

      await page.reload();
      await expect(page.getByTestId("onboarding-checklist")).toBeVisible({ timeout: FIRST_PAINT_MS });
      await page.waitForTimeout(1500);
      await expect(banner, "the banner came back after finishing").toHaveCount(0);

      // ── And the checklist opens it again ──────────────────────────────
      await page.getByTestId("setup-guide-me").click();
      await expect(page).toHaveURL(/\/setup\?step=clients/);
      await expect(page.locator('[data-setup-step="clients"]')).toBeVisible();
      expect(writes.some((w) => w.tour_seen_at === null), "re-opening did not reach the account").toBe(true);

      expect(errors, "the page threw on the way").toEqual([]);
    });

    test('"Not now" closes it for this person, and the checklist is still there', async ({
      page,
    }) => {
      const { writes } = await freshOwner(page);
      await page.goto("/dashboard");
      const banner = page.getByTestId("setup-guide-banner");
      await expect(banner).toBeVisible({ timeout: FIRST_PAINT_MS });
      const notNow = banner.getByRole("button", { name: "Not now" });
      const box = await notNow.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await notNow.click();
      await expect(banner).toHaveCount(0);
      expect(writes.some((w) => typeof w.tour_seen_at === "string")).toBe(true);
      await page.reload();
      await expect(page.getByTestId("onboarding-checklist")).toBeVisible({ timeout: FIRST_PAINT_MS });
      await page.waitForTimeout(1500);
      await expect(banner).toHaveCount(0);
    });
  });
}
