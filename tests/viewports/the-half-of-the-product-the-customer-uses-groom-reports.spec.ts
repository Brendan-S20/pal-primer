/**
 * #412 in a real browser: the portal's Grooming page with the client's groom
 * reports, at 360 / 430 / 768 / 1280 (the customer portal's widths) and 1920.
 *
 * Each finished groom shows who groomed, what was booked, the add-ons that
 * were billed, the groomer's note, and the before and after photos side by
 * side; above them, the next groom on the schedule.
 *
 * Named under "the-half-of-the-product-the-customer-uses" on purpose: that is
 * a filter in test:viewports:cases, matched against the path, so Sandboxes'
 * one-off cases job runs this file without a change to package.json, which
 * two other open PRs are editing.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. The backend is the stub. This proves the
 * page draws what portalListGroomReports answers, at every width, with the
 * layout rules applied. Which visits and photos that function may read (the
 * session's own client, completed grooms, before and after kinds only) is
 * pinned in tests/a-groomer-says-which-add-ons-were-done.test.ts.
 */
import { test, expect, type Route } from "@playwright/test";
import { installStubBackend, PORTAL_STUBS } from "./fixtures/stub-backend";
import { PORTAL_CLIENT_NAME, PORTAL_SLUG, PORTAL_TOKEN } from "./fixtures/portal-dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

const WIDTHS = [360, 430, 768, 1280, 1920];
const URL_ = `/portal/${PORTAL_SLUG}/${PORTAL_TOKEN}/grooming`;
// The fence answers images with a transparent PNG.
const photo = (n: string) => `/portal-photo/${encodeURIComponent(`groom/${n}.jpg`)}`;
const NOTE =
  "Bartholomew was a star on the table. Light matting behind both ears, brushed out rather than shaved. Skin looked healthy; nails were long, so we took them back in two passes.";

function serverFnName(route: Route): string {
  const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
  try {
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}
const reply = (route: Route, result: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) });

const groomingClient = () => ({
  ...(PORTAL_STUBS.portalGetClient as object),
  mobile_grooming: true,
});

const GROOMING = {
  visible: true,
  canRequest: false,
  today: "2026-11-09",
  workDays: [1, 2, 3, 4, 5],
  bufferMin: 30,
  pets: [],
  services: [],
  rules: [],
  addons: [],
  requests: [],
};

const REPORTS = {
  next: { day: "2026-12-21", startTime: "09:30:00", serviceName: "Full groom" },
  reports: [
    {
      visitId: "9e000000-0000-4000-8000-000000000001",
      day: "2026-11-02",
      serviceName: "Full groom",
      groomerFirstName: "Theodora",
      summary:
        "Full groom for Bartholomew (XL, double coat) + Teeth brushing, De-shed and undercoat rake-out for double-coated breeds",
      addonsDone: ["Teeth brushing", "De-shed and undercoat rake-out for double-coated breeds x2"],
      reportNote: NOTE,
      before: [photo("b1"), photo("b2")],
      after: [photo("a1"), photo("a2"), photo("a3"), photo("a4")],
    },
    {
      visitId: "9e000000-0000-4000-8000-000000000002",
      day: "2026-09-21",
      serviceName: "Bath and tidy",
      groomerFirstName: null,
      summary: "Bath and tidy for Miso (S)",
      addonsDone: [],
      reportNote: null,
      before: [],
      after: [photo("a5")],
    },
  ],
};

for (const width of WIDTHS) {
  test.describe(`#412 portal groom reports at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, hasTouch: width < 1280 });

    test("the client reads each groom's report with before and after photos", async ({ page }) => {
      await installStubBackend(page, { portal: true });
      await page.route("**/_serverFn/**", async (route) => {
        const name = serverFnName(route);
        // The business runs grooming. The client record arrives two ways: on
        // its own, and seeded into the page by portalContext's home bundle.
        if (name === "portalGetClient") return reply(route, groomingClient());
        if (name === "portalContext") {
          const raw =
            decodeURIComponent(route.request().url()) + (route.request().postData() ?? "");
          const ctx = (PORTAL_STUBS.portalContext as (a: object) => any)({
            withHome: raw.includes("withHome"),
          });
          return reply(route, {
            ...ctx,
            client: groomingClient(),
            ...(ctx.home ? { home: { ...ctx.home, client: groomingClient() } } : {}),
          });
        }
        if (name === "portalGetGrooming") return reply(route, GROOMING);
        if (name === "portalListGroomReports") return reply(route, REPORTS);
        if (name === "portalListVaccines") return reply(route, { enabled: false, pets: [] });
        return route.fallback();
      });
      await page.goto(URL_, { waitUntil: "domcontentloaded" });

      // The gate opened (the client's name) and this is the grooming page
      // with its reports (a heading and a note only the fixture has).
      await expect(page.getByText(PORTAL_CLIENT_NAME).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "Groom reports" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole("heading", { name: "Your next groom" })).toBeVisible();
      await expect(page.getByText(/at 09:30 · Full groom/)).toBeVisible();
      await expect(page.getByText("Groomed by Theodora")).toBeVisible();
      await expect(page.getByText(/Add-ons done:/).first()).toBeVisible();
      await expect(page.getByText(NOTE)).toBeVisible();
      await expect(page.getByAltText(/^Before photo 1 from/).first()).toBeVisible();
      await expect(page.getByAltText(/^After photo 4 from/).first()).toBeVisible();
      // The second groom has no before photo and no groomer: neither is drawn.
      await expect(page.getByAltText(/^Before photo/)).toHaveCount(2);
      await expect(page.getByText(/Groomed by/)).toHaveCount(1);
      await page.waitForTimeout(500);

      const { scrollW, innerW } = await measurePageOverflow(page);
      expect(scrollW, `groom reports @${width}: scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
      expect(await findControlsOffTheSide(page), `groom reports @${width}`).toEqual([]);
      expect(await findSilentlyClippedText(page), `groom reports @${width}`).toEqual([]);
      if (width < 768) {
        expect(await findControlsUnder44px(page), `groom reports @${width}`).toEqual([]);
      }
    });
  });
}
