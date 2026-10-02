/**
 * Eight customer-facing routes, none of them ever measured.
 *
 * ── THE GAP ───────────────────────────────────────────────────────────────
 *
 * `every-public-page-at-every-width.spec.ts` covers six routes: /auth,
 * /get-started, /no-workspace and the three legal pages. The signed-in sweep
 * covers the staff app. Between them they cover nobody's customer.
 *
 * The portal is where a customer sees their next visit, pays an invoice,
 * reports that a corner was missed, and manages the dogs and the gate. It is
 * reached from a text message, which means it is opened on a phone
 * essentially always — the one place in this product where "responsive" is
 * not a nice-to-have but the only mode.
 *
 * ── WHY IT HAD NO COVERAGE, WHICH IS NOT AN OVERSIGHT ─────────────────────
 *
 * Every portal query in `portal-ui.tsx` is `enabled: verified`, and `verified`
 * comes from `portalContext`. With no fixture, `portalContext` answers null,
 * the layout renders "This link has expired", and all eleven data queries stay
 * switched off. So a sweep pointed at these eight URLs without a fixture is
 * not a thin sweep — it is eight measurements of the same dead-end card, and
 * it would have been green. Same failure the signed-in sweep's header
 * describes, wearing an expired link instead of a login form.
 *
 * Hence `portal-dataset.ts`, and hence the proof below: a fixture string that
 * only appears once the gate is open.
 *
 * ── THREE SHAPES THE FIXTURE GOT WRONG FIRST ──────────────────────────────
 *
 * Worth recording, because each one produced a page that looked plausible:
 *
 *   - `portalSignPhotoUrls` returns `{ urls: Record<path, url> }`, not a list.
 *     A list crashed Visits into its error boundary — and an error boundary
 *     has a layout, so the rules below would have measured it and passed.
 *   - `portalListInvoices` returns `{ invoices, openCount, ... }`, not rows:
 *     the handler merges due dates and computes a summary the RPC never had.
 *     A bare array rendered "No invoices yet" over three invoices.
 *   - `portalGetReferral` is unwrapped by the handler to a single object. An
 *     array rendered "No referral code yet" over a referral code.
 *   - Branding is camelCased by `orgBrandingBySlug` before it is returned, so
 *     snake_case keys silently produced a generic "Client portal" heading and
 *     a grey letter avatar on every page. That one passed every rule here.
 *
 * All four read as findings about the app. None of them were. Which is the
 * argument for a proof string per page rather than a size threshold: three of
 * the four rendered a complete, well-laid-out page of the wrong thing.
 */
import { test, expect } from "@playwright/test";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  PORTAL_ORG_NAME,
  PORTAL_SLUG,
  PORTAL_TOKEN,
  SIGNUP_LONG_TIER_LABEL,
  PORTAL_CLIENT_NAME,
  PORTAL_PAY_INVOICE_ID,
  PUBLIC_INVOICE,
  QUOTE_LONG_LINE,
  QUOTE_ORG_NAME,
  QUOTE_SIGNER,
  QUOTE_TOKENS,
  TRACKING_ORG_NAME,
  TRACKING_TECH_NAME,
  TRACKING_TOKENS,
} from "./fixtures/portal-dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

const BASE = `/portal/${PORTAL_SLUG}/${PORTAL_TOKEN}`;

const PAGES = [
  { path: "", label: "home", proof: /Next visit/i },
  // `also` because a page can prove itself and still not draw the row being
  // measured: the re-clean offer only exists on a completed visit inside the
  // window, and a fixture with no `completed_at` never drew it.
  { path: "/visits", label: "visits", proof: /Upcoming visits/i, also: /Request a re-clean/i },
  { path: "/billing", label: "billing", proof: /PAYMENT METHOD/i },
  { path: "/property", label: "property", proof: /Your dogs on file/i },
  // The extra-cleanup card waits for its options, so a missing fixture draws
  // a page with the heading and no form -- "Send request" is the proof that
  // the pickers were actually laid out.
  { path: "/requests", label: "requests", proof: /Report a concern/i, also: /Send request/i },
  { path: "/account", label: "account", proof: /Refer a neighbor/i },
  // The pay screen, with tipping on. `also` is the 15% button's dollar
  // figure: it only exists once the intent fixture reached the page, and it
  // is the second line that makes the tip buttons the tallest row in the card.
  {
    path: `/pay/${PORTAL_PAY_INVOICE_ID}`,
    label: "pay",
    proof: /Add a tip/i,
    also: /\$15\.60/,
  },
];

