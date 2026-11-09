// HoundStack's pet-pro directory (#630, phase 1) at the four widths:
// search, compare, profile and quote, measured with the same rules as every
// public page (no sideways page scroll, nothing off the side, nothing clipped
// silently, 44px controls at 360), and the quote form submitted end to end in
// the browser.
//
// Named so `npm run test:viewports:public` (playwright test every-public-page)
// selects it: the "Four widths" job runs it on every PR, with no new script.
//
// Its own stubs, not fixtures/stub-backend.ts (#733 is editing that file):
// the two directory server functions are answered by name, and the quote POST
// is caught and recorded. The dataset is awkward on purpose: a 46-character
// name, a long bio, forty ZIPs, a service with no price-from.
//
// Screenshots: set DIRECTORY_SCREENSHOTS=<dir> to write one PNG per page per
// width (the PR attaches them). Off by default, so CI writes nothing.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

const LONG_NAME = "Wagging Tails Professional Pet Waste Services"; // 46 characters
const ZIPS = Array.from({ length: 40 }, (_, i) => String(48201 + i));

const PROFILES = [
  {
    slug: "wagging-tails",
    display_name: LONG_NAME,
    logo_url: null,
    bio:
      "Family-owned since 2014. We scoop weekly or twice a week, lock every gate behind us and text a photo when we're done. " +
      "Fully insured, pet-first-aid certified, and we never use chemicals on your lawn.",
    service_lines: ["pet_waste", "dog_walking"],
    coverage_zips: ZIPS,
    coverage_cities: [
      "Detroit",
      "Ferndale",
      "Royal Oak",
      "Hamtramck",
      "Grosse Pointe Park",
      "Dearborn",
    ],
    services: [
      {
        label: "Weekly yard cleanup",
        service_line: "pet_waste",
        price_from_cents: 1800,
        price_unit: "visit",
      },
      {
        label: "Spring deep clean",
        service_line: "pet_waste",
        price_from_cents: null,
        price_unit: "visit",
      },
      {
        label: "30-minute neighbourhood walk",
        service_line: "dog_walking",
        price_from_cents: 2500,
        price_unit: "visit",
      },
    ],
    published_at: "2026-11-01T12:00:00Z",
  },
  {
    slug: "doo-be-gone",
    display_name: "Doo Be Gone",
    logo_url: null,
    bio: "Two trucks, Detroit and the east side.",
    service_lines: ["pet_waste"],
    coverage_zips: ["48201", "48202", "48207"],
    coverage_cities: ["Detroit"],
    services: [
      {
        label: "Weekly scoop",
        service_line: "pet_waste",
        price_from_cents: 1500,
        price_unit: "visit",
      },
    ],
    published_at: "2026-11-02T12:00:00Z",
  },
  {
    slug: "motor-city-scoop",
    display_name: "Motor City Scoop",
    logo_url: null,
    bio: null,
    service_lines: ["pet_waste"],
    coverage_zips: ["48201"],
    coverage_cities: [],
    services: [
      {
        label: "Twice-weekly scoop",
        service_line: "pet_waste",
        price_from_cents: 3200,
        price_unit: "visit",
      },
    ],
    published_at: "2026-11-03T12:00:00Z",
  },
];

type Report = { leadPosts: Array<Record<string, unknown>> };

/** The two directory server functions by name, and the lead POST. Anything
 *  else on the network is refused, so nothing here reaches a real backend. */
async function stubDirectory(context: BrowserContext): Promise<Report> {
  const report: Report = { leadPosts: [] };
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost).*/, (route) => route.abort());
  await context.route("**/api/public/leads", async (route) => {
    report.leadPosts.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, serviceArea: "unknown" }),
    });
  });
  await context.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = String(
        JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
      ).replace(/_createServerFn_handler$/, "");
    } catch {
      /* unreadable id: answered with null below */
    }
    const raw = decodeURIComponent(route.request().url());
    let result: unknown = null;
    if (name === "searchDirectory") result = { profiles: PROFILES };
    if (name === "getDirectoryProfiles") {
      result = {
        profiles: PROFILES.filter((p) => raw.includes(`"${p.slug}"`) || raw.includes(p.slug)),
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result }),
    });
  });
  return report;
}

