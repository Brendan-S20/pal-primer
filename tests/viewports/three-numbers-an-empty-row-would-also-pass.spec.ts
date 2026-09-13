/**
 * The at-a-glance row has to be MEASURED, and it has to prove it is there first.
 *
 * `every-signed-in-page-at-every-width.spec.ts` loads /my-day at four widths and
 * runs its rules over whatever is on the page, this row included. But every one
 * of those rules is of the form "nothing is wrong", and a row that rendered
 * nothing at all breaks none of them. The sweep would be green and would have
 * measured an empty div — the same failure mode `settle()` exists to stop, and
 * the same one the day-map spec was written for.
 *
 * So this asserts the three numbers are on screen, THEN measures.
 *
 * ── WHAT IT CANNOT SEE, SO NOBODY TRUSTS IT FOR THAT ──────────────────────
 *
 * Not the `min-w-0` on the text column. Removing it, and the `truncate` with
 * it, leaves all three of these tests green — MEASURED, not assumed. Tailwind's
 * `grid-cols-3` is `repeat(3, minmax(0, 1fr))`, and a 0 minimum means the track
 * cannot be widened by its contents: the label spills over the chip beside it
 * instead of pushing the page sideways. That is a real fault and it is ugly, and
 * it is not one any of these rules is about — they measure geometry, and the
 * geometry is unchanged. Whether the row is merely cramped is still a thing
 * somebody has to look at, exactly as the working agreement says.
 *
 * What it does catch is the row failing to render at all, a chip leaving the
 * side of the screen, and text clipped with no ellipsis and no scrollbar.
 *
 * ── WHAT THE FIXTURE MAKES TRUE ───────────────────────────────────────────
 *
 * The stub dataset gives every visit `escape_risk`, so "needs care" is a real
 * count and not a zero — a fixture where the alert branch never renders would
 * measure the quiet half of this component twice and the loud half never.
 *
 * It also asserts "est. finish" rather than allowing the "no ETAs" fallback.
 * That fallback is the shorter label and the easier layout, and the dataset used
 * to produce it for the wrong reason: `eta_start`/`eta_end` are `timestamptz` in
 * the database and the fixture emitted bare clock strings, which every consumer
 * in `src/` turns into Invalid Date. Pinning the real branch here keeps that from
 * quietly coming back.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  findControlsOffTheSide,
  findSilentlyClippedText,
  measurePageOverflow,
} from "./rules";

for (const { w, label } of [
  { w: 360, label: "360 · a real phone" },
  { w: 768, label: "768 · tablet portrait" },
  { w: 1280, label: "1280 · small laptop" },
]) {
  test(`the day at a glance is laid out inside ${w}px (${label})`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/my-day");
    await page.waitForLoadState("networkidle").catch(() => {});

    const row = page.getByRole("group", { name: "The rest of the day at a glance" });
    await expect(row).toBeVisible({ timeout: 20000 });

    // It rendered, and it rendered all three. A row holding one chip clears
    // every geometric rule below just as easily as a row holding none.
    // Singular or plural: the dataset leaves exactly one stop open for this
    // technician today, so the row reads "1 stop left", and a spec that pinned
    // the plural would fail on the truthful copy rather than on a layout fault.
    await expect(row.getByText(/stops? left/)).toBeVisible();
    await expect(row.getByText(/needs? care/)).toBeVisible();
    await expect(row.getByText("est. finish")).toBeVisible();

    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW, `the glance row scrolls the page sideways at ${w}px`).toBeLessThanOrEqual(
      innerW + 1,
    );

    // Unfiltered, like the day-map spec. `every-signed-in-page-at-every-width`
    // already proves the rest of /my-day is clean at these widths, so anything
    // this turns up is either the new row or a regression worth the same alarm.
    const findings = [
      ...(await findControlsOffTheSide(page)),
      ...(await findSilentlyClippedText(page)),
    ];
    expect(findings, `the glance row at ${w}px breaks the responsiveness agreement`).toEqual([]);
  });
}