/** A customer opens this from a text. 360 and 430 are the two that matter;
 *  768 and 1280 are here because a portal link also gets opened on a laptop
 *  when the invoice is the reason. */
const WIDTHS = [360, 430, 768, 1280];

for (const width of WIDTHS) {
  test.describe(`the customer portal at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 2 });

    for (const page_ of PAGES) {
      test(`${page_.label}`, async ({ page }) => {
        // No session: the portal authenticates on the token in the URL, so
        // there is deliberately nothing in localStorage here.
        await installStubBackend(page, { portal: true });
        await page.goto(BASE + page_.path, { waitUntil: "domcontentloaded" });

        // Two proofs, because one is not enough. The name proves the gate
        // opened and the fixture reached the component -- it is only on
        // screen when `verified` is true. The per-page locator proves this is
        // that page and not the shared shell, which is identical on all six.
        await expect(page.getByText(PORTAL_CLIENT_NAME).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(page_.proof).first()).toBeVisible({ timeout: 15_000 });
        if ("also" in page_ && page_.also) {
          await expect(page.getByText(page_.also).first()).toBeVisible({ timeout: 15_000 });
        }
        await page.waitForTimeout(700);

        const { scrollW, innerW } = await measurePageOverflow(page);
        expect(scrollW, `portal ${page_.label} @${width}: scrolls sideways`).toBeLessThanOrEqual(
          innerW + 1,
        );
        expect(await findControlsOffTheSide(page), `portal ${page_.label} @${width}`).toEqual([]);
        expect(await findSilentlyClippedText(page), `portal ${page_.label} @${width}`).toEqual([]);
        if (width < 768) {
          expect(await findControlsUnder44px(page), `portal ${page_.label} @${width}`).toEqual([]);
        }
      });
    }
  });
}

test.describe("the two doors a customer arrives at", () => {
  test.use({ viewport: { width: 360, height: 900 }, isMobile: true, deviceScaleFactor: 2 });

  test("the generic company sign-in holds together", async ({ page }) => {
    // /portal/:slug with no token: what someone reaches by typing the company
    // name, or by following a link whose token has been stripped by a mail
    // client. It is a real page with a real form and it was measured nowhere.
    await installStubBackend(page, { portal: true });
    await page.goto(`/portal/${PORTAL_SLUG}`, { waitUntil: "domcontentloaded" });
    // Branding proves the slug resolved; without the stub this reads
    // "Company not found", which lays out fine and means nothing.
    await expect(page.getByText(/Whitfield & Ramirez/i).first()).toBeVisible({ timeout: 30_000 });

    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW).toBeLessThanOrEqual(innerW + 1);
    expect(await findControlsOffTheSide(page)).toEqual([]);
    expect(await findSilentlyClippedText(page)).toEqual([]);
    expect(await findControlsUnder44px(page)).toEqual([]);
  });

  test("an expired link is still a page, and still has to fit", async ({ page }) => {
    // Deliberately WITHOUT the portal fixture, so portalContext answers null
    // and the layout renders its dead end. This is the state a customer hits
    // with an old text message, and the copy in it is long.
    await installStubBackend(page);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/link has expired/i).first()).toBeVisible({ timeout: 30_000 });

    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW).toBeLessThanOrEqual(innerW + 1);
    expect(await findControlsOffTheSide(page)).toEqual([]);
    expect(await findControlsUnder44px(page)).toEqual([]);
  });
});

test.describe("the payment link, which is not the portal and arrives the same way", () => {
  /**
   * `/pay/i/:token`. No session, no OTP, no nav — an invoice and a card field,
   * opened on a phone by somebody who has just been asked for money. It is the
   * shortest path in the product between a text message and a payment, and it
   * had never been measured in the state that matters: with no fixture,
   * `getPublicInvoice` answers `{ found: false }` and the page renders "This
   * payment link isn't valid", which lays out fine and proves nothing.
   *
   * The fixture applies account credit on purpose. "Total" and "Amount due"
   * being different numbers is a taller money block than the simple case, and
   * the simple case is the one that would have been measured by accident.
   */
  for (const width of WIDTHS) {
    test(`holds together at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await installStubBackend(page, { portal: true });
      await page.goto(`/pay/i/${PORTAL_TOKEN}`, { waitUntil: "domcontentloaded" });

      // The client's name proves the invoice resolved; "Amount due" proves the
      // money block rendered rather than just the header.
      await expect(page.getByText(PORTAL_CLIENT_NAME).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/Amount due/i).first()).toBeVisible({ timeout: 15_000 });
      // And that it is THIS invoice, not a fallback: the net figure only
      // exists because credit was applied to it.
      const due = (PUBLIC_INVOICE.invoice.amountDueCents / 100).toFixed(2);
      await expect(page.getByText(`$${due}`).first()).toBeVisible();
      // The sales-tax line, which only a taxed invoice draws: measured here
      // because it is the one row an untaxed fixture would never put on the
      // page.
      await expect(page.getByText("Sales tax (8.25%)").first()).toBeVisible();
      // The tip choices, in their widest state: Custom picked, so the amount
      // box is drawn under the five buttons, and an amount typed into it so
      // the totals below show a tip. The total proves the intent fixture
      // re-priced it (104.00 + 7.50), rather than the box merely existing.
      await expect(page.getByText(/Add a tip/i).first()).toBeVisible({ timeout: 15_000 });
      await page.getByRole("radio", { name: /Custom/ }).click();
      await page.getByLabel("Tip amount").fill("7.50");
      await page.getByLabel("Tip amount").blur();
      await expect(page.getByText("$111.50").first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(700);

      const { scrollW, innerW } = await measurePageOverflow(page);
      expect(scrollW, `pay link @${width}: scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
      expect(await findControlsOffTheSide(page), `pay link @${width}`).toEqual([]);
      expect(await findSilentlyClippedText(page), `pay link @${width}`).toEqual([]);
      if (width < 768) {
        expect(await findControlsUnder44px(page), `pay link @${width}`).toEqual([]);
      }
    });
  }
});

test.describe("the quote link, which a customer signs on a phone", () => {
  /**
   * `/q/:token`. Arrives like the pay link: a text or an email, no session.
   * Four states, because each draws a different panel under the same
   * document -- the accept form, the signed outcome, the declined outcome
   * with the customer's own reason, and the expired notice -- and a sweep of
   * one of them says nothing about the other three.
   *
   * 320 as well as the portal's four widths: the working agreement names
   * 320-360 as a real phone, and a signature box with two buttons beside it
   * is the row most likely to be too wide at the narrow end.
   *
   * Two proofs per page, for the reason at the top of this file: the
   * business's 85-character name proves the fixture reached the page (with
   * no fixture it says "This quote link isn't valid" and fits anywhere), and
   * a per-state string proves this is that state. The 60-character line and
   * both totals prove the lines drew, one-time AND per-visit.
   */
  const STATES = [
    // The deposit (added 2026-09-30): due-on-accepting before, the Pay
    // button after. Both are the longest things on their pages at 320px.
    { state: "sent", proof: /Accept quote/, also: ["deposit is due when you accept"] },
    {
      state: "accepted",
      proof: /You accepted this quote/,
      also: [QUOTE_SIGNER, "Pay $1,500.00 deposit"],
    },
    { state: "declined", proof: /You declined this quote/, also: ["holding next year"] },
    { state: "expired", proof: /This quote has expired/ },
  ] as const;

  for (const width of [320, ...WIDTHS]) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 2 });

      for (const s of STATES) {
        test(`${s.state}`, async ({ page }) => {
          await installStubBackend(page, { portal: true });
          await page.goto(`/q/${QUOTE_TOKENS[s.state]}`, { waitUntil: "domcontentloaded" });

          await expect(page.getByText(QUOTE_ORG_NAME).first()).toBeVisible({ timeout: 30_000 });
          await expect(page.getByText(s.proof).first()).toBeVisible({ timeout: 15_000 });
          if ("also" in s) {
            for (const text of s.also) await expect(page.getByText(text).first()).toBeVisible();
          }
          await expect(page.getByText(QUOTE_LONG_LINE).first()).toBeVisible();
          // Both totals: $51.00 per visit and $165.00 once.
          await expect(page.getByText("$51.00").first()).toBeVisible();
          await expect(page.getByText("$165.00").first()).toBeVisible();
          await page.waitForTimeout(700);

          const { scrollW, innerW } = await measurePageOverflow(page);
          expect(scrollW, `quote ${s.state} @${width}: scrolls sideways`).toBeLessThanOrEqual(
            innerW + 1,
          );
          expect(await findControlsOffTheSide(page), `quote ${s.state} @${width}`).toEqual([]);
          expect(await findSilentlyClippedText(page), `quote ${s.state} @${width}`).toEqual([]);
          if (width < 768) {
            expect(await findControlsUnder44px(page), `quote ${s.state} @${width}`).toEqual([]);
          }
        });
      }

      test("decline opens a reason box that still fits", async ({ page }) => {
        await installStubBackend(page, { portal: true });
        await page.goto(`/q/${QUOTE_TOKENS.sent}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByText(/Accept quote/).first()).toBeVisible({ timeout: 30_000 });
        await page.getByRole("button", { name: "Decline", exact: true }).click();
        await expect(page.getByText(/Reason \(optional\)/)).toBeVisible();

        const { scrollW, innerW } = await measurePageOverflow(page);
        expect(scrollW, `quote decline @${width}: scrolls sideways`).toBeLessThanOrEqual(
          innerW + 1,
        );
        expect(await findControlsOffTheSide(page), `quote decline @${width}`).toEqual([]);
        if (width < 768) {
          expect(await findControlsUnder44px(page), `quote decline @${width}`).toEqual([]);
        }
      });
    });
  }
});

