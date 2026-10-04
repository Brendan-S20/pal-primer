/**
 * An app that moves: transitions, loading, gestures, measured in a browser.
 *
 * The owner, 2026-10-04: "I want to have transitions added, loading screen if
 * it's taking a while to load, I want animations, and basic app gestures to
 * work." The arithmetic behind each of these is pinned in
 * tests/an-app-that-moves.test.ts; this file checks that the browser does
 * what the arithmetic says.
 *
 *   1. A navigation runs a view transition, in the direction it should, and
 *      in Arabic the incoming page comes from the other side. Under reduced
 *      motion there is no transition at all.
 *   2. The progress bar appears for a slow navigation and never for a fast
 *      one.
 *   3. A page waiting on its data draws a skeleton, and when the data lands
 *      nothing above it moves: compared by bounding box, not by eye.
 *   4. Pulling down at the top of a page refetches it, with touch events on a
 *      touch browser; a sideways drag does not.
 *   5. A bottom sheet closes when swiped down.
 *
 * Signed in on the stubbed backend like every other spec here, so nothing
 * leaves the machine.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const FIRST_CLIENT = "Kimberly-Anne Rutherford-Sinclair";

async function signIn(context: BrowserContext, role: SweepRole = "owner") {
  await installSignedInSession(context);
  await installStubBackend(context, { role });
}

/** The name of a server function call, from its /_serverFn/<base64url> id. */
function serverFnName(url: string): string {
  const id = new URL(url).pathname.split("/_serverFn/")[1] ?? "";
  try {
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}

/**
 * Record every view transition the page starts, with the types the router
 * gave it and the direction on <html> at that moment, and (while the
 * transition is running) where the incoming page snapshot starts: its
 * computed transform at the first frame of the animation.
 */
async function recordViewTransitions(context: BrowserContext) {
  await context.addInitScript(() => {
    type Entry = { types: string[] | null; dir: string | undefined; startX: number | null };
    const w = window as unknown as { __vt: Entry[] };
    w.__vt = [];
    const doc = document as Document & { startViewTransition?: (a: unknown) => any };
    const original = doc.startViewTransition;
    if (typeof original !== "function") return;
    doc.startViewTransition = function (this: Document, arg: any) {
      const entry: Entry = {
        types: arg && typeof arg === "object" && Array.isArray(arg.types) ? arg.types : null,
        dir: document.documentElement.dataset.navDir,
        startX: null,
      };
      w.__vt.push(entry);
      const t = original.call(this, arg);
      t.ready
        .then(() => {
          // Freeze the page animation on its first frame and read where the
          // incoming page is drawn from.
          const anims = document
            .getAnimations()
            .filter((a: any) => String(a.effect?.pseudoElement ?? "").includes("view-transition-new(hs-page)"));
          for (const a of anims) {
            a.pause();
            a.currentTime = 0;
          }
          const m = getComputedStyle(document.documentElement, "::view-transition-new(hs-page)").transform;
          const match = /matrix\(([^)]+)\)/.exec(m);
          entry.startX = match ? Number(match[1].split(",")[4]) : null;
          for (const a of anims) a.play();
        })
        .catch(() => {});
      return t;
    };
  });
}

const transitions = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __vt: { types: string[] | null; dir?: string; startX: number | null }[] }).__vt,
  );

/** The first client's link, whichever of the card list and the table is on
 *  screen at this width. */
const clientLink = (page: Page) =>
  page.getByRole("link", { name: FIRST_CLIENT }).filter({ visible: true }).first();

