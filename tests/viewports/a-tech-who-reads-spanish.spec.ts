/**
 * My Day in Spanish, measured on the phone and the crew tablet.
 *
 * ── WHY IT NEEDS ITS OWN SPEC ─────────────────────────────────────────────
 *
 * Every other sweep runs in English, because that is the default and the
 * browser's locale is `en-US`. Spanish is 20–30% longer. A button that fits
 * "Start" fits "Iniciar"; "More options" becoming "Más opciones" is nothing;
 * "Recordatorio SMS", "Enviar “voy en camino”", "Registro de estaciones" and
 * the sentence under a greyed Complete are where a row that fits in English
 * can go over the edge in Spanish. None of that is visible to a sweep that
 * never switches language, and the static rule in
 * tests/a-tech-screen-has-no-english-left-in-it.test.ts can say that every
 * word goes through t() but not how wide the Spanish came out.
 *
 * ── HOW SPANISH GETS IN ───────────────────────────────────────────────────
 *
 * The same way it does on a real phone: Settings → Preferences writes
 * `scoop.lang` to localStorage, and lib/i18n reads it before the first render.
 * An init script writes it before the app's first script runs.
 *
 * ── WHAT PROVES IT RENDERED, AND IN SPANISH ───────────────────────────────
 *
 * Two things, as with every signed-in surface: something only the page draws
 * (the heading, "Mi día" — which is also the proof the language took, since
 * English would say "My day") and something only the fixture holds (a
 * client's name). A green run against /auth, or against My Day in English,
 * would be worthless and would look the same.
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

/** English a Spanish-speaking tech used to read on this page, which now goes
 *  through lib/i18n. Seeing any of these means a string escaped t() at run
 *  time — through a variable, say, which the static rule cannot follow. */
const ENGLISH_THAT_WAS_THERE = [
  "More options",
  "Take photo",
  "Navigate",
  "Off the clock",
  "On the clock",
  "Safety warnings",
  "Clock in",
  "Next up",
  "Waste log",
];

async function openMyDayInSpanish(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("scoop.lang", "es");
    } catch {
      // A blocked storage would leave the page in English, which the heading
      // assertion below reports by name.
    }
  });
  await installSignedInSession(page);
  await installStubBackend(page, { role: "tech" });
  await page.goto("/my-day");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.getByRole("heading", { name: "Mi día" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText("Anastasia Vandermolen-Whitaker").first()).toBeVisible();
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);
}

async function measure(page: Page, width: number, where: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  // A touch-sizing rule, and the bar below `md` is where it is enforced —
  // see findControlsUnder44px.
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

for (const width of [360, 768]) {
  test(`My Day in Spanish fits at ${width}px`, async ({ page }) => {
    await openMyDayInSpanish(page, width);
    await measure(page, width, `/my-day (es) @${width}px`);

    const text = await page.evaluate(() => document.body.innerText);
    // The words a tech presses most, in Spanish.
    expect(text).toContain("Navegar");
    expect(text).toContain("Más opciones");
    const leftover = ENGLISH_THAT_WAS_THERE.filter((w) => text.includes(w));
    expect(leftover, `English still on the Spanish page @${width}px`).toEqual([]);
  });

  test(`the folded-away actions fit in Spanish too at ${width}px`, async ({ page }) => {
    // The longest Spanish labels live behind "Más opciones": Recordatorio SMS,
    // Enviar “voy en camino”, and the skip panel under Omitir. Open them on
    // every card that has them and measure again.
    await openMyDayInSpanish(page, width);
    const more = page.getByRole("button", { name: "Más opciones" });
    const n = await more.count();
    expect(n, "no card offered Más opciones — nothing to open").toBeGreaterThan(0);
    for (let i = 0; i < n; i += 1) await more.nth(0).click();
    const skip = page.getByRole("button", { name: "Omitir", exact: true });
    if ((await skip.count()) > 0) await skip.first().click();
    await page.waitForTimeout(250);

    await expect(page.getByText("Enviar “voy en camino”").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirmar omisión" })).toBeVisible();
    await measure(page, width, `/my-day (es, options open) @${width}px`);
  });
}
