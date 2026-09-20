// Five zeros are not a welcome.
//
// /neighbors opened on a seeded org with no canvassing rows, measured at 375px
// on 2026-09-19: TOTAL 0, TO VISIT 0, CONTACTED 0, INTERESTED 0, SIGNED UP 0,
// stacked one per row, filling the entire first screen. The two controls that
// can actually put a door on the list — seed from a client, add an address by
// hand — were below the fold, and the page's own pitch was wrapped into a
// narrow column beside a disabled "Walk mode (0)" button. A funnel of zeros
// tells a first-time user nothing except that they have not started.
//
// The fix gives zero doors its own page: the pitch plus the two entry cards,
// with the funnel, the phone-only "Add doors" collapse and the Walk mode
// button appearing only once at least one door exists. This spec pins BOTH
// branches, because the stub fixture ships no canvassing rows: every sweep
// that opens /neighbors (the unlisted-routes catch-all, the role sweep, the
// search-bar case) measures the empty branch and nothing else. Without the
// doors-loaded tests here, reverting the funnel to render at zero — or
// breaking it outright — would be green everywhere.
//
// And the boundary between "no doors" and "don't know yet" is load-bearing:
// a workspace with three hundred doors must not flash the first-run pitch on
// every visit while the list is still in flight. That is tested by holding
// the response open, not by racing a timeout.
import { test, expect, type BrowserContext } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { measurePageOverflow, findControlsUnder44px } from "./rules";

const PHONE = { width: 360, height: 800 };

/**
 * `installStubBackend` has no entry for the neighbors functions, so they
 * answer `null` — which happens to render the empty branch, but by absence
 * rather than by data, and this spec needs the OTHER branch too. Registered
 * after the stub, which in Playwright means matched first; anything not named
 * here falls back to the stub. Same pattern as
 * `the-billing-gate-in-every-state-it-ships.spec.ts`.
 */
async function forceNeighborState(context: BrowserContext, stubs: Record<string, unknown>) {
  await context.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
      name = String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
    } catch {
      /* fall through to the stub */
    }
    if (!(name in stubs)) return route.fallback();
    const value = stubs[name];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: typeof value === "function" ? await value() : value }),
    });
  });
}

/** One client, so the seed card renders — an org about to canvass its first
 *  street has exactly this shape. The name is long on purpose; a picker of
 *  short names proves nothing about a phone. */
const SEED_CLIENTS = {
  clients: [
    {
      id: "cccccccc-0000-4000-8000-0000000000c1",
      display_name: "Aleksandrina Konstantinopoulos-Vanterpool",
    },
  ],
  scope: "mine",
};

const NO_DOORS = { rows: [], summary: { total: 0 } };

/** Awkward on purpose: a 62-character address line and every status the
 *  funnel counts, so the populated branch is measured with real shapes. */
const door = (n: number, status: string) => ({
  id: `dddddddd-0000-4000-8000-0000000000d${n}`,
  seed_client_id: SEED_CLIENTS.clients[0].id,
  seed_client_name: SEED_CLIENTS.clients[0].display_name,
  address_line: `${14820 + n} Grand Traverse Boulevard Northwest, Unit ${n}, Kalamazoo MI`,
  latitude: 42.29 + n * 0.001,
  longitude: -85.58,
  status,
  notes: n === 1 ? "Saw a golden retriever pacing the length of the side fence" : null,
  contacted_at: status === "new" ? null : "2026-09-18T15:04:00.000Z",
  created_at: "2026-09-17T12:00:00.000Z",
});

const FIVE_DOORS = {
  rows: [
    door(1, "new"),
    door(2, "new"),
    door(3, "contacted"),
    door(4, "interested"),
    door(5, "converted"),
  ],
  summary: { total: 5, new: 2, contacted: 1, interested: 1, converted: 1 },
};

