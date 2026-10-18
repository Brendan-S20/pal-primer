/**
 * The navigation and phone/tablet changes from the launch pass, in a browser,
 * at the widths CLAUDE.md names and at the iPad sizes with touch on:
 *
 *  - /inbox: everything waiting on the office, in one list;
 *  - Reports, Analytics and Tax & accountant as tabs of one Reports area;
 *  - the dashboard's setup checklist folded to the next step on a phone;
 *  - invoice cards on a phone, most actionable first, with New invoice first;
 *  - Schedule lanes at tablet width: one row, names not truncated (#495).
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { measurePageOverflow, findControlsOffTheSide, findControlsUnder44px } from "./rules";

const WIDTHS = [
  { w: 360, h: 780, label: "360 · a real phone" },
  { w: 768, h: 1024, label: "768 · tablet portrait" },
  { w: 1280, h: 800, label: "1280 · small laptop" },
  { w: 1920, h: 1080, label: "1920 · wide monitor" },
];
const IPADS = [
  { w: 744, h: 1133, label: "744×1133 · iPad mini portrait" },
  { w: 820, h: 1180, label: "820×1180 · iPad Air portrait" },
  { w: 1024, h: 1366, label: "1024×1366 · iPad Pro portrait" },
  { w: 1366, h: 1024, label: "1366×1024 · iPad Pro landscape" },
];
const ALL = [
  ...WIDTHS.map((s) => ({ ...s, touch: false })),
  ...IPADS.map((s) => ({ ...s, touch: true })),
];

async function open(
  page: Page,
  path: string,
  role: SweepRole = "owner",
  prefs: Record<string, string> = {},
) {
  await installSignedInSession(page);
  await installStubBackend(page, { role });
  if (Object.keys(prefs).length) {
    await page.addInitScript((p) => {
      for (const [k, v] of Object.entries(p)) window.localStorage.setItem(k, v);
    }, prefs);
  }
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function holdsTogether(page: Page, label: string, touch: boolean) {
  await page.waitForTimeout(500);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label}: controls off the side`).toEqual([]);
  if (touch) {
    expect(await findControlsUnder44px(page), `${label}: controls under 44px`).toEqual([]);
  }
}

for (const s of ALL) {
  test.describe(`@ ${s.label}`, () => {
    test.use({ hasTouch: s.touch });

    test("the inbox lists what is waiting, and only that", async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      await open(page, "/inbox");
      await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      // The fixture's one inbound thread is here; its one outbound thread,
      // already answered, is not.
      await expect(page.getByText("Northbrook Homeowners Association #4471").first()).toBeVisible();
      await expect(page.getByText("On my way, arriving between")).toHaveCount(0);
      // The fixture's open concern and its two unread alerts.
      await expect(page.getByText("Concerns and requests")).toBeVisible();
      await expect(page.getByText("Invoice INV-10420 is 6 days overdue")).toBeVisible();
      await expect(page.locator('[data-inbox-section="/review"] [data-inbox-count]')).toHaveText(
        "4",
      );
      await holdsTogether(page, `inbox ${s.label}`, s.touch || s.w < 768);
    });

    test("Reports is one area with three tabs", async ({ page }) => {
      await page.setViewportSize({ width: s.w, height: s.h });
      for (const [path, tab] of [
        ["/reports", "Overview"],
        ["/analytics", "Analytics"],
        ["/tax-reports", "Tax & accountant"],
      ] as const) {
        await open(page, path);
        const nav = page.getByRole("navigation", { name: "Reports" });
        await expect(nav).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(nav.getByRole("link")).toHaveCount(3);
        await expect(nav.getByRole("link", { name: tab, exact: true })).toHaveAttribute(
          "aria-current",
          "page",
        );
        await holdsTogether(page, `${path} ${s.label}`, s.touch || s.w < 768);
      }
    });
  });
}

test.describe("the sidebar, with Reports and Inbox", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("one Reports entry, highlighted on Analytics; an Inbox entry", async ({ page }) => {
    await open(page, "/analytics");
    const sidebar = page.locator('[data-sidebar="sidebar"]').first();
    await expect(sidebar.getByRole("link", { name: "Reports" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(sidebar.getByRole("link", { name: "Analytics", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Tax & accountant" })).toHaveCount(0);
    await expect(
      sidebar.locator('[data-active="true"]').filter({ hasText: "Reports" }),
    ).toHaveCount(1);
    await expect(sidebar.getByRole("link", { name: "Inbox" })).toBeVisible();
  });

  test("a technician has no inbox", async ({ page }) => {
    await open(page, "/inbox", "tech");
    await expect(page).toHaveURL(/\/my-day/, { timeout: FIRST_PAINT_MS });
  });
});

test.describe("the setup checklist on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("shows the next step, not seven, and opens to all of them", async ({ page }) => {
    await open(page, "/dashboard");
    const card = page.getByTestId("onboarding-checklist");
    await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
    const visibleSteps = () => card.locator("li:visible").count();
    expect(await visibleSteps()).toBe(1);
    // The next undone step in the fixture.
    await expect(card.getByText("Add or import clients")).toBeVisible();
    const height = await card.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    // Seven full-height steps were about two screens; one step, the header
    // and the bar is about 340px with this fixture's longest description.
    expect(height, `the checklist is ${height}px on a phone`).toBeLessThanOrEqual(380);
    await card.getByRole("button", { name: "Show all 6 steps" }).click();
    expect(await visibleSteps()).toBe(6);
    await card.getByRole("button", { name: "Show less" }).click();
    expect(await visibleSteps()).toBe(1);
    await holdsTogether(page, "dashboard 390", true);
  });

  test("at a desk, the unfinished steps without the finished ones", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await open(page, "/dashboard");
    const card = page.getByTestId("onboarding-checklist");
    await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
    // 6 steps, 3 done: the three left.
    expect(await card.locator("li:visible").count()).toBe(3);
    await expect(card.getByText("Your business details")).toBeHidden();
    await ctx.close();
  });
});

test.describe("invoices on a phone", () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });

  test("most actionable first, and New invoice leads the toolbar", async ({ page }) => {
    await open(page, "/invoices");
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByText("INV-10420").first()).toBeVisible();
    // The fixture arrives newest first: open (3 days overdue), paid, void,
    // open (due today), paid, void, open (due in 3 days), paid.
    const order = await page.evaluate(() => {
      const list = [...document.querySelectorAll("div.md\\:hidden")].find((d) =>
        /INV-1042/.test(d.textContent || ""),
      );
      return [...(list?.textContent ?? "").matchAll(/INV-(\d+)/g)]
        .map((m) => m[1])
        .filter((n, i, all) => all.indexOf(n) === i);
    });
    expect(order).toEqual(["10420", "10423", "10426", "10421", "10424", "10427", "10422", "10425"]);

    const newBox = await page.getByRole("button", { name: "New invoice" }).first().boundingBox();
    const csvBox = await page.getByRole("button", { name: "Export CSV" }).first().boundingBox();
    expect(
      newBox!.y < csvBox!.y || (Math.abs(newBox!.y - csvBox!.y) < 4 && newBox!.x < csvBox!.x),
      "New invoice is not before Export CSV",
    ).toBe(true);
    await holdsTogether(page, "invoices 360", true);
  });
});

test.describe("Schedule lanes at tablet width", () => {
  const sizes = [
    { w: 768, h: 1024, label: "768 · tablet portrait", touch: false },
    // Not the iPad mini at 744: below `md` the board is the day LIST, one
    // card per visit, with no lanes to measure.
    ...IPADS.filter((s) => s.w >= 768).map((s) => ({ ...s, touch: true })),
  ];
  for (const s of sizes) {
    test.describe(s.label, () => {
      test.use({ hasTouch: s.touch });
      test("every lane shows its tech's name rather than a few letters of it", async ({ page }) => {
        await page.setViewportSize({ width: s.w, height: s.h });
        await open(page, "/routes", "owner", {
          "routes.viewMode": "board",
          "routes.range": "today",
        });
        await expect(page.getByRole("button", { name: "Auto-routing" })).toBeVisible({
          timeout: FIRST_PAINT_MS,
        });
        await expect(page.locator("[data-lane-title]:visible").first()).toBeVisible();
        // ── WAIT FOR THE SECOND LANE, NOT JUST THE FIRST ─────────────────
        //
        // "Unassigned" is a lane too and can paint before the crew query
        // answers, so the line above can pass with one lane on the page.
        // On 2026-10-08, the first time this ran beside seven other workers
        // (PR #359, Windows runner), it measured in exactly that frame:
        // `expected 1 to be greater than 1`, with a failure screenshot that
        // shows Unassigned AND Alejandro's lane. This waits for what the
        // assertion below needs, by the same visibility test it uses; a
        // board that never draws a second lane still fails, on a timeout
        // that names the count.
        await expect
          .poll(
            () =>
              page
                .locator("[data-lane-title]")
                .evaluateAll(
                  (els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).length,
                ),
            { timeout: 15_000, message: `${s.label}: the board drew fewer than two lanes` },
          )
          .toBeGreaterThan(1);
        const lanes = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-lane-title]")]
            .filter((el) => el.offsetParent !== null)
            .map((el) => ({
              name: el.textContent ?? "",
              shown: Math.round(el.getBoundingClientRect().width),
              needs: el.scrollWidth,
              // The lane's own top edge, not the title's: a title is centred
              // against its lane's controls, which differ from lane to lane.
              top: Math.round(
                el.closest("[data-lane-header]")?.parentElement?.getBoundingClientRect().top ?? -1,
              ),
            })),
        );
        expect(lanes.length).toBeGreaterThan(1);
        // One row (#495). At 1032 the third tech used to wrap onto a second
        // grid row below the fold; now a lane that does not fit is reached by
        // scrolling the row sideways, at the same height as the rest.
        expect(
          new Set(lanes.map((l) => l.top)).size,
          `${s.label}: lanes wrapped onto more than one row: ${JSON.stringify(lanes)}`,
        ).toBe(1);
        for (const l of lanes) {
          // Either the whole name, or at least 150px of it: never "Alejandr…".
          expect(
            l.shown,
            `${s.label}: lane "${l.name}" is ${l.shown}px of ${l.needs}`,
          ).toBeGreaterThanOrEqual(Math.min(l.needs, 150) - 1);
        }
        await holdsTogether(page, `routes ${s.label}`, false);
      });
    });
  }
});