async function openClients(page: Page) {
  await page.goto("/clients", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(FIRST_CLIENT).filter({ visible: true }).first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await page.waitForLoadState("networkidle").catch(() => {});
}

test.describe("page transitions", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("going into a client slides forward, and back slides back", async ({ page, context }) => {
    await signIn(context);
    await recordViewTransitions(context);
    await openClients(page);
    await page.evaluate(() => ((window as any).__vt = []));

    await clientLink(page).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/);
    await expect.poll(async () => (await transitions(page)).length).toBeGreaterThan(0);
    const [into] = await transitions(page);
    expect(into.dir, "the direction on <html> when the transition started").toBe("forward");
    expect(into.types).toEqual(["hs-forward"]);
    // Deeper comes in from the END edge: the right, in English.
    expect(into.startX, "the incoming page starts to the right").toBeGreaterThan(0);

    // The client page is up (its back link is the one thing it draws loaded
    // or not) and done fetching, before going back from it.
    await expect(page.getByRole("link", { name: "← Clients" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as any).__vt = []));
    await page.goBack();
    await expect(page).toHaveURL(/\/clients$/);
    await expect.poll(async () => (await transitions(page)).length).toBeGreaterThan(0);
    const [back] = await transitions(page);
    expect(back.dir).toBe("back");
    expect(back.types).toEqual(["hs-back"]);
    // Back: the page underneath drifts in from the START edge.
    expect(back.startX, "the page you return to comes from the left").toBeLessThan(0);

    // And the names come off once it is over: <main>'s column is not left a
    // stacking context for the rest of the session.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.navDir ?? null), {
        timeout: 3000,
      })
      .toBeNull();
  });

  test("in Arabic the incoming page comes from the other side", async ({ page, context }) => {
    await context.addInitScript(() => localStorage.setItem("scoop.lang", "ar"));
    await signIn(context);
    await recordViewTransitions(context);
    await openClients(page);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.evaluate(() => ((window as any).__vt = []));

    await clientLink(page).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/);
    await expect.poll(async () => (await transitions(page)).length).toBeGreaterThan(0);
    const [into] = await transitions(page);
    expect(into.dir).toBe("forward");
    // The END edge of a right-to-left page is its left.
    expect(into.startX, "the incoming page starts to the left").toBeLessThan(0);
  });

  test("switching tabs crossfades instead of sliding", async ({ page, context }) => {
    await signIn(context);
    await recordViewTransitions(context);
    await openClients(page);
    await page.evaluate(() => ((window as any).__vt = []));

    await page.getByRole("link", { name: "Invoices", exact: true }).first().click();
    await expect(page).toHaveURL(/\/invoices$/);
    await expect.poll(async () => (await transitions(page)).length).toBeGreaterThan(0);
    const [tab] = await transitions(page);
    expect(tab.dir).toBe("tab");
    expect(tab.startX ?? 0, "a crossfade does not move sideways").toBe(0);
  });

  test("under reduced motion there is no transition at all", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signIn(context);
    await recordViewTransitions(context);
    await openClients(page);
    await page.evaluate(() => ((window as any).__vt = []));

    await clientLink(page).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/);
    await page.waitForTimeout(600);
    expect(await transitions(page)).toEqual([]);
  });
});

test.describe("the progress bar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /** Has a route progress bar been on the page at any point? */
  async function watchForProgress(context: BrowserContext) {
    await context.addInitScript(() => {
      (window as any).__progressSeen = false;
      new MutationObserver(() => {
        if (document.querySelector("[data-route-progress]")) (window as any).__progressSeen = true;
      }).observe(document, { subtree: true, childList: true });
    });
  }
  const progressSeen = (page: Page) => page.evaluate(() => (window as any).__progressSeen as boolean);

  test("does not appear for a fast navigation", async ({ page, context }) => {
    await signIn(context);
    await watchForProgress(context);
    await openClients(page);
    // Warm: the client page's code is fetched on hover/intent, and its data
    // is a stub that answers at once.
    await clientLink(page).hover();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(() => ((window as any).__progressSeen = false));

    await clientLink(page).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/);
    await page.waitForTimeout(800);
    expect(await progressSeen(page), "a fast navigation flashed the progress bar").toBe(false);
  });

  test("appears for a slow one, and goes when the page is ready", async ({ page, context }) => {
    await signIn(context);
    await watchForProgress(context);
    // The invoices page's own code, held for two seconds: the router cannot
    // render the route until it arrives, which is exactly a slow navigation.
    await context.route(
      (url) => url.pathname.includes("invoices.index.tsx") && url.search.includes("tsr-split"),
      async (route) => {
        await new Promise((r) => setTimeout(r, 2000));
        await route.continue();
      },
    );
    await openClients(page);
    await page.evaluate(() => ((window as any).__progressSeen = false));

    await page.getByRole("link", { name: "Invoices", exact: true }).first().click();
    await expect(page.locator("[data-route-progress]")).toBeVisible({ timeout: 1500 });
    // The router's pending skeleton stands in for the page meanwhile.
    await expect(page.locator("[data-skeleton-region]").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-route-progress]")).toHaveCount(0, { timeout: 3000 });
  });
});

