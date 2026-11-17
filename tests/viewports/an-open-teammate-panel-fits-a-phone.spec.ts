// PR #965 review: at 390 the open teammate panel in Settings > Users & roles
// (StaffAddressEditor) ran off the right of the card. Route start and end and
// the help text under "Runs routes" / "Available right now" were cut off
// behind the users table's sideways scroll. Measured on the fixture backend
// at 390x844: td and panel grid 324px wide, the grid's only track 419px.
//
// The cause was one fixture service name ("Extended neighbourhood adventure
// walk with photo report") in StaffSkills. Its row truncates, but a
// `truncate` span still has a nowrap min-content as wide as the whole name.
// Below `sm` neither the panel grid nor the skills grid declared a column,
// so each implicit `auto` track grew to that min-content and took every
// other field in the panel with it. `grid-cols-1` (minmax(0, 1fr)) on both
// keeps the track at the card's width, and the name truncates as intended.
//
// The page-level rules in rules.ts did not see this: the overflow is inside
// an `overflow-x-auto` wrapper, so the PAGE never scrolls sideways. This
// measures the panel against its own card instead.
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const TECH = "Marguerite Delacroix-Bennett";

async function openPanel(page: Page) {
  await installSignedInSession(page.context());
  // A walking line as well, so the dog cap field is in the panel too.
  await installStubBackend(page.context(), { serviceLines: ["pet_waste", "dog_walking"] });
  await page.goto("/settings/users", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Users & roles" }).first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  const row = page.locator("tr").filter({ hasText: TECH }).first();
  await row.getByRole("button", { name: "Routing & addresses" }).click();
  // Proof the panel is drawn, with each piece the review named.
  await expect(page.getByPlaceholder("Leave blank for business address")).toBeVisible();
  await expect(page.getByText("Runs routes", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Available right now", { exact: true })).toBeVisible();
  await expect(page.getByText("Services this person can do")).toBeVisible();
  await expect(page.getByText(/^Extended neighbourhood adventure walk/)).toBeAttached();
}

for (const [w, h] of [
  [360, 780],
  [390, 844],
  [430, 932],
] as const) {
  test.describe(`${w}x${h}`, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });

    test("every control and line of help text in the open panel fits inside the card", async ({
      page,
    }) => {
      await openPanel(page);
      const m = await page.evaluate(() => {
        const td = document.querySelector('td[colspan="6"]') as HTMLElement;
        const scroller = td.closest(".overflow-x-auto") as HTMLElement;
        const card = td.closest(".rounded-xl") as HTMLElement;
        const right = td.getBoundingClientRect().right;
        const over = [...td.querySelectorAll("input, button, label, p, span, select")]
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.right > right + 1)
          .map(
            ({ el, r }) =>
              `${el.tagName.toLowerCase()} "${(el.textContent || (el as HTMLInputElement).placeholder || "").trim().slice(0, 40)}" ends at ${Math.round(r.right)} > ${Math.round(right)}`,
          );
        return {
          scrollW: scroller.scrollWidth,
          clientW: scroller.clientWidth,
          tdRight: right,
          cardRight: card.getBoundingClientRect().right,
          over,
        };
      });
      expect(m.over, "panel contents past the right of the panel").toEqual([]);
      expect(m.scrollW, "the users table scrolls sideways").toBeLessThanOrEqual(m.clientW + 1);
      expect(m.tdRight, "the panel runs past the card").toBeLessThanOrEqual(m.cardRight + 1);
      expect(m.cardRight).toBeLessThanOrEqual(w);

      // The Route start hint is read whole, not cut at the box's edge: its
      // text, in the input's own font, fits the input's content box.
      const hint = await page
        .getByPlaceholder("Leave blank for business address")
        .evaluate((el: HTMLInputElement) => {
          const cs = getComputedStyle(el);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
          const box = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
          return { text: ctx.measureText(el.placeholder).width, box };
        });
      expect(hint.text, "the Route start hint is cut off").toBeLessThanOrEqual(hint.box);
    });
  });
}
