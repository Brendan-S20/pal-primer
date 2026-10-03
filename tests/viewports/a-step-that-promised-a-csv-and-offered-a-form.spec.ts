/**
 * The setup checklist on /dashboard, measured at real widths for the first
 * time.
 *
 * ── WHY "FOR THE FIRST TIME" ──────────────────────────────────────────────
 *
 * `getOnboardingStatus` WAS stubbed before 2026-09-14 — as
 * `{ steps: [], completed: 0, total: 0, dismissed: true }`, which answers the
 * call and draws nothing, because the component returns null on `dismissed`
 * before it renders a row. So /dashboard swept green at four widths with the
 * checklist absent from the page, and green because nothing was there.
 *
 * That is worth stating precisely, because the obvious diagnosis is the wrong
 * one: the key was present and the unstubbed report was clean. The fault was
 * the VALUE. This file is the guard against it returning — the assertions
 * below fail if the checklist stops rendering, rather than passing because
 * it does.
 *
 * ── WHAT IS BEING MEASURED ────────────────────────────────────────────────
 *
 * The "Add or import clients" step is the only row that carries TWO controls,
 * and it is therefore the widest row this component can produce. The step's
 * description has always promised "or upload a CSV to seed many at once"; its
 * only button went to /clients/new, the one-at-a-time form. /imports was
 * already built and already in the sidebar — what was missing was a door on
 * the one screen that names it.
 *
 * Both buttons are asserted present, both are asserted hittable, and the row
 * is asserted to stay inside the viewport. Asserting only that the second
 * button exists would pass on a layout where it had been pushed off the right
 * edge of a phone, which is the likeliest way this change goes wrong.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

/** The clients row of the checklist, found by its own copy. */
const readRow = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const li = [...document.querySelectorAll("li")].find((l) =>
      (l.textContent || "").includes("Add or import clients"),
    );
    if (!li) return null;
    const btn = (label: string) =>
      [...li.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === label);
    const box = (el: Element | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { right: Math.round(r.right), height: Math.round(r.height), width: Math.round(r.width) };
    };
    return {
      rowRight: Math.round(li.getBoundingClientRect().right),
      add: box(btn("Add client")),
      importCsv: box(btn("Import CSV")),
    };
  });

for (const { w, h, label, phone } of [
  { w: 360, h: 800, label: "360x800 · a small phone", phone: true },
  // phone:false deliberately. `touch:` is (pointer: coarse), (max-width:
  // 767px), and this spec runs without hasTouch — so at 768 a desktop
  // Chromium matches NEITHER clause and every touch-sized control in the app
  // measures at its desktop size. Asserting 44px here would not be a stricter
  // test, it would be a test of the wrong thing: it fails on markup that is
  // correct on the iPad it is named after. The canonical sweep draws the same
  // line (TOUCH_WIDTH = 360) and the Apple pass is where coarse pointers are
  // measured. Width and fit ARE still asserted here.
  { w: 768, h: 1024, label: "768x1024 · a tablet", phone: false },
  { w: 1280, h: 900, label: "1280x900 · a laptop", phone: false },
]) {
  test(`the clients step offers both ways in, and both fit (${label})`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle").catch(() => {});

    // Proves the component RENDERED, before anything measures it. Every
    // assertion below is of the form "nothing is off the edge", and all of
    // those pass on a page where the checklist is absent.
    //
    // CHANGED 2026-10-02: on a phone the checklist now draws only the NEXT
    // step until "Show all 7 steps" is pressed (launch pass recommendation 8),
    // and in this fixture the next step is not the clients one. So the list
    // is opened first; what this measures, the row at full width, is unchanged.
    await expect(page.getByText("Get started").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
    const showAll = page.getByRole("button", { name: /Show all \d+ steps/ });
    if (phone) await showAll.click();
    await expect(page.getByText("Add or import clients")).toBeVisible({ timeout: FIRST_PAINT_MS });

    const row = await readRow(page);
    expect(row, "the clients step did not render").not.toBeNull();

    expect(row!.add, 'the "Add client" button is gone').not.toBeNull();
    expect(
      row!.importCsv,
      'the "Import CSV" button is gone — the step describes a CSV upload and must offer one',
    ).not.toBeNull();

    // Inside the row, and the row is inside the page.
    expect(
      row!.importCsv!.right,
      `"Import CSV" runs ${row!.importCsv!.right - w}px past the right edge at ${w}px`,
    ).toBeLessThanOrEqual(w);
    expect(row!.add!.right).toBeLessThanOrEqual(w);

    if (phone) {
      // Both controls are thumb targets, not just the first one.
      //
      // This passes today WITHOUT any class on the buttons: `sm` in
      // ui/button.tsx already carries `touch:min-h-11 touch:min-w-11`, and
      // the measured height at 360-640 is 44px either way. An earlier draft
      // of this change added an ad-hoc `touch:min-h-11` here and only found
      // out it was dead weight by deleting it and watching nothing fail --
      // which is also what button.tsx:25 says, having been refactored
      // precisely to get rid of those ad-hoc copies.
      //
      // So this assertion guards the VARIANT still reaching these two
      // buttons: a swap to a raw <a>, or to a size that has no touch rule,
      // is what it catches. It is not evidence that this change fixed a
      // touch-target fault, because there was not one to fix.
      for (const [name, b] of [
        ["Add client", row!.add!],
        ["Import CSV", row!.importCsv!],
      ] as const) {
        expect(b.height, `"${name}" is ${b.height}px tall at ${w}px, under the 44px minimum`).toBeGreaterThanOrEqual(44);
      }
    }
  });
}
