// Auto-routing runs in the background.
//
// The owner, 2026-10-04: "When utilizing the auto-routing and it takes a
// while, allow it to be dismissed to run in a background."
//
// The whole loop, in a browser, on the stubbed backend, with a run that does
// not finish until the test says so:
//
//   press Apply → the card says what stage it is at and offers "Run in
//   background" → dismiss it → go to another page → the header says
//   "Planning routes…" there → the run finishes → the header turns into
//   "Routes ready, review" and a toast says so → tap it → back on /routes,
//   the card opens and replays the result, and the run is marked seen.
//
// At a phone (360, touch, so `touch:` sizing applies) and a laptop (1280).
// The indicator lives in a header that already holds a search field, a bell
// and an avatar, so each step also checks that nothing goes over the side
// and that the pill is a real 44px target where a thumb is the pointer --
// and 320px is checked with the pill showing, because it is the width where
// one more control in that header would push something off.
//
// The stub holds startRoutingRun's request open for the whole run, which is
// what the real server function does while the browser is connected. Nothing
// on screen depends on that request returning: the card and the header watch
// the run's row (listMyRoutingRuns), and that is what this drives.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import * as fx from "./fixtures/dataset";
import { findControlsOffTheSide, measurePageOverflow } from "./rules";

const TECH_IDS = fx.STAFF.filter((s) => s.is_field_tech).map((s) => s.id);

/** The run the stub plays, one poll at a time. */
function scriptedRun() {
  const state = {
    runId: null as string | null,
    phase: "idle" as "idle" | "running" | "done",
    polls: 0,
    seen: false,
    seenCalls: 0,
    startCalls: 0,
  };
  let release!: () => void;
  const finished = new Promise<void>((r) => (release = r));

  const RESULT = {
    stops: 3,
    skipped: [],
    balance: [
      { staffId: TECH_IDS[0], stops: 2, totalMin: 60 },
      { staffId: TECH_IDS[1], stops: 1, totalMin: 30 },
    ],
    forecast: { stops: 3, daysPlanned: 2, daysMeasured: 2, savedMin: 12, violations: 0 },
    estimatedDays: [],
    partlyEstimatedDays: [],
    fit: { overruns: [], unlocated: [] },
    windowsHonoured: true,
    windowMisses: [],
    windowMissCount: 0,
  };

  const row = () => {
    const stage =
      state.phase !== "running"
        ? null
        : (["road_times", "optimizing", "saving"] as const)[
            Math.min(2, Math.floor(state.polls / 2))
          ];
    const now = new Date().toISOString();
    return {
      id: state.runId,
      organization_id: fx.ORGANIZATION.id,
      started_by: "00000000-0000-4000-8000-000000000001",
      from_day: "2026-10-05",
      to_day: "2026-10-05",
      staff_ids: TECH_IDS,
      windows: "org",
      status: state.phase === "done" ? "succeeded" : "running",
      stage,
      days_total: 1,
      days_done: stage === "saving" ? 1 : 0,
      result: state.phase === "done" ? RESULT : null,
      error: null,
      applied_at: state.phase === "done" ? now : null,
      watched_at: null,
      seen_at: state.seen ? now : null,
      created_at: now,
      updated_at: now,
      finished_at: state.phase === "done" ? now : null,
    };
  };

  async function install(context: BrowserContext) {
    await context.route("**/_serverFn/**", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
      let name = "";
      try {
        const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
        name = String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
      } catch {
        /* fall through to the stub */
      }
      const reply = (result: unknown) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ result }),
        });

      if (name === "startRoutingRun") {
        state.startCalls++;
        // The browser chose the id; it is the only uuid in the payload that
        // is not a technician's.
        const ids = (route.request().postData() ?? "").match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        );
        state.runId = (ids ?? []).find((x) => !TECH_IDS.includes(x)) ?? null;
        state.phase = "running";
        await finished;
        // The page may have gone by now; a fulfilled route to a closed page
        // is not this test's concern.
        return reply({
          runId: state.runId,
          attached: false,
          status: "succeeded",
          result: RESULT,
        }).catch(() => {});
      }
      if (name === "listMyRoutingRuns") {
        if (state.phase === "running") state.polls++;
        const runs = state.phase === "idle" || state.seen ? [] : [row()];
        return reply({ runs, serverNow: Date.now() });
      }
      if (name === "markRoutingRunSeen") {
        state.seenCalls++;
        state.seen = true;
        return reply({ ok: true });
      }
      return route.fallback();
    });
  }

  return {
    state,
    install,
    finish() {
      state.phase = "done";
      release();
    },
  };
}

