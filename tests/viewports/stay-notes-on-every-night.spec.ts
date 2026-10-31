// The notes the office typed when booking a stay are on the sitter's card
// every night, at a phone's width, with nothing to open (#618).
//
// Locked acceptance: a note typed at booking appears on nights 1 to N at 390
// wide without expanding, and every assigned sitter (the handoff too) sees the
// same notes. Who may READ the row is the database's question and is pinned in
// tests/stay-notes-reach-the-sitter.test.tsx; this measures what the card does
// with it.
//
// Each night is its own load, because on My Day each night is its own day.
// The last case is a finished visit, whose card starts collapsed: the notes
// are above the fold line, so they are still there.

import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { SIT_STAY_NOTES, installStubBackend } from "./fixtures/stub-backend";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

const STAY_ID = "aaaaaaaa-0000-4000-8000-00000000e001";
const NIGHTS = 4;

async function openNight(page: Page, sitVisit: (v: Record<string, any>) => Record<string, any>) {
  await installSignedInSession(page.context());
  await installStubBackend(page, { role: "tech", serviceLines: ["pet_sitting"], sitVisit });
  await page.goto("/my-day", { waitUntil: "domcontentloaded" });
  const notes = page.locator(`[data-stay-notes="${STAY_ID}"]`);
  await expect(notes).toBeVisible({ timeout: 45_000 });
  return notes;
}

/** The whole note is drawn: every line of it, inside the screen, unclipped. */
async function expectWholeNote(page: Page, notes: ReturnType<Page["locator"]>, label: string) {
  await expect(notes).toContainText("Stay notes");
  for (const line of SIT_STAY_NOTES.split("\n")) await expect(notes).toContainText(line);
  const box = await notes.evaluate((el) => {
    const p = el.querySelector("p")!;
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      clipped: p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1,
    };
  });
  expect(box.left, `${label}: notes start off the screen`).toBeGreaterThanOrEqual(0);
  const vw = page.viewportSize()!.width;
  expect(box.right, `${label}: notes run off the screen`).toBeLessThanOrEqual(vw + 1);
  expect(box.clipped, `${label}: notes are cut short`).toBe(false);

  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label}: clipped`).toEqual([]);
  if (page.viewportSize()!.width < 768) {
    expect(await findControlsUnder44px(page), `${label}: under 44px`).toEqual([]);
  }
}

test.describe("stay notes on the sitter's card at 390", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (let n = 1; n <= NIGHTS; n++) {
    test(`night ${n} of ${NIGHTS}`, async ({ page }) => {
      const notes = await openNight(page, (v) => ({
        ...v,
        status: "scheduled",
        started_at: null,
        sit_facts: { ...v.sit_facts, kind: "overnight", visit_number: n, visit_total: NIGHTS },
      }));
      await expect(page.getByText(`Night ${n} of ${NIGHTS}`)).toBeVisible();
      // At the top of the stay: above the pets and their care. Both read in
      // one frame, because My Day scrolls to the current stop as it loads.
      const above = await page.evaluate((id) => {
        const notesEl = document.querySelector(`[data-stay-notes="${id}"]`);
        const card = notesEl?.closest("li[id^='visit-']");
        // The first pet's own entry in the care list.
        const pets = [...(card?.querySelectorAll("li li") ?? [])].find((li) =>
          li.textContent?.startsWith("Bartholomew"),
        );
        if (!notesEl || !pets) return null;
        return notesEl.getBoundingClientRect().bottom <= pets.getBoundingClientRect().top;
      }, STAY_ID);
      expect(above, "the notes sit above the pets' care").toBe(true);
      await expectWholeNote(page, notes, `night ${n}`);
    });
  }

  test("a finished night, whose card starts folded, still shows the notes", async ({ page }) => {
    const notes = await openNight(page, (v) => ({
      ...v,
      status: "completed",
      completed_at: new Date().toISOString(),
      sit_facts: {
        ...v.sit_facts,
        kind: "overnight",
        visit_number: NIGHTS,
        visit_total: NIGHTS,
      },
    }));
    // Folded: the pets' care is behind the expand button.
    await expect(page.getByText("Bartholomew", { exact: true })).toHaveCount(0);
    await expectWholeNote(page, notes, "finished night");
  });
});

// The rest of the house widths, one night each: a tablet and two desktops
// read the same card.
for (const width of [360, 768, 1280, 1920]) {
  test.describe(`stay notes at ${width}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width < 1280 });
    test("night 2 of 4", async ({ page }) => {
      const notes = await openNight(page, (v) => ({
        ...v,
        status: "scheduled",
        started_at: null,
        sit_facts: { ...v.sit_facts, kind: "overnight", visit_number: 2, visit_total: NIGHTS },
      }));
      await expectWholeNote(page, notes, `${width}`);
    });
  });
}
