/**
 * What the tech could not see: the dogs, the yard outline, a commercial stop's
 * stations and how the customer pays, measured on the phone, the crew tablet
 * and the iPad with a finger, in English and in Spanish.
 *
 * ── WHAT IT MEASURES ──────────────────────────────────────────────────────
 *
 * The tech's three stops from fixtures/dataset.ts MY_DAY_STOP_EXTRAS, which
 * are awkward on purpose: six named dogs (one a 39-character name, one with no
 * space in it) on a yard with a sketched outline and a cash customer owing
 * $42.50 with $15.00 already waiting; a commercial stop with nine stations
 * (a 70-character label, one with no number, one with no space at all); and
 * the stop in progress with nothing on file, owing $1,250.00. Each page is
 * measured as it opens and again with what it folds away open: every station
 * listed, and the cash/check form on the stop that owes the most, with Check
 * chosen so the check-number field is drawn.
 *
 * ── WHERE ─────────────────────────────────────────────────────────────────
 *
 * 320, 360 and 768 with a mouse, which is what the other sweeps do -- and the
 * 44px floor asserted below 768, where they assert it. Then four iPad sizes
 * with TOUCH ON, where the floor is asserted at every width: `touch:` is
 * `(pointer: coarse)`, and a sweep emulating a mouse at iPad widths measures
 * the desktop size of every control (2026-08-21: 382 passed with a mouse, 105
 * of the same failed with touch).
 *
 * ── WHAT PROVES IT RENDERED ───────────────────────────────────────────────
 *
 * The heading in the language asked for, a client's name from the fixture,
 * and then the new lines themselves by their words: a sweep that measured a
 * card without them would be green and worthless.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

type Lang = "en" | "es";

/** Words the new lines draw, per language. Every one has to be on the page. */
const EXPECT: Record<
  Lang,
  {
    heading: string;
    words: string[];
    showAll: string;
    collect: string;
    check: string;
    checkNumber: string;
  }
> = {
  en: {
    heading: "My day",
    words: [
      "6 dogs",
      "Sir Reginald Fluffington-Barksworth III",
      "2 dogs · names not on file",
      "No dogs on file",
      "Yard outline",
      "No yard outline yet",
      "9 waste stations",
      "Pays cash/check",
      "$42.50 due",
      "$15.00 collected · waiting for the office",
      "Autopay · card on file",
      "Invoiced",
      "$1,250.00 due",
    ],
    showAll: "Show all 9",
    collect: "Collected cash/check",
    check: "Check",
    checkNumber: "Check number (optional)",
  },
  es: {
    heading: "Mi día",
    words: [
      "6 perros",
      "Sir Reginald Fluffington-Barksworth III",
      "2 perros · nombres no registrados",
      "No hay perros registrados",
      "Contorno del patio",
      "Todavía no hay contorno del patio",
      "9 estaciones de desechos",
      "Paga en efectivo/cheque",
      "Debe $42.50",
      "$15.00 cobrado · pendiente de la oficina",
      "Pago automático · tarjeta registrada",
      "Se le factura",
      "Debe $1,250.00",
    ],
    showAll: "Ver las 9",
    collect: "Cobré efectivo/cheque",
    check: "Cheque",
    checkNumber: "Número de cheque (opcional)",
  },
};

/** English that must not be on the Spanish page. */
const ENGLISH = ["dogs on file", "Yard outline", "waste stations", "Collected cash/check", "due"];

async function openMyDay(page: Page, width: number, height: number, lang: Lang) {
  await page.setViewportSize({ width, height });
  if (lang === "es") {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("scoop.lang", "es");
      } catch {
        // The heading assertion below reports a page left in English.
      }
    });
  }
  await installSignedInSession(page);
  await installStubBackend(page, { role: "tech" });
  await page.goto("/my-day");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.getByRole("heading", { name: EXPECT[lang].heading, exact: true })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText("Anastasia Vandermolen-Whitaker").first()).toBeVisible();
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);
}

async function measure(page: Page, where: string, touchFloor: boolean) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (touchFloor) expect(await findControlsUnder44px(page), where).toEqual([]);
}

async function checkWordsAndOpenEverything(
  page: Page,
  lang: Lang,
  where: string,
  touchFloor: boolean,
) {
  const e = EXPECT[lang];
  // A finished stop folds its details away, and one of the three is finished
  // -- the commercial one. Open it, the way a tech checking which bins were
  // done would.
  const expand = page.getByRole("button", {
    name: lang === "es" ? "Mostrar" : "Expand",
    exact: true,
  });
  for (let n = await expand.count(); n > 0; n -= 1) await expand.first().click();
  const text = await page.evaluate(() => document.body.innerText);
  const missing = e.words.filter((w) => !text.includes(w));
  expect(missing, `${where}: the new card lines are not all on the page`).toEqual([]);
  if (lang === "es") {
    const left = ENGLISH.filter((w) => new RegExp(`\\b${w}\\b`).test(text));
    expect(left, `${where}: English on the Spanish card`).toEqual([]);
  }
  // The outline is a drawing on the card, not a map: nothing billed per card.
  expect(
    await page.locator(".leaflet-container").count(),
    `${where}: a map loaded on the card`,
  ).toBe(0);
  await measure(page, where, touchFloor);

  // Everything folded away, open: every station, and the cash/check form on
  // both stops that owe. On the one in progress the button sits beside what
  // is owed; on the one not started yet it waits under More options.
  await page.getByRole("button", { name: e.showAll }).click();
  const collect = page.getByRole("button", { name: e.collect });
  await expect(collect).toHaveCount(1);
  await collect.click();
  await page.getByRole("button", { name: e.check, exact: true }).click();
  await expect(page.getByLabel(e.checkNumber)).toBeVisible();
  await page
    .locator("ol > li")
    .first()
    .getByRole("button", { name: lang === "es" ? "Más opciones" : "More options" })
    .click();
  await page.getByRole("button", { name: e.collect }).click();
  const amounts = page.locator('input[inputmode="decimal"]');
  await expect(amounts).toHaveCount(2);
  // Each starts at what is owed less what is already waiting.
  await expect(amounts.first()).toHaveValue("42.50");
  await expect(amounts.last()).toHaveValue("1250.00");
  await page.waitForTimeout(200);
  await measure(page, `${where} (stations and form open)`, touchFloor);
}

for (const lang of ["en", "es"] as const) {
  for (const width of [320, 360, 768]) {
    test(`the stop card's dogs, yard, stations and money fit at ${width}px (${lang})`, async ({
      page,
    }) => {
      await openMyDay(page, width, 900, lang);
      await checkWordsAndOpenEverything(page, lang, `/my-day (${lang}) @${width}px`, width < 768);
    });
  }
}

test.describe("on an iPad, with a finger", () => {
  test.use({ hasTouch: true });
  for (const lang of ["en", "es"] as const) {
    for (const { w, h, label } of [
      { w: 744, h: 1133, label: "iPad mini portrait" },
      { w: 820, h: 1180, label: "iPad Air portrait" },
      { w: 1180, h: 820, label: "iPad Air landscape" },
      { w: 1024, h: 1366, label: "iPad Pro 12.9 portrait" },
    ]) {
      test(`the stop card fits and every control takes a finger: ${label} (${lang})`, async ({
        page,
      }) => {
        await openMyDay(page, w, h, lang);
        await checkWordsAndOpenEverything(page, lang, `/my-day (${lang}) ${label} touch`, true);
      });
    }
  }
});
