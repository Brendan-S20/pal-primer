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
 *
 * ── AND THE REST OF THE DAY ───────────────────────────────────────────────
 *
 * The tab bar's other two tabs, Desechos and Avisos, and Mi calendario, which
 * the sidebar and an empty My Day point at. Each proves itself the same two
 * ways. /waste-log had no fixture until this spec measured it, so it had only
 * ever been drawn empty; it now has a long facility, a ticket number with no
 * space in it and a manifest with no facility. Each page is measured as it
 * opens and again with what it folds away open: the log form, and the
 * notification settings panel.
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
  // The card's one button at its photo step (src/lib/visit-step.ts).
  "Take completion photo",
  "Navigate",
  "Off the clock",
  "On the clock",
  "Safety warnings",
  "Clock in",
  "Next up",
  "Waste log",
];

async function openInSpanish(
  page: Page,
  width: number,
  path: string,
  heading: string | RegExp,
  fromFixture: string,
) {
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
  await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(
    page.getByRole("heading", { name: heading, exact: typeof heading === "string" }),
  ).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText(fromFixture).first()).toBeVisible();
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);
}

const openMyDayInSpanish = (page: Page, width: number) =>
  openInSpanish(page, width, "/my-day", "Mi día", "Anastasia Vandermolen-Whitaker");

/** What each of the other pages said in English, by page. Words a fixture
 *  holds are left out: a notification's title is written by the server in
 *  English and stays so, and is not a finding. */
const ENGLISH_ELSEWHERE = {
  "/my-schedule": ["My schedule", "The next two weeks", "stops", "Today", "left"],
  "/waste-log": [
    "Waste disposal log",
    "Log a dump",
    "Recent total",
    "Facilities",
    "Directions",
    "Recent manifests",
    "No facility recorded",
    "Receipt",
    "Delete",
    "Back to My Day",
    "46 bags",
    "1284.5 lbs",
  ],
  "/notifications": [
    "Alerts",
    "Recent activity",
    "Unread",
    "Mark all read",
    "Settings",
    " ago",
    "just now",
  ],
};

async function englishLeftOn(page: Page, path: keyof typeof ENGLISH_ELSEWHERE) {
  const text = await page.evaluate(() => document.body.innerText);
  return { text, leftover: ENGLISH_ELSEWHERE[path].filter((w) => text.includes(w)) };
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

  test(`My schedule in Spanish fits at ${width}px`, async ({ page }) => {
    await openInSpanish(page, width, "/my-schedule", "Mi calendario", "Grosse Pointe Woods");
    // The list's accessible name follows the language too.
    await expect(page.locator('ul[aria-label="Tus próximos días"]')).toBeVisible();
    await measure(page, width, `/my-schedule (es) @${width}px`);

    const { text, leftover } = await englishLeftOn(page, "/my-schedule");
    // Both plural sides and the partly worked day: 12 paradas / 1 parada,
    // "faltan 7" on today's row, and today badged Hoy.
    expect(text).toMatch(/paradas/i);
    expect(text).toMatch(/\bparada\b/i);
    expect(text).toMatch(/faltan 7/i);
    expect(text).toMatch(/\bhoy\b/i);
    expect(leftover, `English still on /my-schedule @${width}px`).toEqual([]);
  });

  test(`the waste log in Spanish fits at ${width}px, with its form open`, async ({ page }) => {
    await openInSpanish(
      page,
      width,
      "/waste-log",
      // The "?" beside it is part of the heading's accessible name, and its
      // Knowledge Center article title is English-only, so match the start.
      /^Registro de desechos/,
      "TKT-2026-0930-0048812-NB-GLENVIEW",
    );
    await measure(page, width, `/waste-log (es) @${width}px`);

    const first = await englishLeftOn(page, "/waste-log");
    expect(first.text).toContain("Sin centro registrado");
    expect(first.text).toContain("46 bolsas");
    expect(first.text).toContain("1 bolsa");
    expect(first.text).toContain("Cómo llegar");
    expect(first.leftover, `English still on /waste-log @${width}px`).toEqual([]);

    await page.getByRole("button", { name: "Registrar descarga" }).click();
    await expect(page.getByText("Foto del recibo (opcional)")).toBeVisible();
    await measure(page, width, `/waste-log (es, form open) @${width}px`);
    const open = await englishLeftOn(page, "/waste-log");
    expect(open.leftover, `English in the open form @${width}px`).toEqual([]);
  });

  test(`Alerts in Spanish fit at ${width}px, with the settings open`, async ({ page }) => {
    await openInSpanish(
      page,
      width,
      "/notifications",
      "Avisos",
      "Northbrook Homeowners Association #4471",
    );
    await measure(page, width, `/notifications (es) @${width}px`);
    const first = await englishLeftOn(page, "/notifications");
    expect(first.text).toContain("Marcar todo como leído");
    expect(first.text).toMatch(/hace 3 h/);
    expect(first.leftover, `English still on /notifications @${width}px`).toEqual([]);

    await page.getByRole("button", { name: "Ajustes de avisos" }).click();
    await expect(page.getByText("Quejas de clientes")).toBeVisible();
    await measure(page, width, `/notifications (es, settings open) @${width}px`);
    const open = await englishLeftOn(page, "/notifications");
    expect(open.text).toContain("Casos que la recepcionista IA pasó al equipo");
    expect(open.leftover, `English in the settings panel @${width}px`).toEqual([]);
  });
}