test.describe("the live map, which a customer opens from the on-my-way text", () => {
  /**
   * `/track/:token`. Arrives in a text, on a phone, while the customer is
   * deciding whether to put the dogs in: 320px is the width that matters.
   * Five states, because each draws a different page -- en route with the
   * map, en route with nothing shared yet, arrived, done, and ended -- and
   * the map is the one wide thing on any of them.
   *
   * Two proofs per state, as above: the 85-character business name proves
   * the fixture reached the page (without it the page says "This tracking
   * link isn't valid" and fits anywhere), and a per-state string proves this
   * is that state. For the map state, the Leaflet container and its two
   * drawn circles prove the MAP rendered, not the text fallback: tiles are
   * answered by the fence with a transparent PNG, so what is measured is the
   * map's box and its overlay, which is what can widen a page.
   */
  const STATES = [
    { state: "en_route", proof: new RegExp(`${TRACKING_TECH_NAME} is on the way`), map: true },
    { state: "en_route_unshared", proof: /location not shared right now/, map: true },
    { state: "arrived", proof: /Your tech has arrived/, map: false },
    { state: "done", proof: /Today's visit is done/, map: false },
    { state: "ended", proof: /Live tracking for this visit has ended/, map: false },
  ] as const;

  for (const width of [320, ...WIDTHS]) {
    test.describe(`at ${width}px`, () => {
      test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 2 });

      for (const s of STATES) {
        test(`${s.state}`, async ({ page }) => {
          await installStubBackend(page, { portal: true });
          await page.goto(`/track/${TRACKING_TOKENS[s.state]}`, { waitUntil: "domcontentloaded" });

          await expect(page.getByText(TRACKING_ORG_NAME).first()).toBeVisible({ timeout: 30_000 });
          await expect(page.getByText(s.proof).first()).toBeVisible({ timeout: 15_000 });
          if (s.state === "en_route") {
            await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 15_000 });
            // The 100 m ring, the tech's dot and the property's dot.
            await expect(page.locator(".leaflet-overlay-pane path")).toHaveCount(3, {
              timeout: 15_000,
            });
            await expect(page.getByText(/between 10:15 AM and 10:45 AM/)).toBeVisible();
            await expect(page.getByText(/Updated \d+ min ago|Updated just now/)).toBeVisible();
          }
          if (s.state === "en_route_unshared") {
            // Only the property: one dot, no ring.
            await expect(page.locator(".leaflet-overlay-pane path")).toHaveCount(1, {
              timeout: 15_000,
            });
          }
          if (!s.map) await expect(page.locator(".leaflet-container")).toHaveCount(0);
          await page.waitForTimeout(700);

          const { scrollW, innerW } = await measurePageOverflow(page);
          expect(scrollW, `track ${s.state} @${width}: scrolls sideways`).toBeLessThanOrEqual(
            innerW + 1,
          );
          expect(await findControlsOffTheSide(page), `track ${s.state} @${width}`).toEqual([]);
          expect(await findSilentlyClippedText(page), `track ${s.state} @${width}`).toEqual([]);
          if (width < 768) {
            expect(await findControlsUnder44px(page), `track ${s.state} @${width}`).toEqual([]);
          }
        });
      }
    });
  }

  test("an unknown link says so, and still fits at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await installStubBackend(page, { portal: true });
    await page.goto("/track/eeeeeeee-0000-4000-8000-00000000e999", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText(/This tracking link isn.t valid/)).toBeVisible({ timeout: 30_000 });
    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW).toBeLessThanOrEqual(innerW + 1);
  });
});

