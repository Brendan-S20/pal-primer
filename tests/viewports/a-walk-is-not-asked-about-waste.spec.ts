/**
 * The visit checklist per line (#565), in a real browser.
 *
 * Two surfaces no sweep opens in this state:
 *
 *   - Settings → Business defaults → Edit checklist, for a business that
 *     scoops and walks: the list in groups (every visit, pet waste, dog
 *     walking), with a line picker on each row. The control is the same
 *     list for a pet-waste-only business: one list, no groups.
 *   - The same screen with a list saved before lines existed: its waste
 *     items have no line, so they are asked on every visit, and a callout
 *     names them with the one tap that moves them to pet waste.
 *   - My Day for a tech in that business: the walk stop draws the walking
 *     item and not the waste item; the scoop beside it (the control) draws
 *     the waste item and not the walking one. Both draw the every-visit item.
 *
 * Each state is proved by its own words before anything is measured, and
 * the other line's words are asserted ABSENT, so a fixture that fell back to
 * one shared list goes red. Screenshots at 360 and 1280 land in
 * docs/evidence/565/ when SHOTS=1.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, installStubBackend } from "./fixtures/stub-backend";
import { ORGANIZATION } from "./fixtures/dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [
  { w: 360, h: 780 },
  { w: 768, h: 1024 },
  { w: 1280, h: 800 },
  { w: 1920, h: 1080 },
];
const SHOTS = join(process.cwd(), "docs/evidence/565");
const SHOT_WIDTHS = [360, 1280];
const MIXED = ["pet_waste", "dog_walking"];

// Neutral on purpose: a walk and a scoop both latch the gate. A waste item
// with no line is the OLD case, drawn by its own test with the callout.
const EVERY = "Gate latched";
const OLD_WASTE = "All areas walked";
const WASTE = "Waste bagged and disposed";
const DOG = "Dog collected and returned";
const LIST = [
  { id: "c7a1e0de-0000-4000-8000-000000056501", label: EVERY, required: true },
  {
    id: "c7a1e0de-0000-4000-8000-000000056502",
    label: WASTE,
    required: true,
    line: "pet_waste",
  },
  {
    id: "c7a1e0de-0000-4000-8000-000000056503",
    label: DOG,
    required: true,
    line: "dog_walking",
  },
];

async function measure(page: Page, label: string, width: number) {
  await page.waitForTimeout(400);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label} @${width}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label} @${width}: clipped`).toEqual([]);
  expect(
    await findControlsNarrowerThanTheirLabel(page),
    `${label} @${width}: a button narrower than its label`,
  ).toEqual([]);
  if (width < 768) {
    expect(await findControlsUnder44px(page), `${label} @${width}: under 44px`).toEqual([]);
  }
  if (process.env.SHOTS && SHOT_WIDTHS.includes(width)) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${label}-${width}.png`), fullPage: true });
  }
}

// A list saved before lines existed, then one item added for walks.
const OLD_LIST = [
  { id: "c7a1e0de-0000-4000-8000-000000056511", label: OLD_WASTE, required: true },
  { id: "c7a1e0de-0000-4000-8000-000000056512", label: WASTE, required: true },
  { id: "c7a1e0de-0000-4000-8000-000000056513", label: EVERY, required: true },
  LIST[2],
];

function features(lines: string[], list: unknown[] = LIST) {
  return {
    ...(BASE_STUBS.getMyOrgFeatures as Record<string, unknown>),
    serviceLines: lines,
    visitChecklist: list,
  };
}

/** Two stops under way, the same shape, differing only by the service line. */
function mixedDay() {
  const day = (BASE_STUBS.getMyDay as () => { visits: any[]; [k: string]: unknown })();
  const [a, b] = day.visits;
  const startedAt = new Date(Date.now() - 22 * 60_000).toISOString();
  const shape = (v: any, name: string, services: Record<string, unknown>, seq: number) => ({
    ...v,
    status: "in_progress",
    started_at: startedAt,
    sequence: seq,
    services,
    clients: { ...v.clients, display_name: name },
  });
  return {
    ...day,
    visits: [
      shape(
        a,
        "Walk Client",
        { name: "30-minute walk", service_line: "dog_walking", default_duration_min: 30 },
        1,
      ),
      shape(
        b,
        "Scoop Client",
        { name: "Weekly cleanup", service_line: "pet_waste", default_duration_min: 20 },
        2,
      ),
    ],
  };
}

function card(page: Page, visitId: string): Locator {
  return page.locator(`li[id="visit-${visitId}"]`);
}

