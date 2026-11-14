/**
 * My Day's header, rebuilt to the layout Brendan supplied as a screenshot.
 *
 * Two rows below `md`, and the order inside the second one is the point:
 *
 *   My day                                   [📅 Mon, Apr 14 ⌄]
 *   [ 3 of 10 done ▓▓▓░░░░ 30% ]        [ ☰ List | 🗺 Map ]
 *
 * ── WHAT CHANGED, AND WHY IT IS MEASURED RATHER THAN EYEBALLED ────────────
 *
 * A seven-day strip used to sit between those rows: 48px of screen spent on
 * a control pressed a few times a week, on the one screen whose entire
 * reported problem is vertical room ("map doesn't fit flush; I have to scroll
 * up and down to see the whole map"). It is now a chip in the title row —
 * a native date input laid transparently over a styled face, so the phone
 * opens the picker it already has.
 *
 * Measured before and after at 320-430: the header's bottom edge moved from
 * 303px to 243px. That 60px goes straight to the map, which sizes itself off
 * exactly this distance.
 *
 * The progress and the toggle also swapped sides. The toggle used to lead the
 * row, which put the control first and the fact second; the number is what
 * gets read at a glance between driveways.
 *
 * ── WHY EACH ASSERTION IS HERE ────────────────────────────────────────────
 *
 * Every claim below is one a plausible future edit breaks silently. The
 * ORDER is asserted because "progress left of toggle" is invisible to a
 * parser and reads as arbitrary to anyone who did not see the screenshot.
 * The LABELS are asserted because icon-only was the previous design and a
 * list glyph and a folded-map glyph are not far apart at 16px. And the focus
 * handler is asserted because the tab bar fires an event at a control that
 * no longer exists in its old shape — the kind of wiring that breaks with
 * nothing on screen to show for it.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const FOCUS_EVENT = "houndstack:focus-my-day-schedule";

const readHeader = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const box = (el: Element | null | undefined) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        left: Math.round(b.left),
        right: Math.round(b.right),
        height: Math.round(b.height),
        width: Math.round(b.width),
      };
    };
    const chip = document.querySelector('input[aria-label="Pick a day"]');
    const group = document.querySelector('[role="group"][aria-label="View"]');
    const buttons = group
      ? [...group.querySelectorAll("button")].map((b) => ({
          text: (b.textContent || "").trim(),
          ...box(b)!,
        }))
      : [];
    // The pill is the progress block: the element holding the "N of M done"
    // text. Found by its copy rather than a test id, same as everything else
    // in these specs -- but INNERMOST, which matters more than it looks.
    //
    // querySelectorAll returns document order, so `.find()` returns an
    // ANCESTOR of the pill whenever one also matches, and its right edge is
    // the right edge of the whole row. That is not hypothetical: with the
    // toggle's text labels removed, the row's own text ends in "%" too, the
    // row matched first, and the labels mutation failed the ORDERING
    // assertion instead of the labels one -- a caught mutation reported
    // under the wrong name, which is how a rule stops meaning what it says.
    const matches = [...document.querySelectorAll("div")].filter(
      (d) => /\bof\b/.test(d.textContent || "") && /%$/.test((d.textContent || "").trim()),
    );
    const pill = matches.find((d) => !matches.some((o) => o !== d && d.contains(o)));
    const h1 = document.querySelector("h1") as HTMLElement | null;
    return {
      pageScrollWidth: document.documentElement.scrollWidth,
      // Is the heading actually READABLE, or merely present? `truncate` means
      // a squeezed h1 still has a box and still passes toBeVisible -- at 360
      // the first draft of this header rendered it 10px wide, showing an
      // ellipsis and nothing else, and every assertion in this file passed.
      // scrollWidth > clientWidth is the only thing that tells them apart.
      h1Clipped: h1 ? h1.scrollWidth > h1.clientWidth + 1 : null,
      h1Width: h1 ? Math.round(h1.getBoundingClientRect().width) : null,
      chip: box(chip),
      // innerText, NOT textContent: the weekday is hidden with `display:none`
      // below 360px and textContent would still report it, so the width-
      // dependent assertion below would pass at every width and prove
      // nothing.
      chipLabel: ((chip?.previousElementSibling as HTMLElement | null)?.innerText || "").trim(),
      // The seven-day strip this replaced. Its absence is a claim worth
      // pinning: bringing it back would restore the 48px silently.
      stripPresent: !!document.querySelector(
        '[aria-label="Pick a day"][class*="overflow-x-auto"]',
      ),
      buttons,
      pill: box(pill),
      // The desktop field is named "Pick a day" too (axe: an input with no
      // name), so it is told from the chip by the chip's invisible overlay.
      nativeDateVisible: !!(
        document.querySelector('input[type="date"]:not(.opacity-0)') as HTMLElement
      )?.offsetParent,
    };
  });

for (const w of [320, 360, 390]) {
  test(`the header reads progress-then-view and fits (${w}px)`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto("/my-day");
    await page.waitForLoadState("networkidle").catch(() => {});

    // Proves the page RENDERED before anything measures it. Every assertion
    // below is of the form "nothing is wrong", and those all pass on a blank
    // page.
    await expect(page.getByRole("heading", { name: "My day" })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByRole("group", { name: "View" })).toBeVisible();

    const h = await readHeader(page);

    expect(h.pageScrollWidth, `the page scrolls sideways at ${w}px`).toBeLessThanOrEqual(w);

    // The regression this file was written after: the day chip and the push
    // control between them took the whole row and the page heading was left
    // 0px wide at 320 and 10px at 360. toBeVisible() catches the first and
    // not the second, which is why this assertion is here and phrased about
    // clipping rather than about presence.
    expect(
      h.h1Clipped,
      `"My day" is clipped at ${w}px (${h.h1Width}px of room) — the controls beside ` +
        "it have taken the row",
    ).toBe(false);

    // ── The day chip replaced the strip ─────────────────────────────────
    expect(h.stripPresent, "the seven-day strip is back — it costs 48px of map").toBe(false);
    expect(h.chip, "the date chip is gone; there is no way to change the day").not.toBeNull();
    // The month and the day are never negotiable.
    expect(
      h.chipLabel,
      `the chip should name a month and a day, got ${JSON.stringify(h.chipLabel)}`,
    ).toMatch(/\p{L}{3,}\.?\s+\d{1,2}$/u);
    // The weekday is, but only below 360. Asserted in BOTH directions so the
    // narrow form cannot quietly become the form every phone gets: the
    // screenshot this was built from shows "Mon, Apr 14" on a phone.
    if (w >= 360) {
      expect(
        h.chipLabel,
        `at ${w}px the chip should keep its weekday, got ${JSON.stringify(h.chipLabel)}`,
      ).toMatch(/^\p{L}{2,}\.?,\s/u);
    } else {
      expect(
        h.chipLabel,
        `at ${w}px the weekday should be dropped so the heading fits, got ${JSON.stringify(h.chipLabel)}`,
      ).not.toMatch(/^\p{L}{2,}\.?,\s/u);
    }
    expect(h.chip!.height, "the date chip is under the 44px floor").toBeGreaterThanOrEqual(44);
    expect(h.chip!.right, "the date chip runs off the right edge").toBeLessThanOrEqual(w);

    // ── Progress on the left, view on the right ─────────────────────────
    expect(h.pill, "the progress pill did not render").not.toBeNull();
    expect(h.buttons.length, "the view toggle should have two buttons").toBe(2);
    const toggleLeft = Math.min(...h.buttons.map((b) => b.left));
    expect(
      h.pill!.right,
      "the progress pill must sit LEFT of the view toggle — the number is what gets " +
        "read at a glance, the toggle is pressed a few times a day",
    ).toBeLessThanOrEqual(toggleLeft);

    // ── The toggle says which is which ──────────────────────────────────
    expect(
      h.buttons.map((b) => b.text),
      "the view toggle lost its text labels — a list glyph and a folded map are " +
        "not far apart at 16px",
    ).toEqual(["List", "Map"]);

    for (const b of h.buttons) {
      expect(b.height, `"${b.text}" is ${b.height}px tall, under the 44px floor`).toBeGreaterThanOrEqual(44);
      expect(b.right, `"${b.text}" runs ${b.right - w}px off the right edge`).toBeLessThanOrEqual(w);
    }
  });
}

test("pressing Today while on My Day still reaches a day control", async ({ page, context }) => {
  // MobileTabBar fires this at the header. It used to focus a button in the
  // seven-day strip; the strip is gone, so the handler now has to find the
  // chip instead. Nothing on screen would show this being broken.
  await installSignedInSession(context);
  await installStubBackend(context);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/my-day");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.getByRole("heading", { name: "My day" })).toBeVisible({ timeout: FIRST_PAINT_MS });

  const focused = await page.evaluate((evt) => {
    window.dispatchEvent(new Event(evt));
    const el = document.activeElement as HTMLElement | null;
    return { tag: el?.tagName ?? null, label: el?.getAttribute("aria-label") ?? null };
  }, FOCUS_EVENT);

  expect(focused.tag, "the focus handler reached nothing").toBe("INPUT");
  expect(focused.label).toBe("Pick a day");
});

test("a laptop keeps the native date field and drops the chip", async ({ page, context }) => {
  // The chip is a phone affordance; `md` and up already had a date input and
  // the room for it. Asserted so the chip does not quietly become the only
  // control and shrink the desktop header into a phone one.
  await installSignedInSession(context);
  await installStubBackend(context);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/my-day");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.getByRole("heading", { name: "My day" })).toBeVisible({ timeout: FIRST_PAINT_MS });

  const h = await readHeader(page);
  expect(h.nativeDateVisible, "the desktop date field is gone").toBe(true);
  expect(h.chip?.width ?? 0, "the phone chip is showing on a laptop").toBe(0);
});
