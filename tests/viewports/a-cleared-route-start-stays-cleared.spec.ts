// #943, in a browser on the fixture backend.
//
// The report: Settings > Team > a person > Routing & addresses, empty the
// route start, save, see "Route endpoints saved", reload, and "the old
// address comes back". HS Product then found the "address" was the box's grey
// hint ("123 Main St, Austin, TX 78701"), not a stored value.
//
// This drives exactly those steps against a stub that REMEMBERS what was
// written, as the database does, so a reload reads back the stored row:
//
//   1. the fixture technician starts with a route start on file, and the box
//      shows it as its value;
//   2. emptying both boxes and saving sends null for the address AND the pin
//      (a stale pin would keep routing from the old start);
//   3. the toast says what was stored ("No route start: routes start from the
//      business address."), not a generic success;
//   4. after a reload both boxes are EMPTY (value ""), and what is drawn in
//      them is a hint that says what empty means, not an address.
//
// The stub cannot prove the database writes null; that is the server-function
// test in tests/what-onboarding-saves-settings-shows.test.ts. What this proves
// is the page: what it sends, what it says, and what it shows after a reload.
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type Stub } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import * as fx from "./fixtures/dataset";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

const START_HINT = "Leave blank to start from the business address";
const END_HINT = "Leave blank to end at the dump site or last stop";

// A technician the fixture gives a stored route start (dataset.ts: every
// fixture staff row has one, on West Fullerton Parkway).
const TECH = fx.STAFF.find((s) => s.display_name === "Marguerite Delacroix-Bennett")!;

type Row = (typeof fx.STAFF)[number];

async function openTeam(page: Page) {
  const rows = new Map<string, Row>(fx.STAFF.map((s) => [s.id, { ...s }]));
  const writes: Array<Record<string, unknown>> = [];
  const set: Stub = (args) => {
    writes.push(args);
    const r = rows.get(args.staffId as string)!;
    const put = (k: keyof Row, v: unknown) => {
      if (v !== undefined) (r as any)[k] = v;
    };
    put("start_address", (args.startAddress as string | null) || null);
    put("start_latitude", args.startLatitude);
    put("start_longitude", args.startLongitude);
    put("end_address", (args.endAddress as string | null) || null);
    put("end_latitude", args.endLatitude);
    put("end_longitude", args.endLongitude);
    return { ok: true, startAddress: r.start_address, endAddress: r.end_address };
  };
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), {
    overrides: {
      listStaffAddresses: () => ({ staff: [...rows.values()] }),
      setStaffAddresses: set,
    },
  });
  return { rows, writes };
}

async function openPanel(page: Page) {
  await page.goto("/settings/users", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Users & roles" }).first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  const row = page.locator("tr").filter({ hasText: TECH.display_name }).first();
  await row.getByRole("button", { name: "Routing & addresses" }).click();
  const start = page.getByPlaceholder(START_HINT);
  const end = page.getByPlaceholder(END_HINT);
  await expect(start).toBeVisible();
  return { start, end };
}

async function expectLaidOut(page: Page, label: string, touch: boolean) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label}: clipped`).toEqual([]);
  if (touch) expect(await findControlsUnder44px(page), `${label}: under 44px`).toEqual([]);
}

const SIZES = [
  ...WIDTHS,
  // The two sizes SIC shoots this screen at.
  { w: 390, h: 844, label: "390 · iPhone" },
  { w: 1440, h: 900, label: "1440 · laptop" },
] as const;

for (const { w, h, label } of SIZES) {
  const touch = w < 1280;
  test.describe(label, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: w < 768 });

    test("a cleared route start and end save as empty and stay empty after a reload", async ({
      page,
    }) => {
      const { rows, writes } = await openTeam(page);
      let { start, end } = await openPanel(page);

      // 1. A stored start is the box's VALUE, and the pin is shown under it.
      await expect(start).toHaveValue(TECH.start_address!);
      await expect(end).toHaveValue("");
      await expect(page.getByText(/^Pinned: /)).toHaveCount(1);
      await expectLaidOut(page, `${label} stored start`, touch);

      // 2. Empty both and save. The pin line goes with the address it
      //    described, before the save, not after.
      await start.fill("");
      await end.fill("");
      await expect(page.getByText(/^Pinned: /)).toHaveCount(0);
      await page.getByRole("button", { name: "Save addresses" }).click();

      // 3. The toast describes what is stored.
      await expect(
        page.getByText(
          "Saved. No route start: routes start from the business address. No route end: routes end at the dump site, or the last stop if there is none.",
        ),
      ).toBeVisible();
      expect(writes).toEqual([
        {
          staffId: TECH.id,
          startAddress: null,
          startLatitude: null,
          startLongitude: null,
          endAddress: null,
          endLatitude: null,
          endLongitude: null,
        },
      ]);
      const stored = rows.get(TECH.id)!;
      expect([stored.start_address, stored.start_latitude, stored.end_address]).toEqual([
        null,
        null,
        null,
      ]);

      // 4. Reload: both boxes are empty, and what is drawn in them is the hint.
      await page.reload({ waitUntil: "domcontentloaded" });
      ({ start, end } = await openPanel(page));
      await expect(start).toHaveValue("");
      await expect(end).toHaveValue("");
      await expect(start).toHaveAttribute("placeholder", START_HINT);
      await expect(end).toHaveAttribute("placeholder", END_HINT);
      await expect(page.getByText(/^Pinned: /)).toHaveCount(0);
      await expect(page.getByText(TECH.start_address!)).toHaveCount(0);
      await expectLaidOut(page, `${label} cleared, after reload`, touch);
    });

    // The same two fields from the dispatch board's per-person dialog, which
    // shares the hints and the toast so the two entry points cannot drift.
    test("the board's route endpoints dialog says the same", async ({ page }) => {
      const { writes } = await openTeam(page);
      await page.goto("/routes", { waitUntil: "domcontentloaded" });
      // The per-person controls live under the board's "More" menu, in "Who
      // runs routes"; proof this is the board, not /auth, is that heading.
      await expect(page.getByRole("heading", { name: "Schedule" }).first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await page.getByTestId("schedule-more").click();
      await expect(page.getByTestId("schedule-crew")).toBeVisible();
      const opener = page.getByTitle("Time off and route endpoints").first();
      await expect(opener).toBeVisible();
      await opener.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Route start and end")).toBeVisible();
      const start = dialog.getByPlaceholder(START_HINT);
      const end = dialog.getByPlaceholder(END_HINT);
      await expect(start).toBeVisible();
      await expect(end).toBeVisible();
      await expectLaidOut(page, `${label} board dialog`, touch);

      await start.fill("");
      await end.fill("");
      await dialog.getByRole("button", { name: "Save endpoints" }).click();
      await expect(
        page.getByText(/^Saved\. No route start: routes start from the business address\./),
      ).toBeVisible();
      await expect(page.getByText(/Re-optimize to update their ETAs\.$/)).toBeVisible();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        startAddress: null,
        startLatitude: null,
        startLongitude: null,
        endAddress: null,
      });
    });
  });
}
