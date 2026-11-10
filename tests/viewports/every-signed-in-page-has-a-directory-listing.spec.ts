// Settings → Directory listing (#630, phase 1) at the four widths, signed in
// as the owner, with a profile drawn from data rather than the empty state
// the unlisted-route sweep sees.
//
// Named so `npm run test:viewports:auth` (playwright test every-signed-in-page)
// selects it, with no new script. Uses the shared stub through its
// `overrides` option and does not edit fixtures/stub-backend.ts (#733).
//
// Set DIRECTORY_SCREENSHOTS=<dir> to write one PNG per width.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

const MY_PROFILE = {
  canEdit: true,
  orgName: "Wagging Tails Professional Pet Waste Services",
  hasLogo: true,
  zoneZips: Array.from({ length: 24 }, (_, i) => String(48201 + i)),
  services: [
    {
      id: "5d000000-0000-4000-8000-000000000001",
      name: "Weekly yard cleanup with gate check and photo",
      service_line: "pet_waste",
      price_unit: "visit",
      base_price_cents: 1800,
      active: true,
    },
    {
      id: "5d000000-0000-4000-8000-000000000002",
      name: "30-minute walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2500,
      active: true,
    },
    {
      id: "5d000000-0000-4000-8000-000000000003",
      name: "Old monthly plan",
      service_line: "pet_waste",
      price_unit: "visit",
      base_price_cents: null,
      active: false,
    },
  ],
  profile: {
    slug: "wagging-tails-professional-pet-waste-services",
    published: true,
    display_name: "Wagging Tails Professional Pet Waste Services",
    show_logo: true,
    bio: "Family-owned since 2014. We scoop weekly or twice a week and lock every gate behind us.",
    coverage_zips: ["48201", "48202", "48203"],
    coverage_cities: ["Detroit", "Ferndale"],
    confirmed_at: "2026-11-01T12:00:00Z",
    listed: [{ service_id: "5d000000-0000-4000-8000-000000000001", price_from_cents: 1800 }],
  },
};

const SHOTS = process.env.DIRECTORY_SCREENSHOTS;

test.describe.configure({ mode: "parallel" });

for (const { w, h, label } of WIDTHS) {
  test(`${label}: the directory listing settings fit, keep their controls, clip nothing`, async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context, { overrides: { getMyDirectoryProfile: MY_PROFILE } });
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/settings/directory");
    // Refuse to measure a page that did not render (the empty or failed
    // state is not what this spec is for).
    await expect(page.getByText("Listed in the directory")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Weekly yard cleanup with gate check and photo")).toBeVisible();
    await page.waitForTimeout(300);

    const overflow = await measurePageOverflow(page);
    expect(overflow.scrollW, `/settings/directory at ${w}px scrolls sideways`).toBeLessThanOrEqual(
      overflow.innerW + 1,
    );
    expect(await findControlsOffTheSide(page)).toEqual([]);
    expect(await findSilentlyClippedText(page)).toEqual([]);
    if (w < 768) expect(await findControlsUnder44px(page)).toEqual([]);

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `settings-${w}.png`), fullPage: true });
    }
  });
}

// The review moderation queue (#630): platform admins only, so the stub says
// this session is one. A review long enough to wrap, and all three states.
const QUEUE = [
  {
    id: "7d000000-0000-4000-8000-000000000001",
    business_name: "Wagging Tails Professional Pet Waste Services",
    profile_slug: "wagging-tails",
    rating: 2,
    body: "They skipped two weeks in October and nobody called. When they did come it was great, but I'd like a text when a visit is missed.",
    status: "pending",
    rejection_reason: null,
    created_at: "2026-11-01T12:00:00Z",
    updated_at: "2026-11-03T12:00:00Z",
    moderated_at: null,
    moderated_by: null,
  },
  {
    id: "7d000000-0000-4000-8000-000000000002",
    business_name: "Doo Be Gone",
    profile_slug: "doo-be-gone",
    rating: 5,
    body: "Great.",
    status: "pending",
    rejection_reason: null,
    created_at: "2026-11-02T12:00:00Z",
    updated_at: "2026-11-02T12:00:00Z",
    moderated_at: null,
    moderated_by: null,
  },
];

for (const { w, h, label } of WIDTHS) {
  test(`${label}: the review moderation queue fits, keeps its controls, clips nothing`, async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context, {
      overrides: {
        getPlatformContext: {
          isPlatformAdmin: true,
          userId: "00000000-0000-4000-8000-000000000001",
        },
        listDirectoryReviewQueue: { reviews: QUEUE },
      },
    });
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/platform/directory-reviews");
    await expect(page.getByRole("heading", { name: "Directory reviews" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("They skipped two weeks in October")).toBeVisible();
    await page.waitForTimeout(300);

    const overflow = await measurePageOverflow(page);
    expect(
      overflow.scrollW,
      `/platform/directory-reviews at ${w}px scrolls sideways`,
    ).toBeLessThanOrEqual(overflow.innerW + 1);
    expect(await findControlsOffTheSide(page)).toEqual([]);
    expect(await findSilentlyClippedText(page)).toEqual([]);

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `moderation-${w}.png`), fullPage: true });
    }
  });
}
