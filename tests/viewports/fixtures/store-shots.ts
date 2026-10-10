// The store screenshot story, shared by the App Store spec
// (app-store-screenshots.spec.ts) and the Play spec
// (play-store-screenshots.spec.ts). One list, so the two listings tell the
// same story in the same order and a change to one is a change to both.
//
// ── WHY THIS FILE REFUSES A FRAME ────────────────────────────────────────
//
// On 2026-10-08 the generator wrote 05-getting-paid.png at all three Apple
// sizes as the app's error boundary ("Something went wrong / all is not
// iterable") and reported 15 passed. The marketing overlay answered
// listInvoices as `{ invoices, total }` while the server function returns a
// bare array, so the page threw on `for (const inv of all)`. The only check
// was "is the PNG over 20 KB", which a centred error message inside the real
// top bar and tab bar clears easily.
//
// So each frame now proves itself the way `settle()` in
// every-signed-in-page-at-every-width.spec.ts makes a surface prove itself:
// enough of a page to be a page, no error boundary, the route it asked for
// rather than /auth, a locator only that page draws, and a string only this
// frame's marketing data contains. A fixture of the wrong shape renders the
// fallback, and the fallback passes every "nothing is wrong" assertion; the
// data string is what a fallback cannot fake.
//
// And one thing settle() does not need: nothing from the SWEEP's dataset may
// be on the page. Its names are long and awkward on purpose; in a store frame
// "Anastasia Vandermolen-Whitaker" is a leak from the layout fixture, and the
// marketing overlay is supposed to have replaced every one a camera can see.
import { expect, type Locator, type Page } from "@playwright/test";
import { FIRST_PAINT_MS } from "./first-paint";
import { installSignedInSession } from "./session";
import { installStubBackend, type SweepRole } from "./stub-backend";
import { installMarketingData } from "./marketing";
import * as fx from "./dataset";

export type StoreShot = {
  name: string;
  path: string;
  /** Who is signed in. My Day is the technician's screen, so it is shot as
   *  the technician: an owner opening /my-day gets the office's chrome. */
  role?: SweepRole;
  /** localStorage set before the app boots (Routes reads its view from it). */
  prefs?: Record<string, string>;
  /** Fold a docked sidebar to its icon rail first (tablets only). For the
   *  office's wide pages, where the full sidebar costs a third of an iPad. */
  foldSidebar?: boolean;
  /** A locator only this page draws. */
  proof: (p: Page) => Locator;
  proofLabel: string;
  /** Text only this frame's marketing data puts on the page. */
  expectsData: string;
  /** Put the page into the state the frame shows, once it has proved itself. */
  ready?: (p: Page) => Promise<void>;
};

// Rows, not columns: on a tablet each technician's round runs the width of the
// screen, so two whole rounds are in frame instead of one column of one round
// beside an empty Unassigned lane. Phones draw the board as a list either way.
const BOARD = {
  "routes.viewMode": "board",
  "routes.range": "today",
  "routes.boardLayout": "rows",
};

/** The story a reviewer reads top to bottom, in order.
 *
 *  Deliberately NOT one shot per feature. The positioning (2026-10-07) is the
 *  business system for pet service companies that work a route, starting with
 *  pet waste removal, and the subtitle is "Schedule, Route, Invoice, Pay". So:
 *  the tech's day, the round, planning the round, the customer, the money. */
export const STORE_SHOTS: StoreShot[] = [
  {
    // The tech's day as the tech sees it in a driveway: the progress, the
    // stops in order, and NEXT UP sitting on the tab bar. Shot as the
    // technician, because it is their screen. Deliberately proves nothing
    // about the clock or the lock-screen control: where those live on My Day
    // is still moving, and a store frame should not pin it.
    name: "my-day",
    path: "/my-day",
    role: "tech",
    proof: (p) => p.getByRole("heading", { name: "My day" }),
    proofLabel: "the My day heading",
    expectsData: "Jennifer Walsh",
    ready: async (p) => {
      // My Day scrolls the stop in progress into view, which on a tall iPad
      // leaves the first stop half under the sticky header. The frame starts
      // at the top of the day.
      await p.evaluate(() => window.scrollTo(0, 0));
      // The bar on the tab bar is the frame's other half. The marketing data
      // puts this technician between stops, so it says NEXT UP.
      await expect(p.getByText(/next up/i).first()).toBeVisible();
    },
  },
  {
    // BOARD, not Map. The map draws its pins and route lines on no basemap at
    // all, because the fence answers tile requests with a transparent pixel.
    // Letting tiles out would send coordinates to a tile server and break the
    // one guarantee that makes this harness safe to run.
    //
    // The board is the better picture anyway: one lane per technician, the
    // round in order, which is the thing being sold.
    name: "the-round",
    path: "/routes",
    foldSidebar: true,
    prefs: BOARD,
    proof: (p) => p.getByRole("button", { name: "Auto-routing" }),
    proofLabel: "the Auto-routing button",
    expectsData: "Dana Ortiz",
  },
  {
    // Over the board, for the same reason.
    name: "auto-routing",
    path: "/routes",
    foldSidebar: true,
    prefs: BOARD,
    proof: (p) => p.getByRole("button", { name: "Auto-routing" }),
    proofLabel: "the Auto-routing button",
    expectsData: "Dana Ortiz",
    ready: async (p) => {
      await p.getByRole("button", { name: "Auto-routing" }).click();
      // The panel is three things: who, which days, Apply. Which is the point
      // of the screenshot.
      await expect(p.getByRole("dialog", { name: "Auto-routing" })).toBeVisible();
    },
  },
  {
    name: "the-customer",
    path: "/clients",
    foldSidebar: true,
    proof: (p) => p.getByRole("heading", { name: "Clients", exact: true }),
    proofLabel: "the Clients heading",
    expectsData: "Maple Ridge HOA",
  },
  {
    name: "getting-paid",
    path: "/invoices",
    foldSidebar: true,
    proof: (p) => p.getByRole("heading", { name: "Invoices", exact: true }),
    proofLabel: "the Invoices heading",
    expectsData: "Jennifer Walsh",
  },
];