for (const { w, h } of WIDTHS) {
  test.describe(`@${w}px`, () => {
    test.use({ viewport: { width: w, height: h } });

    test("Settings: a business that scoops and walks sees the checklist by line", async ({
      page,
    }) => {
      await installSignedInSession(page);
      await installStubBackend(page, {
        role: "owner",
        serviceLines: MIXED,
        overrides: { getMyOrgFeatures: features(MIXED) },
      });
      await page.goto("/settings/business", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Edit checklist" }).click({ timeout: 45_000 });

      await expect(page.getByRole("heading", { name: "Every visit" })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Pet waste removal (scooping)" }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Dog walking" })).toBeVisible();
      await expect(page.getByText("Asked on dog walking visits only.")).toBeVisible();
      await expect(page.getByRole("combobox", { name: `Which visits ask ${WASTE}` })).toHaveText(
        "Pet waste removal (scooping)",
      );
      await expect(page.getByRole("textbox", { name: "Checklist item 1" })).toHaveValue(EVERY);
      // Nothing about waste is on every visit, so nothing to call out.
      await expect(page.getByRole("button", { name: "Ask on pet waste visits only" })).toHaveCount(
        0,
      );
      await measure(page, "settings-checklist-by-line", w);
    });

    test("Settings: an old list's waste items on every visit are called out", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, {
        role: "owner",
        serviceLines: MIXED,
        overrides: { getMyOrgFeatures: features(MIXED, OLD_LIST) },
      });
      await page.goto("/settings/business", { waitUntil: "domcontentloaded" });
      const callout = page.getByRole("region", { name: "Pet waste items asked on every visit" });
      // Seen before the editor is opened: the folded summary is where an owner lands.
      await expect(callout).toBeVisible({ timeout: 45_000 });
      await page.getByRole("button", { name: "Edit checklist" }).click();
      await expect(callout.getByText(`${OLD_WASTE}, ${WASTE}`)).toBeVisible();
      await expect(
        callout.getByText(
          "These are asked on every visit, including walks. Ask them on pet waste visits only?",
        ),
      ).toBeVisible();
      await expect(callout.getByText(EVERY)).toHaveCount(0);
      await expect(
        callout.getByRole("button", { name: "Ask on pet waste visits only" }),
      ).toBeVisible();
      await measure(page, "settings-checklist-old-waste-callout", w);
    });

    test("Settings control: a pet-waste-only business sees one list", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, {
        role: "owner",
        overrides: { getMyOrgFeatures: features(["pet_waste"]) },
      });
      await page.goto("/settings/business", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Edit checklist" }).click({ timeout: 45_000 });
      await expect(page.getByRole("textbox", { name: "Checklist item 2" })).toHaveValue(WASTE);
      await expect(page.getByRole("heading", { name: "Every visit" })).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: /Which visits ask/ })).toHaveCount(0);
      await measure(page, "settings-checklist-one-line", w);
    });

    test("My Day: the walk is not asked about waste; the scoop is", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, {
        role: "tech",
        serviceLines: MIXED,
        overrides: {
          getMyDay: mixedDay,
          getMyOrg: { organization: { ...ORGANIZATION, role: "tech", visit_checklist: LIST } },
        },
      });
      await page.goto("/my-day", { waitUntil: "domcontentloaded" });
      const [walkVisit, yardVisit] = mixedDay().visits;
      const walk = card(page, walkVisit.id);
      const yard = card(page, yardVisit.id);
      await expect(walk.getByText("Walk Client").first()).toBeVisible({ timeout: 45_000 });
      await expect(yard.getByText("Scoop Client").first()).toBeVisible();

      // The control: the scoop is asked the waste item, and not the walk's.
      await expect(yard.getByText(WASTE)).toBeVisible();
      await expect(yard.getByText(EVERY)).toBeVisible();
      await expect(yard.getByText(DOG)).toHaveCount(0);

      await expect(walk.getByText(DOG)).toBeVisible();
      await expect(walk.getByText(EVERY)).toBeVisible();
      await expect(walk.getByText(WASTE)).toHaveCount(0);
      await expect(walk.getByText(OLD_WASTE)).toHaveCount(0);
      await measure(page, "my-day-checklist-by-line", w);
      if (process.env.SHOTS && SHOT_WIDTHS.includes(w)) {
        await walk.scrollIntoViewIfNeeded();
        await walk.screenshot({ path: join(SHOTS, `my-day-walk-card-${w}.png`) });
        await yard.scrollIntoViewIfNeeded();
        await yard.screenshot({ path: join(SHOTS, `my-day-scoop-card-control-${w}.png`) });
      }
    });
  });
}
