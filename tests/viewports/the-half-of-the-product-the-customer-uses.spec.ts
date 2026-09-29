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
  PORTAL_SLUG,
  PORTAL_TOKEN,
  PORTAL_CLIENT_NAME,
  PUBLIC_INVOICE,
  QUOTE_LONG_LINE,
  QUOTE_ORG_NAME,
  QUOTE_SIGNER,
  QUOTE_TOKENS,
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
  { path: "/requests", label: "requests", proof: /Report a concern/i },
  { path: "/account", label: "account", proof: /Refer a neighbor/i },
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
    { state: "sent", proof: /Accept quote/ },
    { state: "accepted", proof: /You accepted this quote/, also: QUOTE_SIGNER },
    { state: "declined", proof: /You declined this quote/, also: "holding next year" },
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
          if ("also" in s) await expect(page.getByText(s.also).first()).toBeVisible();
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