test.describe("skeletons", () => {
  for (const { w, h } of [
    { w: 360, h: 780 },
    { w: 1280, h: 800 },
  ]) {
    test(`/clients draws a skeleton while it waits, and nothing moves when the data lands (${w}px)`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width: w, height: h });
      await signIn(context);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // Registered after the stub, so it runs first: hold the clients list
      // open until the test says so. Everything else falls through.
      await context.route("**/_serverFn/**", async (route) => {
        if (serverFnName(route.request().url()) !== "listClients") return route.fallback();
        await gate;
        return route.fallback();
      });

      await page.goto("/clients", { waitUntil: "domcontentloaded" });
      const heading = page.getByRole("heading", { name: "Clients", exact: true });
      await expect(heading).toBeVisible({ timeout: FIRST_PAINT_MS });
      const skeleton = page.locator("[data-skeleton-region]").first();
      await expect(skeleton).toBeVisible();
      await expect(skeleton).toHaveAttribute("role", "status");
      expect(await page.getByText(FIRST_CLIENT).count(), "data is held back").toBe(0);

      await page.waitForTimeout(300);
      const before = {
        heading: await heading.boundingBox(),
        list: await skeleton.boundingBox(),
      };

      release();
      // The first card below `sm`, the table above it: whichever the
      // skeleton stood in for.
      const firstRow =
        w < 640 ? page.locator(".motion-list > a[href^='/clients/']").first() : page.locator("table").first();
      await expect(firstRow).toBeVisible({ timeout: 10_000 });
      await expect(skeleton).toHaveCount(0);
      // Let the row's entrance (opacity and transform only) finish; neither
      // changes a box, but a transform does move a bounding rect.
      await page.waitForTimeout(500);
      const after = {
        heading: await heading.boundingBox(),
        list: await firstRow.boundingBox(),
      };

      // Position and height. Its WIDTH may change: the heading's block is as
      // wide as the line under it, which goes from "0 total" to "30 total".
      expect(
        { x: after.heading?.x, y: after.heading?.y, height: after.heading?.height },
        "the heading moved when the data landed",
      ).toEqual({ x: before.heading?.x, y: before.heading?.y, height: before.heading?.height });
      expect(
        Math.abs((after.list?.y ?? 0) - (before.list?.y ?? 0)),
        `the list starts at y=${after.list?.y} where its skeleton started at y=${before.list?.y}`,
      ).toBeLessThanOrEqual(1);
      expect(Math.abs((after.list?.x ?? 0) - (before.list?.x ?? 0))).toBeLessThanOrEqual(1);
    });
  }
});

test.describe("gestures", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /** One finger from (x, y0) to (x1, y1), as a touch browser delivers it. */
  async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, selector = "body") {
    await page.evaluate(
      async ({ from, to, selector }) => {
        const target = document.elementFromPoint(from.x, from.y) ?? document.querySelector(selector)!;
        const touch = (x: number, y: number) =>
          new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
        const fire = (type: string, t: Touch | null) =>
          target.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: t && type !== "touchend" ? [t] : [],
              targetTouches: t && type !== "touchend" ? [t] : [],
              changedTouches: t ? [t] : [],
            }),
          );
        fire("touchstart", touch(from.x, from.y));
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          const x = from.x + ((to.x - from.x) * i) / steps;
          const y = from.y + ((to.y - from.y) * i) / steps;
          fire("touchmove", touch(x, y));
          await new Promise((r) => requestAnimationFrame(r));
        }
        fire("touchend", touch(to.x, to.y));
      },
      { from, to, selector },
    );
  }

  test("pulling down at the top of /clients refetches it; a sideways drag does not", async ({
    page,
    context,
  }) => {
    await signIn(context);
    let listCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("/_serverFn/") && serverFnName(r.url()) === "listClients") listCalls++;
    });
    await openClients(page);
    await page.waitForTimeout(300);
    const settled = listCalls;

    // Sideways first: that belongs to whatever scrolls sideways.
    await drag(page, { x: 330, y: 300 }, { x: 60, y: 330 });
    await page.waitForTimeout(800);
    expect(listCalls, "a sideways drag refetched the page").toBe(settled);

    await drag(page, { x: 195, y: 260 }, { x: 195, y: 520 });
    await expect(page.locator("[data-pull-to-refresh]")).toBeAttached();
    await expect.poll(() => listCalls, { timeout: 5000 }).toBeGreaterThan(settled);
    // And it puts itself away.
    await expect(page.locator("[data-pull-to-refresh]")).toHaveCount(0, { timeout: 3000 });
  });

  test("pulling is not a refresh when the page is not at its top", async ({ page, context }) => {
    await signIn(context);
    let listCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("/_serverFn/") && serverFnName(r.url()) === "listClients") listCalls++;
    });
    await openClients(page);
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(300);
    const settled = listCalls;
    await drag(page, { x: 195, y: 260 }, { x: 195, y: 520 });
    await page.waitForTimeout(800);
    expect(listCalls).toBe(settled);
    await expect(page.locator("[data-pull-to-refresh]")).toHaveCount(0);
  });

  test("a bottom sheet closes when swiped down", async ({ page, context }) => {
    await signIn(context, "tech");
    await page.goto("/my-day", { waitUntil: "domcontentloaded" });
    const more = page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "More" });
    await expect(more).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.waitForLoadState("networkidle").catch(() => {});
    await more.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(500);
    const box = (await sheet.boundingBox())!;

    // A short drag springs back.
    await drag(page, { x: box.x + box.width / 2, y: box.y + 20 }, { x: box.x + box.width / 2, y: box.y + 40 });
    await page.waitForTimeout(500);
    await expect(sheet).toBeVisible();

    // A real one closes it.
    await drag(
      page,
      { x: box.x + box.width / 2, y: box.y + 20 },
      { x: box.x + box.width / 2, y: box.y + 20 + box.height * 0.6 },
    );
    await expect(sheet).toHaveCount(0, { timeout: 3000 });
  });
});