const PAGES = [
  { key: "search", path: "/pros?line=pet_waste&zip=48201", marker: LONG_NAME },
  {
    key: "compare",
    path: "/pros/compare?slugs=wagging-tails,doo-be-gone,motor-city-scoop&line=pet_waste",
    marker: "Motor City Scoop",
  },
  { key: "profile", path: "/pros/wagging-tails", marker: "Spring deep clean" },
  { key: "quote", path: "/pros/wagging-tails/quote?line=pet_waste", marker: "Send quote request" },
] as const;

async function openAndSettle(page: Page, path: string, marker: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // Refuse to measure a page that did not render: every rule below is
  // "nothing is wrong", which a blank page satisfies.
  await expect(
    page.getByText(marker, { exact: false }).first(),
    `${path} did not draw its fixture`,
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-directory-disclosure]")).toContainText("HoundStack customer");
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(150);
}

const SHOTS = process.env.DIRECTORY_SCREENSHOTS;

test.describe.configure({ mode: "parallel" });

for (const { w, h, label } of WIDTHS) {
  test.describe(label, () => {
    for (const pg of PAGES) {
      test(`directory ${pg.key} fits, keeps its controls, clips nothing`, async ({
        page,
        context,
      }) => {
        await stubDirectory(context);
        await page.setViewportSize({ width: w, height: h });
        await openAndSettle(page, pg.path, pg.marker);

        const overflow = await measurePageOverflow(page);
        expect(overflow.scrollW, `${pg.path} at ${w}px scrolls sideways`).toBeLessThanOrEqual(
          overflow.innerW + 1,
        );
        expect(await findControlsOffTheSide(page), `${pg.path} at ${w}px`).toEqual([]);
        expect(await findSilentlyClippedText(page), `${pg.path} at ${w}px`).toEqual([]);
        if (w < 768) expect(await findControlsUnder44px(page), `${pg.path} at ${w}px`).toEqual([]);

        // Its own robots tag and a self-canonical, whatever the root says.
        const robots = await page
          .locator('meta[name="robots"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute("content")));
        expect(robots.every((c) => /noindex/.test(c ?? ""))).toBe(true);
        const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
        expect(canonical).toMatch(new RegExp(`/pros(/|$|/compare$)`));

        if (SHOTS) {
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: join(SHOTS, `${pg.key}-${w}.png`), fullPage: true });
        }
      });
    }
  });
}

test("the quote form sends one directory quote, with the honeypot and the clock", async ({
  page,
  context,
}) => {
  const report = await stubDirectory(context);
  await page.setViewportSize({ width: 360, height: 780 });
  await openAndSettle(page, "/pros/wagging-tails/quote?line=pet_waste", "Send quote request");
  await page.locator("#dq-name").fill("Rosa Delgado");
  await page.locator("#dq-email").fill("rosa@example.test");
  await page.locator("#dq-zip").fill("48201");
  // The time-to-submit check needs more than three seconds of a person.
  await page.waitForTimeout(3_200);
  await page.getByRole("button", { name: "Send quote request" }).click();
  await expect(page.locator("[data-directory-quote-sent]")).toBeVisible();
  expect(report.leadPosts).toHaveLength(1);
  expect(report.leadPosts[0]).toMatchObject({
    directory_slug: "wagging-tails",
    source: "directory",
    location: "48201",
    website_url: "",
  });
  expect(report.leadPosts[0]).not.toHaveProperty("slug");
  expect(Number(report.leadPosts[0].elapsed_ms)).toBeGreaterThanOrEqual(3_000);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "quote-sent-360.png"), fullPage: true });
});