async function noSidewaysScroll(page: Page, where: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(
    scrollW,
    `${where}: the page is ${scrollW}px wide on a ${innerW}px screen`,
  ).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${where}: controls off the side`).toEqual([]);
}

async function boxOf(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

for (const { w, h, touch, label } of [
  { w: 360, h: 800, touch: true, label: "360 · a phone, touch" },
  { w: 1280, h: 900, touch: false, label: "1280 · a laptop" },
]) {
  test.describe(`auto-routing in the background at ${label}`, () => {
    test.use({
      viewport: { width: w, height: h },
      hasTouch: touch,
      isMobile: touch,
    });

    test("dismiss it, go elsewhere, and come back to the result", async ({ page, context }) => {
      test.setTimeout(120_000);
      await installSignedInSession(context);
      await installStubBackend(context);
      const run = scriptedRun();
      await run.install(context);

      await page.goto("/routes", { waitUntil: "domcontentloaded" });
      const open = page.getByRole("button", { name: "Auto-routing", exact: true });
      await expect(open).toBeVisible({ timeout: FIRST_PAINT_MS });
      // Nothing running: the header has no indicator at all.
      await expect(page.locator("[data-routing-run]")).toHaveCount(0);

      await open.click();
      const card = page.getByRole("dialog", { name: "Auto-routing" });
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Apply", exact: true }).click();

      // Running: the card says where it is, and Cancel has become the way out.
      const background = card.getByRole("button", { name: "Run in background" });
      await expect(background).toBeVisible();
      await expect(card.getByRole("status")).toContainText(
        /Starting|Fetching road times|Optimizing|Saving the routes/,
      );
      await expect(card.getByRole("button", { name: "Planning…" })).toBeDisabled();
      if (touch) {
        const b = await background.boundingBox();
        expect(b!.height, "Run in background is under 44px on touch").toBeGreaterThanOrEqual(44);
      }
      await noSidewaysScroll(page, "/routes, card running");
      expect(run.state.startCalls).toBe(1);

      await background.click();
      await expect(card).toHaveCount(0);

      // The header carries it from here, on this page...
      const pill = page.locator('[data-routing-run="running"]');
      await expect(pill).toBeVisible({ timeout: 10_000 });

      // ...and on another one, reached in-app (not a reload).
      await page.locator('a[href="/clients"]').first().click();
      await expect(page).toHaveURL(/\/clients$/);
      await expect(pill).toBeVisible();
      const pb = await boxOf(page, '[data-routing-run="running"]');
      if (touch) {
        expect(pb.height, "the pill is under 44px tall").toBeGreaterThanOrEqual(44);
        expect(pb.width, "the pill is under 44px wide").toBeGreaterThanOrEqual(44);
      } else {
        // Room for words at this width: it says what it is doing.
        await expect(pill).toContainText(/Road times|Optimizing|Saving routes|Planning routes/);
      }
      await noSidewaysScroll(page, "/clients, run in progress");
      if (touch) {
        // The narrowest phone, with one more control in the header.
        await page.setViewportSize({ width: 320, height: 700 });
        await noSidewaysScroll(page, "/clients at 320, run in progress");
        await page.setViewportSize({ width: w, height: h });
      }

      // It finishes while the person is elsewhere.
      run.finish();
      const ready = page.locator('[data-routing-run="ready"]');
      await expect(ready).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Routes ready", { exact: true })).toBeVisible();
      await expect(ready).toHaveAttribute("aria-label", "Routes are ready. Open the review.");
      if (!touch) await expect(ready).toContainText("Routes ready, review");
      expect(run.state.seenCalls, "marked seen before anyone looked").toBe(0);

      // Tap it: back to /routes, where the card opens and replays the result.
      await ready.click();
      await expect(page).toHaveURL(/\/routes$/);
      await expect(page.getByRole("dialog", { name: "Auto-routing" })).toBeVisible();
      await expect(page.getByText(/^Routed 3 stops/)).toBeVisible();
      await expect(page.getByText("Saves about 12 min of driving.")).toBeVisible();
      await expect.poll(() => run.state.seenCalls).toBe(1);
      // Seen: the header has nothing left to say.
      await expect(page.locator("[data-routing-run]")).toHaveCount(0);
      await noSidewaysScroll(page, "/routes, reviewing");
    });
  });
}