test.describe("the signup page, which prices the first cleanup by the customer's answer", () => {
  /**
   * `/signup/:slug`, with a business that prices the first cleanup by "when
   * was your yard last cleaned?". Not in every-public-page-at-every-width:
   * that sweep has no backend stub, and this page's lookup is a server
   * function that would otherwise reach the live project. Here it is
   * answered by `getSignupOrg` / `getSignupQuote` in the portal stubs.
   *
   * Measured in its widest state: the question answered with the owner's
   * longest answer, and the quote panel drawn, so the first-cleanup line
   * holds that answer under its label beside the price. Two proofs, as
   * everywhere in this file: the business's name proves the lookup reached
   * the page (without it the page says "Signup unavailable"), and $150.00 --
   * the long answer's price -- proves the quote came back priced for the
   * answer picked rather than drawing the no-answer state.
   */
  for (const width of [320, ...WIDTHS]) {
    test(`holds together at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await installStubBackend(page, { portal: true });
      await page.goto(`/signup/${PORTAL_SLUG}`, { waitUntil: "domcontentloaded" });

      await expect(page.getByText(PORTAL_ORG_NAME).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("When was your yard last cleaned?")).toBeVisible({
        timeout: 15_000,
      });

      await page.getByLabel("ZIP code").fill("60601");
      await page.locator("#last_cleaned").click();
      await page.getByRole("option", { name: SIGNUP_LONG_TIER_LABEL }).click();
      await page.getByRole("button", { name: "Get instant price" }).click();

      await expect(page.getByText(`Last cleaned: ${SIGNUP_LONG_TIER_LABEL}`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText("$150.00").first()).toBeVisible();
      await expect(page.getByText("$25.00/visit")).toBeVisible();
      await page.waitForTimeout(700);

      const { scrollW, innerW } = await measurePageOverflow(page);
      expect(scrollW, `signup @${width}: scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
      expect(await findControlsOffTheSide(page), `signup @${width}`).toEqual([]);
      expect(await findSilentlyClippedText(page), `signup @${width}`).toEqual([]);
      if (width < 768) {
        expect(await findControlsUnder44px(page), `signup @${width}`).toEqual([]);
      }
    });
  }
});
