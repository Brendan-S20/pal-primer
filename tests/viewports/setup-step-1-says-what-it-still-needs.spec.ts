/**
 * #942: guided setup step 1, on a business signup has just made.
 *
 * Seen live: a new business skipped the plan, ticked "Pet waste removal" on
 * step 1 and pressed Save and continue. The page stayed on step 1 and nothing
 * on it said what was missing. Signup never asks for an address, so a new
 * business has none, and step 1 refused the save for it in a toast: four
 * seconds at the top of the screen, while the owner was looking at the bar at
 * the bottom. Save itself was never disabled for a missing answer; it read as
 * if it were, because pressing it changed nothing on the form.
 *
 * Now the refusal stays beside the form (role=alert), names the field in
 * words, is what Save is described by (aria-describedby) and marks the field
 * aria-invalid, the way step 2 says why it did not save (#881). It goes away
 * as the field is fixed.
 *
 * On the stub backend only: no database, nothing written anywhere. The
 * business is the fixture's, reshaped into a new one: open steps, the column
 * default service line (unanswered, so nothing starts ticked) and, where the
 * case needs it, no address.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { measurePageOverflow } from "./rules";
import {
  OFFERED_SERVICE_LINES,
  SERVICE_LINE_LABEL,
  type ServiceLine,
} from "../../src/lib/service-lines";

const ADDRESS = "4413 North Ravenswood Manor Terrace, Chicago, IL 60611";
const SHOTS = "test-results/issue-942-setup-step1";

type Writes = { serviceLines: ServiceLine[][]; branding: Record<string, unknown>[] };

/** A business as signup leaves it, answered through the stub. */
async function newBusiness(
  context: BrowserContext,
  { address }: { address: string | null },
): Promise<Writes> {
  const writes: Writes = { serviceLines: [], branding: [] };
  const branding = BASE_STUBS.getOrgBranding as Record<string, unknown>;
  const onboarding = BASE_STUBS.getOnboardingStatus as {
    steps: Array<Record<string, unknown>>;
  };
  await installSignedInSession(context);
  await installStubBackend(context, {
    overrides: {
      getOrgBranding: {
        ...branding,
        contact_phone: null,
        contact_address: address,
        contact_email: null,
        latitude: address ? branding.latitude : null,
        longitude: address ? branding.longitude : null,
      },
      // Every step open: this business has done none of them.
      getOnboardingStatus: {
        ...onboarding,
        completed: 0,
        steps: onboarding.steps.map((s) => ({ ...s, done: false })),
      },
      // The column defaults, as Postgres returns a time.
      getDispatchSettings: {
        settings: { workday_start: "08:00:00", workday_end: "17:00:00", timezone: null },
      },
      // On its free trial, which is what skipping the plan leaves.
      getTrialState: {
        phase: "trialing",
        daysRemaining: 14,
        endsOn: "2026-11-30",
        restricted: false,
        canManageBilling: true,
      },
      // Recorded, not written: the stub has nowhere to write to.
      setServiceLines: (a) => {
        writes.serviceLines.push(a.lines);
        return { ok: true, serviceLines: a.lines };
      },
      updateOrgBranding: (a) => {
        writes.branding.push(a);
        return { ok: true };
      },
    },
  });
  return writes;
}

async function openStep1(page: Page) {
  await page.goto("/setup?step=business");
  await expect(page.locator('[data-setup-step="business"]')).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  // Drawn from data: the business's own name, not an empty form or /auth.
  await expect(page.locator("#setup-name")).not.toHaveValue("");
  const save = page.locator('[data-setup-action="save"]');
  await expect(save).toHaveText("Save and continue", { timeout: FIRST_PAINT_MS });
  return save;
}

