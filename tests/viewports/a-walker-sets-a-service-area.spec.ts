import { test, expect, type Page } from "@playwright/test";
import {
  WIDTHS,
  findControlsOffTheSide,
  findControlsUnder44px,
  findSilentlyClippedText,
  measurePageOverflow,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, SERVICE_AREA_PART } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

/**
 * #958: setup collects a service area for a walker, a sitter, a groomer and
 * a trainer, at every width.
 *
 * public_quote answers only for a ZIP some zone lists, and setup asked a
 * pet-waste business alone for its area, so a walker could finish setup and
 * be out of area to every client. The price step of a business that does not
 * scoop now has a "Your service area" part beside its own price, drawn as a
 * form that asks WHERE and nothing priced.
 *
 * For each line, at 360 / 768 / 1280 / 1920:
 *   * the area form is drawn, proved by its own data attribute and its own
 *     heading (not merely "the page rendered"), with the ZIP prefilled from
 *     the business address and no price, extra-dog or first-cleanup field;
 *   * nothing scrolls sideways, sits off the side, is clipped silently, or
 *     is under 44px below md;
 *   * Save sends createZone a circle with no price, and once the server says
 *     the area part is done the form gives way to "Add another area".
 *
 * Fixture data only: the stub backend's made-up Chicago business. Run with
 * `npm run test:viewports:cases`.
 */

type Step = Record<string, any>;

/** The price step each line is asked, as onboarding.functions words it. */
const LINES: Record<string, { lines: string[]; label: string; part: Step }> = {
  walking: {
    lines: ["dog_walking"],
    label: "Price your walks",
    part: {
      id: "walks",
      label: "Walks",
      description: "What a 30-minute walk and a 60-minute walk cost.",
      to: "/settings/services",
      cta: "Price walks",
    },
  },
  sitting: {
    lines: ["pet_sitting"],
    label: "Price your sitting services",
    part: {
      id: "stays",
      label: "Sitting",
      description:
        "Drop-in, Overnight stay and House sit prices, holiday dates and the deposit refund window.",
      to: "/settings/services",
      cta: "Review sitting prices",
    },
  },
  grooming: {
    lines: ["mobile_grooming"],
    label: "Review your grooming prices, vaccines and buffer",
    part: {
      id: "grooms",
      label: "Grooming",
      description: "The size grid, required vaccines, and setup, cleanup and travel minutes.",
      to: "/settings/services",
      cta: "Review grooming setup",
    },
  },
  training: {
    lines: ["training"],
    label: "Price your lessons",
    part: {
      id: "lessons",
      label: "Training",
      description: "Price your lesson package, turn it on, and add the skills a trainer scores.",
      to: "/settings/services",
      cta: "Price lessons",
    },
  },
};

async function open(page: Page, which: keyof typeof LINES, width: number, height: number) {
  const { lines, label, part } = LINES[which];
  const state = { zoneSaved: false, sent: null as Record<string, any> | null };
  await page.setViewportSize({ width, height });
  await installSignedInSession(page.context());
  const report = await installStubBackend(page.context(), {
    role: "owner",
    serviceLines: lines,
    overrides: {
      // The server's answer for this line, read fresh each time: the area
      // part ticks once createZone has been asked, as the zone count would.
      getOnboardingStatus: () => {
        const steps = BASE_STEPS.map((st) =>
          st.id === "zones"
            ? {
                ...st,
                label,
                done: false,
                to: "/setup",
                gate: "/settings/services",
                parts: [
                  { ...SERVICE_AREA_PART, done: state.zoneSaved },
                  { ...part, done: false },
                ],
              }
            : st,
        );
        return { steps, completed: 1, total: steps.length, dismissed: false, emailVerified: true };
      },
      createZone: (args: Record<string, any>) => {
        state.sent = args?.data ?? args;
        state.zoneSaved = true;
        return { id: "aaaaaaaa-0000-4000-8000-00000000e958" };
      },
    },
  });
  await page.goto("/setup?step=zones", { waitUntil: "domcontentloaded" });
  return { state, report };
}

/** The other five steps, only so /setup has its six; their content is not
 *  what is measured here. */
const BASE_STEPS: Step[] = ["business", "zones", "clients", "staff", "dump_site", "payouts"].map(
  (id) => ({
    id,
    label: id === "business" ? "Your business details" : `Step ${id}`,
    description: "",
    done: id === "business",
    to: "/setup",
    cta: "Open",
    gate: id === "payouts" ? "/payments" : id === "clients" ? "/clients" : "/settings/users",
  }),
);

async function measure(page: Page, width: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

for (const { w, h } of WIDTHS) {
  for (const which of Object.keys(LINES) as Array<keyof typeof LINES>) {
    test(`#958 a ${which} business is asked where it works, with no price, on /setup @${w}px`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const { state } = await open(page, which, w, h);
      const step = page.locator('[data-setup-step="zones"]');
      await expect(step).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page.getByRole("heading", { name: LINES[which].label })).toBeVisible();

      // The area part, and the area-only form: not the pet-waste one.
      const area = page.locator('[data-setup-price-form="area"]');
      await expect(area.getByRole("heading", { name: "Your service area" })).toBeVisible();
      const form = area.locator("form[data-setup-service-area-form]");
      await expect(form).toBeVisible();
      await expect(page.locator("form[data-setup-area-form]")).toHaveCount(0);
      await expect(form.locator('input[type="number"]')).toHaveCount(0);
      await expect(form.getByText(/per visit|extra dog|first cleanup/i)).toHaveCount(0);
      // Prefilled from the business address, as #946 does for pet waste.
      const zip = form.getByLabel("ZIP code at the middle of your area");
      await expect(zip).toHaveValue("60611", { timeout: 15_000 });
      await expect(form.getByRole("button", { name: "15 miles" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await measure(page, w, `/setup service area (${which}) @${w}px`);

      // Save: a circle on the business's pin, no price, and the part ticks.
      await form.getByRole("button", { name: "25 miles" }).click();
      await form.locator('[data-setup-action="save-area"]').click();
      await expect(page.getByText("Service area saved").first()).toBeVisible({ timeout: 15_000 });
      expect(state.sent).toMatchObject({
        geoMatchMode: "radius",
        fillZipsFromShape: true,
        radiusMeters: Math.round(25 * 1609.344),
      });
      expect(Object.keys(state.sent ?? {}).join(" ")).not.toMatch(/Price|Cents|Cleanup/);
      await expect(area.locator("[data-setup-service-area-done]")).toBeVisible({
        timeout: 15_000,
      });
      await expect(area.getByRole("button", { name: "Add another area" })).toBeVisible();
      // The line's own price is still open, so the step stays.
      await expect(step).toBeVisible();
      await measure(page, w, `/setup service area saved (${which}) @${w}px`);
    });
  }
}
