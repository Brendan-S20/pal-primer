/**
 * #930: the Clients texting consent notice, in both texting states, in a
 * real browser.
 *
 *   - needs_details (owner): "so they won't get texts once you set up
 *     texting", linked to Settings > Texting.
 *   - not_added (owner): the same words, linked to Plan & billing.
 *   - under_review (owner): Under review in the shared words, no link.
 *   - needs_details as a dispatcher, who cannot open Settings: a fact about
 *     the business and no link.
 *   - Texting on: the wording it always had, and no link.
 * Nothing on the page says "coming soon" in any of them.
 *
 * Each state is proved on screen by its own words before anything is
 * measured, at 360 / 390 / 768 / 1280 / 1440 / 1920 with touch on, against
 * the stub backend (a fixture business; nothing reaches a real one). With
 * SHOTS=1 a screenshot of each state at 390, 768, 1280 and 1440 lands in
 * .helm/screenshots/issue-930/.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 390, 768, 1280, 1440, 1920];
const SHOT_WIDTHS = new Set([390, 768, 1280, 1440]);
const SHOTS = join(process.cwd(), ".helm/screenshots/issue-930");
const NOTICE = /clients with a phone number have no texting consent on file/;
const FIRST_PAINT = { timeout: 45_000 };

async function measure(page: Page, label: string, width: number) {
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
  if (process.env.SHOTS && SHOT_WIDTHS.has(width)) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${label}-${width}.png`) });
  }
}

test.use({ hasTouch: true });

type Case = {
  name: string;
  state: string;
  role?: "owner" | "dispatcher";
  words: string;
  link: { label: string; href: string } | null;
};

const CASES: Case[] = [
  {
    name: "clients-texting-not-set-up",
    state: "needs_details",
    words: "so they won't get texts once you set up texting.",
    link: { label: "Set up texting", href: "/settings/sms" },
  },
  {
    name: "clients-texting-not-added",
    state: "not_added",
    words: "so they won't get texts once you set up texting.",
    link: { label: "Set up texting", href: "/settings/billing" },
  },
  {
    name: "clients-texting-under-review",
    state: "under_review",
    words:
      "so they won't get texts yet. Texting your clients is under review, usually ready shortly.",
    link: null,
  },
  {
    name: "clients-texting-not-set-up-dispatcher",
    state: "needs_details",
    role: "dispatcher",
    words: "so they won't get texts once texting is set up for your business.",
    link: null,
  },
  {
    name: "clients-texting-on",
    state: "active",
    words: "so reminders and notifications will not reach them.",
    link: null,
  },
];

for (const width of WIDTHS) {
  test.describe(`the clients consent notice at ${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 1000 }, isMobile: width < 768 });

    for (const c of CASES) {
      test(c.name, async ({ page, context }) => {
        await installSignedInSession(context);
        await installStubBackend(context, {
          role: c.role ?? "owner",
          overrides: {
            getClientTextingAvailability: { available: c.state === "active", state: c.state },
          },
        });
        await page.goto("/clients", { waitUntil: "domcontentloaded" });
        const notice = page.getByText(NOTICE);
        await expect(notice).toBeVisible(FIRST_PAINT);
        await expect(notice).toContainText(c.words);
        if (c.link) {
          const link = notice.getByRole("link", { name: c.link.label });
          await expect(link).toBeVisible();
          await expect(link).toHaveAttribute("href", c.link.href);
          if (width < 768) {
            // The tap target, not the glyph: the link's ::before hit area.
            const h = await link.evaluate((el) =>
              Number.parseFloat(getComputedStyle(el, "::before").height),
            );
            expect(h, `${c.name} @${width}: link hit area`).toBeGreaterThanOrEqual(44);
          }
        } else {
          await expect(notice.getByRole("link")).toHaveCount(0);
        }
        await expect(page.getByText(/coming soon/i)).toHaveCount(0);
        await measure(page, c.name, width);
      });
    }
  });
}
