// Directory photos (#630; mypets v2 step 5b) at every width, signed in on the
// stubbed backend:
//
//   * Settings → Directory listing → Photos, as the OWNER: three photos in
//     the three moderation states, and the add form with a file chosen, a
//     description typed and the attestation ticked, so the Upload button is
//     live and every control is drawn;
//   * /platform/directory-photos, as a platform admin: the queue with two
//     pending photos, one with a description at the 140-character limit.
//
// Named so `npm run test:viewports:auth` (playwright test every-signed-in-page)
// selects it, with no new script. Uses the shared stub through its
// `overrides` option and does not edit fixtures/stub-backend.ts (#733).
//
// The images are flat colour tiles made here, not photographs: a fixture
// needs something to draw, and a made-up tile cannot be mistaken for anyone's
// work or carry anyone's rights. Businesses are labelled TEST.
//
// Set DIRECTORY_PHOTO_SCREENSHOTS=<dir> to write one PNG per width (taken at
// 2x, for a person to look at).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

/** A flat colour tile as an SVG data URL: no text, no imagery. */
const tile = (hex: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${hex}"/></svg>`,
  )}`;

/** A real 1x1 PNG, for the file input. */
function onePixelPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = deflateSync(Buffer.from([0, 0x9c, 0xb8, 0xa8]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ORG = "08820000-0000-4000-8000-0000000000aa";

const MY_PHOTOS = {
  canEdit: true,
  folder: ORG,
  available: true,
  photos: [
    {
      id: "a8820000-0000-4000-8000-000000000001",
      alt: "A latched side gate after a weekly visit, with the yard behind it clear",
      position: 0,
      status: "approved",
      moderated_at: "2026-11-13T15:00:00Z",
      previewUrl: tile("#9cb8a8"),
    },
    {
      id: "a8820000-0000-4000-8000-000000000002",
      alt: "Back lawn after a cleanup",
      position: 1,
      status: "pending",
      moderated_at: null,
      previewUrl: tile("#c9b79c"),
    },
    {
      id: "a8820000-0000-4000-8000-000000000003",
      alt: "Our van at the curb",
      position: 2,
      status: "rejected",
      moderated_at: "2026-11-13T15:05:00Z",
      previewUrl: tile("#a3b4c8"),
    },
  ],
};

// The rest of Settings → Directory listing, so the page renders; its own
// spec (every-signed-in-page-has-a-directory-listing) measures those parts.
const MY_PROFILE = {
  canEdit: true,
  orgName: "QA TEST 882 Professional Pet Waste Services",
  hasLogo: false,
  zoneZips: ["48201", "48202"],
  services: [
    {
      id: "5d000000-0000-4000-8000-000000000001",
      name: "Weekly yard cleanup (TEST)",
      service_line: "pet_waste",
      price_unit: "visit",
      base_price_cents: 1800,
      active: true,
    },
  ],
  profile: {
    slug: "qa-test-882",
    published: true,
    display_name: "QA TEST 882 Professional Pet Waste Services",
    show_logo: false,
    bio: null,
    coverage_zips: ["48201", "48202"],
    coverage_cities: ["Detroit"],
    confirmed_at: "2026-11-01T12:00:00Z",
    tagline: null,
    highlights: [],
    areas: [],
    listed: [{ service_id: "5d000000-0000-4000-8000-000000000001", price_from_cents: 1800 }],
  },
  booking: {
    available: true,
    enabled: false,
    policyText: "",
    publicSignupEnabled: false,
    chargesEnabled: false,
  },
};

const QUEUE = [
  {
    id: "a8820000-0000-4000-8000-000000000011",
    business_name: "QA TEST 882 Professional Pet Waste Services",
    profile_slug: "qa-test-882",
    // Near the 140-character limit, so the card has to wrap it.
    alt: "A latched side gate after a weekly visit, the yard behind it clear and the bags tied by the bin, taken from the driveway at noon",
    position: 0,
    status: "pending",
    rights_attested_at: "2026-11-13T14:00:00Z",
    created_at: "2026-11-13T14:00:00Z",
    updated_at: "2026-11-13T14:00:00Z",
    moderated_at: null,
    moderated_by: null,
    imageUrl: tile("#9cb8a8"),
  },
  {
    id: "a8820000-0000-4000-8000-000000000012",
    business_name: "QA TEST 882b",
    profile_slug: "qa-test-882b",
    alt: "Back lawn after a cleanup",
    position: 1,
    status: "pending",
    rights_attested_at: "2026-11-13T14:10:00Z",
    created_at: "2026-11-13T14:10:00Z",
    updated_at: "2026-11-13T14:20:00Z",
    moderated_at: null,
    moderated_by: null,
    imageUrl: tile("#c9b79c"),
  },
];

const SHOTS = process.env.DIRECTORY_PHOTO_SCREENSHOTS;

test.describe.configure({ mode: "parallel" });
if (SHOTS) test.use({ deviceScaleFactor: 2 });

async function measure(page: Page, path: string, w: number) {
  const overflow = await measurePageOverflow(page);
  expect(overflow.scrollW, `${path} at ${w}px scrolls sideways`).toBeLessThanOrEqual(
    overflow.innerW + 1,
  );
  expect(await findControlsOffTheSide(page)).toEqual([]);
  expect(await findSilentlyClippedText(page)).toEqual([]);
  if (w < 768) expect(await findControlsUnder44px(page)).toEqual([]);
}

const SIZES = [...WIDTHS, { w: 390, h: 844, label: "390 · iPhone" }];

for (const { w, h, label } of SIZES) {
  test(`${label}: directory photos in Settings fit, keep their controls, show the attestation`, async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context, {
      overrides: { getMyDirectoryProfile: MY_PROFILE, getMyDirectoryPhotos: MY_PHOTOS },
    });
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/settings/directory");
    const section = page.locator("[data-directory-photos]");
    await expect(section.getByRole("heading", { name: "Photos" })).toBeVisible({ timeout: 30_000 });
    // Drawn from the fixture: all three states, not the empty one.
    await expect(section.getByText("Approved, shown on your listing")).toBeVisible();
    await expect(section.getByText("Waiting for review")).toBeVisible();
    await expect(section.getByText("Not approved, not shown")).toBeVisible();
    // Two count toward the eight: the rejected one does not.
    await expect(section.getByText("2 of 8")).toBeVisible();

    // The add form, filled in: file, description, attestation.
    const add = section.locator("[data-directory-photo-add]");
    const upload = add.getByRole("button", { name: "Upload photo" });
    await add.getByLabel("Photo", { exact: true }).setInputFiles({
      name: "gate.png",
      mimeType: "image/png",
      buffer: onePixelPng(),
    });
    await add.getByLabel("Description of this photo").fill("A latched gate after a visit");
    await expect(upload).toBeDisabled();
    await expect(add.locator("[data-directory-photo-attestation]")).toHaveText(
      "I took these or have the rights to use them, and they are not AI-generated",
    );
    await add.getByRole("checkbox").check();
    await expect(upload).toBeEnabled();
    // No credit line anywhere on the page.
    expect(await page.content()).not.toMatch(/photo by|pexels|unsplash/i);
    await page.waitForTimeout(300);

    await measure(page, "/settings/directory", w);

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      // For the picture only (after measuring): fixed and sticky chrome (the
      // top bar, the tab bar) is hidden, or a stitched element shot paints it
      // over the middle of the section. Hidden, not moved, so nothing reflows.
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
          const pos = getComputedStyle(el).position;
          if (pos === "fixed" || pos === "sticky") el.style.visibility = "hidden";
        }
      });
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({ path: join(SHOTS, `settings-directory-photos-${w}.png`) });
    }
  });

  test(`${label}: the photo moderation queue fits, keeps its controls, clips nothing`, async ({
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
        listDirectoryPhotoQueue: { photos: QUEUE },
      },
    });
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/platform/directory-photos");
    await expect(page.getByRole("heading", { name: "Directory photos" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("QA TEST 882b")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Reject", exact: true })).toHaveCount(2);
    expect(await page.content()).not.toMatch(/photo by|pexels|unsplash|directory-photos\//i);
    await page.waitForTimeout(300);

    await measure(page, "/platform/directory-photos", w);

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({
        path: join(SHOTS, `platform-directory-photos-${w}.png`),
        fullPage: true,
      });
    }
  });
}
