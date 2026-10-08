/**
 * An app that moves: transitions, loading, gestures, measured in a browser.
 *
 * The owner, 2026-10-04: "I want to have transitions added, loading screen if
 * it's taking a while to load, I want animations, and basic app gestures to
 * work." The arithmetic behind each of these is pinned in
 * tests/an-app-that-moves.test.ts; this file checks that the browser does
 * what the arithmetic says.
 *
 *   1. A navigation deeper or back runs a view transition, in the direction
 *      it should, and in Arabic the incoming page comes from the other side.
 *      A tab switch runs none, from the sidebar or from the tab bar, even off
 *      a detail page. Under reduced motion there is no transition at all.
 *   2. The progress bar appears for a slow navigation and never for a fast
 *      one.
 *   3. A page waiting on its data draws a skeleton, but only once it has
 *      waited 160ms, and when the data lands nothing above it moves:
 *      compared by bounding box, not by eye. A list does not animate the
 *      rows it first paints with, and does animate one added later.
 *   4. Pulling down at the top of a page refetches it, with touch events on a
 *      touch browser; a sideways drag does not. The listener that can block
 *      scrolling is only there while the page is at its top.
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
            .filter((a: any) =>
              String(a.effect?.pseudoElement ?? "").includes("view-transition-new(hs-page)"),
            );
          for (const a of anims) {
            a.pause();
            a.currentTime = 0;
          }
          const m = getComputedStyle(
            document.documentElement,
            "::view-transition-new(hs-page)",
          ).transform;
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
    () =>
      (
        window as unknown as {
          __vt: { types: string[] | null; dir?: string; startX: number | null }[];
        }
      ).__vt,
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
    // Wait for the START POSITION, not just the entry: the entry is pushed
    // when the transition starts and startX is filled in on `ready`, so on a
    // busy runner reading as soon as the entry exists read null (CI, #340).
    await expect.poll(async () => (await transitions(page))[0]?.startX ?? null).not.toBeNull();
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
    // Wait for the START POSITION, not just the entry: the entry is pushed
    // when the transition starts and startX is filled in on `ready`, so on a
    // busy runner reading as soon as the entry exists read null (CI, #340).
    await expect.poll(async () => (await transitions(page))[0]?.startX ?? null).not.toBeNull();
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
    // Wait for the START POSITION, not just the entry: the entry is pushed
    // when the transition starts and startX is filled in on `ready`, so on a
    // busy runner reading as soon as the entry exists read null (CI, #340).
    await expect.poll(async () => (await transitions(page))[0]?.startX ?? null).not.toBeNull();
    const [into] = await transitions(page);
    expect(into.dir).toBe("forward");
    // The END edge of a right-to-left page is its left.
    expect(into.startX, "the incoming page starts to the left").toBeLessThan(0);
  });

  test("switching tabs starts no transition at all", async ({ page, context }) => {
    // It was a 160ms crossfade until 2026-10-08. A native app changes tab in
    // place, and a view transition swallows taps for as long as it runs.
    await signIn(context);
    await recordViewTransitions(context);
    await openClients(page);
    await page.evaluate(() => ((window as any).__vt = []));

    await page.getByRole("link", { name: "Invoices", exact: true }).first().click();
    await expect(page).toHaveURL(/\/invoices$/);
    await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.waitForTimeout(600);
    expect(await transitions(page), "a tab switch started a view transition").toEqual([]);
    // And nothing is left named for one.
    expect(await page.evaluate(() => document.documentElement.dataset.navDir ?? null)).toBeNull();
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

test.describe("the tab bar is a tab switch from anywhere", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("from a client's page, Clients in the tab bar does not slide back", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await recordViewTransitions(context);
    await openClients(page);
    await clientLink(page).click();
    await expect(page.getByRole("link", { name: "← Clients" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as any).__vt = []));

    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Clients", exact: true })
      .click();
    await expect(page).toHaveURL(/\/clients$/);
    await expect(clientLink(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.waitForTimeout(600);
    expect(await transitions(page), "a tab bar tap slid like a back").toEqual([]);
  });
});

test.describe("the iOS edge swipe is not animated twice", () => {
  // WKWebView's own back gesture (HSBridgeViewController turns it on) slides
  // the previous page in with the finger and then fires popstate. On iOS a
  // history traversal therefore gets no transition of ours; a link still
  // does.
  test.use({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  });

  test("forward still slides; back does not", async ({ page, context }) => {
    await signIn(context);
    await recordViewTransitions(context);
    await openClients(page);
    await page.evaluate(() => ((window as any).__vt = []));

    await clientLink(page).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/);
    await expect.poll(async () => (await transitions(page)).length).toBeGreaterThan(0);
    expect((await transitions(page))[0].dir).toBe("forward");

    await expect(page.getByRole("link", { name: "← Clients" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    await page.evaluate(() => ((window as any).__vt = []));
    await page.goBack();
    await expect(page).toHaveURL(/\/clients$/);
    await expect(page.getByText(FIRST_CLIENT).filter({ visible: true }).first()).toBeVisible();
    await page.waitForTimeout(600);
    expect(await transitions(page), "a traversal on iOS started a transition of its own").toEqual(
      [],
    );
  });
});

test.describe("the progress bar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  /** When (performance.now()) a route progress bar first appeared, if it
   *  did, and when the last click happened. */
  async function watchForProgress(context: BrowserContext) {
    await context.addInitScript(() => {
      const w = window as any;
      w.__progressAt = null;
      w.__clickAt = null;
      document.addEventListener("click", () => (w.__clickAt = performance.now()), true);
      new MutationObserver(() => {
        if (w.__progressAt === null && document.querySelector("[data-route-progress]"))
          w.__progressAt = performance.now();
      }).observe(document, { subtree: true, childList: true });
    });
  }

  test("does not appear for a fast navigation", async ({ page, context }) => {
    await signIn(context);
    await watchForProgress(context);
    await openClients(page);
    // Warm, the way a real session is: the client page's code has been
    // fetched once already (a cold dev server spends longer than 300ms
    // compiling it, which is a fact about Vite, not about the app), and its
    // data is a stub that answers at once.
    await clientLink(page).click();
    await expect(page.getByRole("link", { name: "← Clients" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.goBack();
    await expect(clientLink(page)).toBeVisible();
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    // A bar still finishing from the warm-up's own navigation (slow on a busy
    // machine) is not this navigation's bar.
    await expect(page.locator("[data-route-progress]")).toHaveCount(0, { timeout: 5000 });
    await page.evaluate(() => ((window as any).__progressAt = null));

    // When did the client page draw, relative to the click? Recorded in the
    // page, because a round trip to the test runner is itself tens of ms.
    await page.evaluate(() => {
      const w = window as any;
      w.__renderedAt = null;
      new MutationObserver((_, obs) => {
        const back = [...document.querySelectorAll("a")].find((a) =>
          a.textContent?.includes("← Clients"),
        );
        if (back) {
          w.__renderedAt = performance.now();
          obs.disconnect();
        }
      }).observe(document, { subtree: true, childList: true });
    });
    await clientLink(page).click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]+$/);
    await page.waitForTimeout(800);
    const t = await page.evaluate(() => {
      const w = window as any;
      return { click: w.__clickAt, rendered: w.__renderedAt, progress: w.__progressAt };
    });
    // Whatever the machine: the bar never appears sooner than 300ms after
    // the navigation began.
    if (t.progress !== null) {
      expect(
        t.progress - t.click,
        "the bar appeared before the 300ms threshold",
      ).toBeGreaterThanOrEqual(280);
    }
    // And a navigation that finished inside 300ms never drew it at all. On a
    // loaded dev server the page can take longer than that, in which case
    // the bar was right to appear and this says so rather than failing.
    if (t.rendered !== null && t.rendered - t.click < 300) {
      expect(t.progress, "a fast navigation flashed the progress bar").toBeNull();
    } else {
      test.info().annotations.push({
        type: "slow-machine",
        description: `the client page took ${Math.round((t.rendered ?? NaN) - t.click)}ms to draw`,
      });
    }
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
    await page.evaluate(() => ((window as any).__progressAt = null));

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

      // Laid out at once, drawn only after its wait: every bone carries the
      // 160ms hold (styles.css, SKELETONS). Read off the animation itself,
      // not off a stopwatch, so a slow runner cannot make it pass or fail.
      const hold = await skeleton.evaluate((region) => {
        const bone = region.querySelector(".hs-skeleton");
        const wait = bone
          ?.getAnimations()
          .find((a) => (a as CSSAnimation).animationName === "hs-skeleton-wait");
        return wait ? Number(wait.effect?.getTiming().delay) : null;
      });
      expect(hold, "a skeleton bone without its wait").toBe(160);

      await page.waitForTimeout(300);
      // ...and once the wait is real, it is drawn.
      expect(
        await skeleton.evaluate((region) =>
          Number(getComputedStyle(region.querySelector(".hs-skeleton")!).opacity),
        ),
      ).toBeGreaterThan(0);
      const before = {
        heading: await heading.boundingBox(),
        list: await skeleton.boundingBox(),
      };

      release();
      // The first card below `sm`, the table above it: whichever the
      // skeleton stood in for.
      const firstRow =
        w < 640
          ? page.locator(".motion-list > a[href^='/clients/']").first()
          : page.locator("table").first();
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

test.describe("list entrance", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test("a list paints its rows still, and animates a row added later", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await context.addInitScript(() => {
      const w = window as any;
      w.__rise = 0;
      document.addEventListener(
        "animationstart",
        (e) => {
          if ((e as AnimationEvent).animationName === "hs-rise") w.__rise++;
        },
        true,
      );
    });
    await openClients(page);
    const list = page.locator(".motion-list").first();
    await expect(list).toHaveAttribute("data-motion-armed", "");
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as any).__rise), "rows rose on first paint").toBe(0);

    // A row arriving mid-session does rise.
    const animated = await list.evaluate((el) => {
      const row = document.createElement("div");
      row.textContent = "new row";
      el.prepend(row);
      return row.getAnimations().map((a) => (a as CSSAnimation).animationName);
    });
    expect(animated).toEqual(["hs-rise"]);
  });
});

test.describe("gestures", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /** One finger from (x, y0) to (x1, y1), as a touch browser delivers it. */
  async function drag(
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
    selector = "body",
  ) {
    await page.evaluate(
      async ({ from, to, selector }) => {
        const target =
          document.elementFromPoint(from.x, from.y) ?? document.querySelector(selector)!;
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

  test("the listener that can hold up a scroll is only there at the top", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await openClients(page);
    const cdp = await context.newCDPSession(page);
    const blocking = async () => {
      const { result } = await cdp.send("Runtime.evaluate", { expression: "document" });
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId!,
      });
      return listeners.filter((l) => l.type === "touchmove" && !l.passive).length;
    };
    expect(await blocking(), "at the top a pull can start, so it listens").toBe(1);
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(blocking, { message: "scrolled, nothing may block a scroll" }).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(blocking).toBe(1);
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
    const more = page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("button", { name: "More" });
    await expect(more).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.waitForLoadState("networkidle").catch(() => {});
    await more.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(500);
    const box = (await sheet.boundingBox())!;

    // A short drag springs back.
    await drag(
      page,
      { x: box.x + box.width / 2, y: box.y + 20 },
      { x: box.x + box.width / 2, y: box.y + 40 },
    );
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