/** Text that must never be on a store frame's page: the sweep dataset's people
 *  and business (each one a leak from the layout fixture), and what the
 *  listing has ruled out: an unshipped feature, a test-looking name, an alarm. */
const NEVER_IN_FRAME: Array<string | RegExp> = [
  fx.ORG_NAME,
  ...fx.STAFF.map((s) => s.display_name),
  ...fx.CLIENTS.map((c) => c.display_name),
  "Dana Whitfield-Ramirez",
  "Ravenswood",
  "longishmailprovider",
  "houndstack-sweep",
  /coming soon/i,
  /\bdemo\b/i,
  /\btest\b/i,
  /thunderstorm|weather-flagged/i,
  /implausible/i,
];

/**
 * Sign in as the shot's role, open its page, put it in the frame's state, and
 * refuse to go on unless it is that page with that data on it. Fails the test
 * on an error boundary, a blank page, the sign-in bounce, a missing proof,
 * missing data, or a leaked fixture string.
 */
export async function openStoreShot(page: Page, shot: StoreShot, where: string): Promise<void> {
  const context = page.context();
  const role = shot.role ?? "owner";
  await installSignedInSession(context, shot.prefs);
  await installStubBackend(context, { role });
  // After the stub backend: Playwright matches the last-registered handler first.
  await installMarketingData(context, { role });

  await page.goto(shot.path, { waitUntil: "domcontentloaded" });
  await expect(
    shot.proof(page).first(),
    `${where}: ${shot.proofLabel} is not on screen, so this is not the page the frame names`,
  ).toBeVisible({ timeout: FIRST_PAINT_MS });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});

  // Where the sidebar is docked (a tablet), fold it to its icon rail. At
  // 1024px the full sidebar takes a third of the width, and the page it sits
  // beside (a table, the board) then wraps every name onto two lines. Folded
  // is a state any user gets with one tap, and the rail still says "app".
  // Below the docking width the same button opens a sheet, so it is left alone.
  //
  // Not on My Day: its NEXT UP bar starts at the EXPANDED sidebar's width
  // whatever the sidebar's state, so with the rail folded the bar leaves a
  // 200px gap on its left with the stop list showing through.
  const docked = page.locator('div.peer[data-state="expanded"]');
  if (shot.foldSidebar && (await docked.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
    await expect(page.locator('div.peer[data-state="collapsed"]')).toBeVisible();
  }

  if (shot.ready) {
    await shot.ready(page);
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  // Animations settle, or the shot catches a panel halfway open.
  await page.waitForTimeout(600);

  await expectTheFrameIsThePage(page, shot, where);
}

async function expectTheFrameIsThePage(page: Page, shot: StoreShot, where: string) {
  const health = await page.evaluate(() => ({
    path: location.pathname,
    els: document.querySelectorAll("*").length,
    text: document.body.innerText,
    overlay: Boolean(document.querySelector("vite-error-overlay")),
  }));

  expect(health.overlay, `${where} rendered a Vite error overlay`).toBe(false);
  // src/components/RouteError.tsx. A page in its own right (a heading, a
  // message, two buttons, inside the real top bar and tab bar) so it clears
  // any size threshold while containing none of the app.
  expect(
    health.text.includes("Something went wrong"),
    `${where} rendered the error boundary instead of the page: ${health.text.slice(0, 300)}`,
  ).toBe(false);
  expect(
    health.path,
    `${where} ended up on ${health.path}: the session did not take, so this is not the page`,
  ).toBe(shot.path.split("?")[0]);
  expect(health.els, `${where} rendered only ${health.els} elements`).toBeGreaterThan(40);
  expect(
    health.text.trim().length,
    `${where} rendered only ${health.text.trim().length} characters of text`,
  ).toBeGreaterThan(200);
  await expect(shot.proof(page).first(), `${where}: ${shot.proofLabel} is not on screen`).toBeVisible();
  expect(
    health.text.includes(shot.expectsData),
    `${where} drew its chrome but not "${shot.expectsData}", so the frame is an empty or fallback state, not the data`,
  ).toBe(true);

  const leaks = NEVER_IN_FRAME.filter((n) =>
    typeof n === "string" ? health.text.includes(n) : n.test(health.text),
  ).map(String);
  expect(leaks, `${where} has text a store frame must not show`).toEqual([]);
}