test.describe("setup step 1 on a new business (#942)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const line of OFFERED_SERVICE_LINES) {
    test(`ticking ${SERVICE_LINE_LABEL[line]} enables Save, which saves it and opens step 2`, async ({
      page,
    }) => {
      const writes = await newBusiness(page.context(), { address: ADDRESS });
      const save = await openStep1(page);
      // Unanswered: nothing starts ticked (F-06).
      for (const l of OFFERED_SERVICE_LINES) {
        await expect(page.getByRole("checkbox", { name: SERVICE_LINE_LABEL[l] })).not.toBeChecked();
      }
      await page.getByRole("checkbox", { name: SERVICE_LINE_LABEL[line] }).click();
      await expect(page.getByRole("checkbox", { name: SERVICE_LINE_LABEL[line] })).toBeChecked();
      await expect(save).toBeEnabled();
      await save.click();

      await expect(page.locator('[data-setup-step="zones"]')).toBeVisible({ timeout: 10_000 });
      await expect(page).toHaveURL(/step=zones/);
      await expect(page.locator("[data-setup-error]")).toHaveCount(0);
      // The choice is the one stored. Pet waste removal is already the
      // stored value of a new business (the column default), so ticking it
      // writes nothing new; any other line is written as the only line.
      if (line === "pet_waste") expect(writes.serviceLines).toEqual([]);
      else expect(writes.serviceLines).toEqual([[line]]);
      expect(writes.branding).toHaveLength(1);
      expect(writes.branding[0].contactAddress).toBe(ADDRESS);
    });
  }

  test("with no address yet, Save says so beside the form, and the step saves once it is typed", async ({
    page,
  }) => {
    const writes = await newBusiness(page.context(), { address: null });
    const save = await openStep1(page);
    await page.getByRole("checkbox", { name: "Pet waste removal" }).click();
    await expect(save).toBeEnabled();
    await save.click();

    const alert = page.locator("[data-setup-error]");
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toHaveText("Add your business address. Routes start from it.");
    await expect(page).toHaveURL(/step=business/);
    // What Save, and the field it names, are described by.
    const id = await alert.getAttribute("id");
    expect(id).toBeTruthy();
    await expect(save).toHaveAttribute("aria-describedby", id!);
    await expect(page.locator("#setup-address")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#setup-address")).toHaveAttribute("aria-describedby", id!);
    // Never disabled for it: pressing again says it again.
    await expect(save).toBeEnabled();
    expect(writes.branding).toEqual([]);

    // Fixed, the message goes and the field is no longer marked.
    await page.locator("#setup-address").fill(ADDRESS);
    await expect(alert).toHaveCount(0);
    await expect(save).not.toHaveAttribute("aria-describedby", /.+/);
    await expect(page.locator("#setup-address")).not.toHaveAttribute("aria-invalid", "true");
    await save.click();
    await expect(page.locator('[data-setup-step="zones"]')).toBeVisible({ timeout: 10_000 });
    expect(writes.branding).toHaveLength(1);
  });

  test("with nothing ticked, Save names the services question", async ({ page }) => {
    await newBusiness(page.context(), { address: ADDRESS });
    const save = await openStep1(page);
    await save.click();
    const alert = page.locator("[data-setup-error]");
    await expect(alert).toHaveText("Choose the services you offer.");
    await expect(page.locator("[data-setup-service-lines]")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await page.getByRole("checkbox", { name: "Dog walking" }).click();
    await expect(alert).toHaveCount(0);
  });

  test("step 2 still says why it did not save (#881)", async ({ page }) => {
    await newBusiness(page.context(), { address: ADDRESS });
    const save = await openStep1(page);
    await page.getByRole("checkbox", { name: "Pet waste removal" }).click();
    await save.click();
    await expect(page.locator('[data-setup-step="zones"]')).toBeVisible({ timeout: 10_000 });
    const save2 = page.locator('[data-setup-action="save"]');
    await expect(save2).toHaveText("Save and continue", { timeout: FIRST_PAINT_MS });
    await save2.click();
    await expect(page.locator("[data-setup-error]")).toHaveText("Enter what you charge per visit.");
    await expect(page.locator("[data-setup-error]")).toHaveAttribute("role", "alert");
  });
});

// The screenshots the PR carries (.helm/screenshots/issue-942-setup-step1/),
// taken here so they are of exactly what the tests above assert.
for (const width of [390, 1280]) {
  test.describe(`setup step 1 screenshots at ${width}`, () => {
    test.use({
      viewport: { width, height: width < 768 ? 844 : 800 },
      isMobile: width < 768,
      hasTouch: width < 768,
    });

    test("ticked and enabled; then the reason, when the address is missing", async ({ page }) => {
      await newBusiness(page.context(), { address: null });
      const save = await openStep1(page);
      await page.getByRole("checkbox", { name: "Pet waste removal" }).click();
      await expect(save).toBeEnabled();
      await page.getByRole("checkbox", { name: "Pet waste removal" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/after-enabled-${width}.png` });

      await save.click();
      await expect(page.locator("[data-setup-error]")).toBeVisible();
      // The toast is the same sentence; let it go so the shot shows what stays.
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
      await page.screenshot({ path: `${SHOTS}/after-reason-${width}.png` });
      const { scrollW, innerW } = await measurePageOverflow(page);
      expect(scrollW, `the page scrolls sideways at ${width}`).toBeLessThanOrEqual(innerW);
    });
  });
}
