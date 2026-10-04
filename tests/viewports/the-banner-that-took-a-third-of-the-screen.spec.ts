/**
 * The trial notice is shown on every authenticated page. Since 2026-10-03 it
 * can be put away, but never permanently: a dismissal lasts only until the
 * trial gets materially closer to its end, or a week (`TrialBanner`'s header
 * and src/lib/dismissible.ts). Every case here starts on a fresh browser
 * context, so nothing has been dismissed and the notice is on screen.
 *
 * What it measures is the size. On the `expired` phase the banner was 233px at
 * 360, 217 at 390 and 197 at 430, against 125 at 1280. Twenty of those pixels
 * are the headline and twenty are the action; the rest is two paragraphs of
 * reassurance wrapping to eight lines on a phone. 29% of a 360px screen, above
 * every page — including My Day, where it pushed the technician's route map
 * down by more than the map had to spare.
 *
 * Below `sm` those paragraphs now sit behind "What this means". The headline,
 * the tone and the action do not move.
 *
 * ── WHY BOTH HALVES ARE ASSERTED ──────────────────────────────────────────
 *
 * A test that only checked the height would pass if the whole banner had been
 * deleted, which is exactly the change this component forbids (putting it away
 * is the reader's choice, never the page's). So the headline
 * and the action are asserted present at EVERY width, and the explanation is
 * asserted to come back when the control is pressed. Folded is not hidden, and
 * the difference is the point.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

/** The banner, found by its own copy rather than a test id, because the copy is
 *  the thing that must survive. */
const read = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => (d.textContent || "").startsWith("Your free trial has ended") && d.className.includes("border-b"),
    );
    if (!el) return null;
    const text = el.textContent || "";
    return {
      height: Math.round(el.getBoundingClientRect().height),
      headline: text.includes("Your free trial has ended"),
      action: /Set up billing|Ask an owner to set up billing/.test(text),
      // The INNERMOST div holding the explanation, not any div that contains
      // it: textContent includes hidden descendants, so once the dismiss
      // button (2026-10-03) put a visible wrapper around the banner's text,
      // "some visible div contains the words" was true on a folded phone too.
      explanationVisible: [...el.querySelectorAll("div")]
        .filter(
          (d) =>
            (d.textContent || "").includes("Nothing has been deleted") &&
            ![...d.querySelectorAll("div")].some((c) =>
              (c.textContent || "").includes("Nothing has been deleted"),
            ),
        )
        .some((d) => (d as HTMLElement).offsetParent !== null),
    };
  });

for (const { w, h, label, phone } of [
  { w: 360, h: 800, label: "360x800 · a small phone", phone: true },
  { w: 390, h: 844, label: "390x844 · iPhone 14", phone: true },
  { w: 1280, h: 900, label: "1280x900 · a laptop", phone: false },
]) {
  test(`the trial notice is legible without taking the screen (${label})`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/my-day");
    await page.waitForLoadState("networkidle").catch(() => {});

    await expect(page.getByText("Your free trial has ended")).toBeVisible({ timeout: FIRST_PAINT_MS });
    const closed = await read(page);
    expect(closed, "the banner was not found by its own copy").not.toBeNull();

    // Never folded away, at any width. This is the half that must not regress.
    expect(closed!.headline, "the headline is gone").toBe(true);
    expect(closed!.action, "the call to action is gone").toBe(true);

    const toggle = page.getByRole("button", { name: "What this means" });

    if (phone) {
      expect(
        closed!.height,
        `the trial notice is ${closed!.height}px at ${label}, which is a third of the screen`,
      ).toBeLessThanOrEqual(110);
      expect(closed!.explanationVisible, "the explanation is still unfolded on a phone").toBe(false);

      // Folded, not deleted.
      await expect(toggle).toBeVisible();
      await toggle.click();
      const opened = await read(page);
      expect(opened!.explanationVisible, "pressing the control did not bring the explanation back").toBe(true);
      expect(opened!.headline).toBe(true);
      expect(opened!.action).toBe(true);
    } else {
      // A laptop has the room, so nothing is folded and there is no control to
      // press. The change is deliberately invisible above `sm`.
      expect(closed!.explanationVisible, "the explanation was folded on a laptop too").toBe(true);
      await expect(toggle).toHaveCount(0);
    }
  });
}
