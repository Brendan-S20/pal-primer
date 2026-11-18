import { test, expect, type Page } from "@playwright/test";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import * as fx from "./fixtures/dataset";

/**
 * #768, the walker-only half: every owner-facing surface a dog-walking
 * business reaches in its first week, read for scooper words.
 *
 * The mixed org passed live on 2026-11-11. A walker-only org never existed in
 * production, so the leftovers were found by reading: Settings → Business
 * said "Where your trucks start the day", Settings → Users offered a route
 * end "(dump, home, shop)" with a landfill placeholder and asked about an
 * office manager who "runs a truck", the property drawer and the Properties
 * tab talked about "yard size" and "the serviced yard", and the Edit client
 * lead-source example was a "truck wrap".
 *
 * This file opens each of those surfaces, and the setup and new-client steps
 * a-business-that-does-not-scoop.spec.ts already covers one word at a time,
 * and fails on any of SCOOPER_WORDS in what the page draws: visible text, and
 * the placeholder / aria-label / title a person reads in a field. Two things
 * are deliberately not read:
 *
 *   * the fixture org's own name, "…Yard & Waste Services LLC", which the
 *     business typed;
 *   * the service-line chooser ([data-service-line-choices]), where "Pet
 *     waste removal" is an option a walker may tick.
 *
 * THE CONTROL runs the same surfaces as a pet-waste business and requires the
 * pet-waste wording to be there, so a stub whose lines stopped reaching the
 * app cannot make the walker run green by drawing nothing.
 *
 * Widths are the two SIC shoots at: a 390x844 phone and a 1440 laptop.
 * Runs with `npm run test:viewports:cases` (matched by
 * "a-business-that-does-not-scoop").
 */

const SIZES = [
  { w: 390, h: 844, label: "390 · phone" },
  { w: 1440, h: 900, label: "1440 · laptop" },
] as const;

const DOG_WALKING = ["dog_walking"];
const PET_WASTE = ["pet_waste"];

/** The words #768 is about. `\byards?\b` so a dog named "…Of-The-Backyard"
 *  in the fixture is not the app talking. */
const SCOOPER_WORDS = /\btrucks?\b|\bdump\b|dump site|landfill|\byards?\b|scoop|unload|crew|depot/i;

/** A property with the two yard flags ticked, so the Properties card has to
 *  say them in some words. */
const PROPERTY_WITH_YARD_FLAGS = {
  ...fx.PROPERTIES[0],
  dog_in_yard_during_service: true,
  do_not_enter_if_dog_out: true,
  boundary: null,
  boundary_area_sqm: null,
};

async function open(page: Page, lines: string[], path: string, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await installSignedInSession(page);
  await installStubBackend(page, {
    role: "owner",
    serviceLines: lines,
    overrides: {
      listPropertiesForClient: { properties: [PROPERTY_WITH_YARD_FLAGS, fx.PROPERTIES[1]] },
    },
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

/** What a person reads on the page right now, less what the business typed
 *  and the line chooser. */
async function readable(page: Page): Promise<string> {
  return page.evaluate((orgName) => {
    const skip = (el: Element | null) => !!el?.closest("[data-service-line-choices]");
    const parts: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || skip(el) || el.closest("script,style,noscript")) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (!el.getClientRects().length) continue;
      parts.push(n.textContent ?? "");
    }
    for (const el of Array.from(document.querySelectorAll("[placeholder],[aria-label],[title]"))) {
      if (skip(el)) continue;
      for (const a of ["placeholder", "aria-label", "title"]) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
    }
    // The fixture's addresses are at "whitfield-ramirez-yard-services
    // .example.com": the business's own domain, not the app's words.
    return parts
      .join("\n")
      .split(orgName)
      .join(" ")
      .replace(/\S*example\.com\S*/g, " ");
  }, fx.ORG_NAME);
}

async function scooperWordsOn(page: Page): Promise<string[]> {
  const text = await readable(page);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => SCOOPER_WORDS.test(l));
}