test.describe("zero doors gets a first-run page, one door gets the funnel", () => {
  test.use({ viewport: PHONE, isMobile: true, deviceScaleFactor: 2 });

  test("at zero doors, the ways in lead the page and the funnel is gone", async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await forceNeighborState(context, {
      listNeighborLeads: NO_DOORS,
      listCanvassSeedClients: SEED_CLIENTS,
    });

    await page.goto("/neighbors", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Seed from an existing client")).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });

    // Measured by geometry rather than mere visibility, because "visible" is
    // true of a card whose top edge is two screens down — which is exactly
    // what was observed. The FIRST action must start on the first screen; the
    // second gets 1.25 screens, because two stacked forms under the app bar
    // and the trial banner genuinely do not both fit 800px, and the fault this
    // pins is "a screen of zeros before any action", not "every form at once".
    const topOf = async (title: string) =>
      page
        .getByText(title, { exact: true })
        .evaluate((el) => Math.round(el.getBoundingClientRect().top + window.scrollY));
    const seedTop = await topOf("Seed from an existing client");
    expect(
      seedTop,
      `the seed card starts at y=${seedTop}, below a ${PHONE.height}px first screen`,
    ).toBeLessThan(PHONE.height);
    const manualTop = await topOf("Add a door manually");
    expect(
      manualTop,
      `the manual card starts at y=${manualTop}, more than a thumb-flick below a ` +
        `${PHONE.height}px screen`,
    ).toBeLessThan(PHONE.height * 1.25);

    // No funnel. "To visit" is a tile label the empty page has no other use
    // for — the table that also says it is not rendered on this branch.
    await expect(page.getByText("To visit", { exact: true })).toHaveCount(0);

    // And no Walk mode button: hidden at zero doors rather than disabled,
    // because a disabled (0) advertises a mode that cannot start and was the
    // thing squeezing the pitch into a half-width column.
    await expect(page.getByRole("button", { name: /Walk mode/ })).toHaveCount(0);

    // The first-run page obeys the same geometry the sweeps enforce.
    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW, "the first-run page scrolls horizontally").toBeLessThanOrEqual(innerW);
    expect(await findControlsUnder44px(page)).toEqual([]);
  });

  test("a page still fetching shows neither the pitch nor the funnel", async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await forceNeighborState(context, { listCanvassSeedClients: SEED_CLIENTS });

    // The leads response is HELD OPEN until this test releases it, so what
    // the page does "while loading" is a state we are standing in, not a
    // window we hope to race.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await context.route("**/_serverFn/**", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
      let name = "";
      try {
        const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
        name = String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
      } catch {
        /* fall through */
      }
      if (name !== "listNeighborLeads") return route.fallback();
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: NO_DOORS }),
      });
    });

    await page.goto("/neighbors", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Loading…", { exact: true }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    // Neither branch has jumped the gun: no pitch (which would flash at every
    // workspace that HAS doors), no zero-funnel (the page this spec replaced).
    await expect(page.getByText("No doors on the list yet", { exact: false })).toHaveCount(0);
    await expect(page.getByText("To visit", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Walk mode/ })).toHaveCount(0);

    release();
    await expect(page.getByText("No doors on the list yet", { exact: false })).toBeVisible();
  });

  test("one street of doors brings back the funnel, Walk mode and the fold", async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await forceNeighborState(context, {
      listNeighborLeads: FIVE_DOORS,
      listCanvassSeedClients: SEED_CLIENTS,
    });

    await page.goto("/neighbors", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("To visit", { exact: true }).first()).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });

    // Walk mode is back, enabled, and counting the three unanswered doors
    // (new + contacted). This is the control the first-run branch hides, so
    // its return is the other half of that decision.
    const walk = page.getByRole("button", { name: "Walk mode (3)" });
    await expect(walk).toBeVisible();
    await expect(walk).toBeEnabled();

    // The tiles sit two to a row on a phone, not five stacked — the stack is
    // what buried the page under a screenful of numbers. Geometry, not class
    // names: two tiles on one row share a top edge.
    const tops = await page.evaluate(() => {
      return ["Total", "To visit"].map((label) => {
        const el = [...document.querySelectorAll("body *")].find(
          (e) => e.textContent?.trim() === label && e.children.length === 0,
        );
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      });
    });
    expect(tops[0], "could not find the Total tile").not.toBeNull();
    expect(tops[1], "could not find the To visit tile").not.toBeNull();
    expect(
      Math.abs(tops[0]! - tops[1]!),
      `the first two tiles do not share a row (tops ${tops[0]} vs ${tops[1]}) — the funnel is stacking again`,
    ).toBeLessThan(12);

    // The entry cards fold behind the phone-only toggle once a list exists;
    // the list is what a tech opened this page for.
    await expect(page.getByRole("button", { name: /Add doors/ })).toBeVisible();
    await expect(page.getByText("Seed from an existing client")).toBeHidden();

    // And the list itself rendered its awkward fixture, not an empty state.
    await expect(page.getByText(/Grand Traverse Boulevard/).first()).toBeVisible();
  });

  test("a laptop gets the two cards side by side, not a phone column", async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await forceNeighborState(context, {
      listNeighborLeads: NO_DOORS,
      listCanvassSeedClients: SEED_CLIENTS,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/neighbors", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Seed from an existing client")).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });

    const tops = await page.evaluate(() => {
      return ["Seed from an existing client", "Add a door manually"].map((label) => {
        const el = [...document.querySelectorAll("body *")].find(
          (e) => e.textContent?.trim() === label && e.children.length === 0,
        );
        return el ? Math.round(el.getBoundingClientRect().top) : null;
      });
    });
    expect(tops[0]).not.toBeNull();
    expect(tops[1]).not.toBeNull();
    expect(
      Math.abs(tops[0]! - tops[1]!),
      "the two entry cards are stacked on a 1280px laptop",
    ).toBeLessThan(12);

    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW).toBeLessThanOrEqual(innerW);
  });
});
