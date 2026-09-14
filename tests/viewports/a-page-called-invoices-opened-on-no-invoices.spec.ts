// A page called Invoices that opened on no invoices.
//
// Measured on a 430pt phone against the deployed app, signed in as the owner:
// three full-width stat cards stacked, then a filter panel carrying a search
// field, six status buttons and two date inputs. The first invoice was off the
// bottom of the screen entirely.
//
//     /zones      first content row at y=277
//     /dashboard  y=637
//     /clients    y=646
//     /invoices   below the fold
//
// Desktop was fine — the cards sit four across and the filters are one row. It
// is only the phone, where a grid of one stacks everything the page knows
// before anything the page is for.
//
// The stat cards are CONTROLS, not decoration: each toggles its status filter.
// So they are compacted rather than hidden, and the filters fold behind a
// trigger that carries a count — a filtered list with its filters out of sight
// is how somebody concludes their invoices have disappeared.
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const PHONE = { width: 430, height: 932 };

test.describe("invoices open on invoices", () => {
  test.use({ viewport: PHONE, isMobile: true, deviceScaleFactor: 2 });

  test("the first invoice is on the first screen", async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto("/invoices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Invoices" }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.waitForTimeout(800);

    // Measured on what is VISIBLE, not on the <table>. Below `md` the table is
    // hidden and the list reflows to cards, so a table row reports a zero rect
    // and a naive measurement reads it as "at the very top" — which would have
    // passed this test while the page was still broken.
    const y = await page.evaluate(() => {
      const name = "Anastasia Vandermolen-Whitaker";
      const els = [...document.querySelectorAll("body *")].filter(
        (e) => e.textContent?.includes(name) && e.children.length === 0,
      );
      const visible = els.find((e) => {
        const r = e.getBoundingClientRect();
        return r.height > 0 && r.width > 0;
      });
      return visible
        ? Math.round(visible.getBoundingClientRect().top + window.scrollY)
        : null;
    });
    expect(y, "no visible invoice row rendered at all").not.toBeNull();
    expect(y!, `the first invoice starts at y=${y}, below a ${PHONE.height}px screen`).toBeLessThan(
      PHONE.height,
    );
  });

  test("the stat cards sit in a row, not a column", async ({ page }) => {
    // Added after a mutation exposed a hole: reverting the cards to stacked
    // still passed the above-the-fold test, because folding the filters alone
    // is enough to lift the first invoice onto the screen. So the compaction
    // was real and completely unprotected.
    //
    // Measured by GEOMETRY rather than class names: three cards on one row
    // share a top edge, three stacked do not.
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto("/invoices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Outstanding/ }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });

    const tops = await page.evaluate(() => {
      const labels = ["Outstanding", "Open invoices", "Collected this month"];
      return labels
        .map((l) => {
          const el = [...document.querySelectorAll("button")].find((b) =>
            b.textContent?.includes(l),
          );
          return el ? Math.round(el.getBoundingClientRect().top) : null;
        })
        .filter((n): n is number => n !== null);
    });
    expect(tops.length, "could not find the three stat cards").toBe(3);
    const spread = Math.max(...tops) - Math.min(...tops);
    expect(spread, `the stat cards are stacked (tops span ${spread}px), not in a row`).toBeLessThan(
      12,
    );
  });

  test("the filters are folded, and say how many are on", async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto("/invoices", { waitUntil: "domcontentloaded" });
    const trigger = page.getByRole("button", { name: /^Filters/ });
    await expect(trigger).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Opening one has to reveal them, or the controls are simply gone.
    await trigger.click();
    await expect(page.getByLabel("Search client")).toBeVisible();

    // And the count has to appear, because a filtered-empty list with hidden
    // filters reads as missing data.
    await page.getByLabel("Search client").fill("Whitaker");
    await trigger.click();
    await expect(trigger).toContainText("1");
  });

  test("the stat cards still filter, compact or not", async ({ page }) => {
    // Compacting them must not turn a control into an ornament.
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.goto("/invoices", { waitUntil: "domcontentloaded" });
    const card = page.getByRole("button", { name: /Outstanding/ }).first();
    await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
    await card.click();
    await expect(card).toHaveAttribute("aria-pressed", "true");
  });

  test("a laptop is left alone", async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/invoices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Invoices" }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    // Filters are open with no trigger in sight; the fold is a phone answer to
    // a phone problem.
    await expect(page.getByLabel("Search client")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Filters/ })).toBeHidden();
  });
});