async function healthy(page: Page, w: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
    path: location.pathname,
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: the router's error boundary, not the page`).toBe(false);
  expect(health.path, `${where}: signed out`).not.toBe("/auth");
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (w < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

async function noScooperWords(page: Page, where: string) {
  expect(await scooperWordsOn(page), `${where}: scooper words a walker should not read`).toEqual(
    [],
  );
}

/** Each surface: the URL, a proof it is the page and not a fallback, and
 *  (for the control) the pet-waste wording it must still draw. */
type Surface = {
  name: string;
  path: string;
  /** Proof the surface rendered; run for both businesses. */
  ready: (page: Page) => Promise<void>;
  /** Pet-waste wording that must be on the control's page. */
  petWaste?: RegExp;
  /** The neutral wording that must be on the walker's page. */
  walker?: RegExp;
  /** The walker wording is the walker's alone: the control must not draw it. */
  walkerOnly?: boolean;
  /** More wording each business must see, on the same surface. */
  walkerAlso?: RegExp;
  petWasteAlso?: RegExp;
  /** A field placeholder each business must see (the walker's is its alone). */
  walkerPlaceholder?: string;
  petWastePlaceholder?: string;
};

const heading = (name: string | RegExp) => async (page: Page) => {
  await expect(page.getByRole("heading", { name }).first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
};

const SETUP_STEPS = ["business", "zones", "clients", "staff", "dump_site", "payouts"] as const;

const SURFACES: Surface[] = [
  ...SETUP_STEPS.map((step): Surface => ({
    name: `/setup step ${step}`,
    path: `/setup?step=${step}`,
    ready: async (page) => {
      await expect(page.locator(`[data-setup-step=${step}]`).first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    },
    ...(step === "business"
      ? { walker: /Where routes start each day/, petWaste: /Where routes start each day/ }
      : step === "dump_site"
        ? { walker: /Where does your day end\?/, walkerOnly: true, petWaste: /Dump site address/ }
        : {}),
  })),
  {
    name: "/settings/business",
    path: "/settings/business",
    ready: async (page) => {
      await expect(page.locator("#business-address")).toBeVisible({ timeout: FIRST_PAINT_MS });
    },
    walker: /Where routes start each day, unless someone has a start address of their own\./,
    petWaste: /dump sites, yard outlines/,
  },
  {
    name: "/settings/services",
    path: "/settings/services",
    ready: heading(/services/i),
  },
  {
    name: "/settings/users, a teammate's addresses open",
    path: "/settings/users",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Users & roles" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      // Open the first teammate's row: the route-end field lives there.
      const label = page.getByText(/Route end \(/).first();
      const toggles = page.locator("td button:has(svg.lucide-chevron-right)");
      await expect(async () => {
        if ((await label.count()) === 0 && (await toggles.count()) > 0) {
          await toggles.first().click();
        }
        await expect(label).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
    },
    walker: /Route end \(home or shop\)/,
    walkerOnly: true,
    petWaste: /Route end \(dump, home, shop\)/,
    // "depot" is in SCOOPER_WORDS, so the walker's Route start is checked by
    // the scan; a pet-waste business keeps its depot.
    walkerAlso: /Route start \(home or shop\)/,
    petWasteAlso: /Route start \(home, shop, or depot\)/,
    // An empty route end with no dump site ends at the last visit
    // (staff_end_point, route-inputs.ts); a scooper keeps its landfill hint.
    walkerPlaceholder: "Leave blank to end at the last visit",
    petWastePlaceholder: "Landfill or home address",
  },
  {
    // #986: the drive-time prompt said "shop/depot". "depot" is in
    // SCOOPER_WORDS, so the walker run's scan fails if it comes back.
    name: "/settings/zones, new zone drawer in drive-time mode",
    path: "/settings/zones",
    ready: async (page) => {
      const add = page.getByRole("button", { name: /New zone/ }).first();
      await expect(add).toBeVisible({ timeout: FIRST_PAINT_MS });
      await add.click();
      const mode = page.getByRole("button", { name: /Drive time/ }).first();
      await expect(mode).toBeVisible({ timeout: FIRST_PAINT_MS });
      await mode.click();
      await expect(page.getByText(/Click the map to place the/).first()).toBeVisible();
    },
    walker: /place the home or shop, then set minutes/,
    walkerOnly: true,
    petWaste: /place the shop\/depot, then set minutes/,
  },
  {
    name: "/clients/new",
    path: "/clients/new",
    ready: async (page) => {
      await expect
        .poll(() => page.evaluate(() => document.body.textContent ?? ""), {
          timeout: FIRST_PAINT_MS,
        })
        .toMatch(/Step 1 of \d/);
    },
  },
  {
    name: "client Summary",
    path: `/clients/${fx.CLIENT_ID}`,
    ready: async (page) => {
      await expect(page.getByRole("tab", { name: "Reviews & referrals" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    },
  },
  {
    name: "client Properties",
    path: `/clients/${fx.CLIENT_ID}?tab=properties`,
    ready: async (page) => {
      await expect(page.getByText("No boundary drawn yet.").first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    },
    walker: /Pet may be loose at arrival/,
    walkerOnly: true,
    petWaste: /Yard size and estimated time come from the boundary/,
  },
  {
    name: "Edit property drawer",
    path: `/clients/${fx.CLIENT_ID}?tab=properties&editProperty=${fx.PROPERTY_ID}`,
    ready: async (page) => {
      await expect(page.getByRole("dialog", { name: "Edit property" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    },
    walker: /Optional\. Outline the property/,
    walkerOnly: true,
    petWaste: /Outline the serviced yard/,
  },
  {
    name: "Edit client drawer",
    path: `/clients/${fx.CLIENT_ID}?edit=true`,
    ready: async (page) => {
      await expect(page.getByRole("dialog", { name: "Edit client" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    },
  },
  {
    name: "the client's visit drawer",
    path: `/clients/${fx.CLIENT_ID}?tab=visits`,
    ready: async (page) => {
      const tab = page.getByRole("tab", { name: "Visits", exact: true }).first();
      await expect(tab).toBeVisible({ timeout: FIRST_PAINT_MS });
      if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
      const view = page.getByRole("button", { name: /^View visit on / }).first();
      await expect(view).toBeVisible({ timeout: 30_000 });
      await view.click();
      await expect(page.getByRole("dialog").first()).toBeVisible();
    },
  },
];

for (const { w, h, label } of SIZES) {
  test.describe(`#768 a dog-walking business reads no scooper words, ${label}`, () => {
    for (const s of SURFACES) {
      test(`${s.name} @${w}px`, async ({ page }) => {
        test.setTimeout(120_000);
        await open(page, DOG_WALKING, s.path, w, h);
        await s.ready(page);
        if (s.walker) {
          await expect(page.getByText(s.walker).locator("visible=true").first()).toBeVisible();
        }
        if (s.walkerPlaceholder) {
          await expect(
            page.getByPlaceholder(s.walkerPlaceholder, { exact: true }).first(),
          ).toBeVisible();
        }
        if (s.walkerAlso) {
          await expect(page.getByText(s.walkerAlso).locator("visible=true").first()).toBeVisible();
        }
        await healthy(page, w, `${s.name} (dog walking) @${w}px`);
        await noScooperWords(page, `${s.name} (dog walking) @${w}px`);
      });
    }
  });

  // THE CONTROL: the same surfaces as a pet-waste business. Where a surface
  // names its pet-waste wording, it must still be there, and the walker's own
  // wording must not be.
  test.describe(`#768 control: a pet-waste business keeps its wording, ${label}`, () => {
    for (const s of SURFACES.filter((x) => x.petWaste)) {
      test(`${s.name} @${w}px`, async ({ page }) => {
        test.setTimeout(120_000);
        await open(page, PET_WASTE, s.path, w, h);
        await s.ready(page);
        await expect(page.getByText(s.petWaste!).locator("visible=true").first()).toBeVisible();
        if (s.walker && s.walkerOnly) {
          await expect(page.getByText(s.walker)).toHaveCount(0);
        }
        if (s.petWasteAlso) {
          await expect(
            page.getByText(s.petWasteAlso).locator("visible=true").first(),
          ).toBeVisible();
        }
        if (s.walkerAlso) await expect(page.getByText(s.walkerAlso)).toHaveCount(0);
        if (s.petWastePlaceholder) {
          await expect(
            page.getByPlaceholder(s.petWastePlaceholder, { exact: true }).first(),
          ).toBeVisible();
        }
        if (s.walkerPlaceholder) {
          await expect(page.getByPlaceholder(s.walkerPlaceholder, { exact: true })).toHaveCount(0);
        }
      });
    }
  });
}
