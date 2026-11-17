import { test, expect, type Page } from "@playwright/test";
import {
  findControlsOffTheSide,
  findControlsUnder44px,
  findSilentlyClippedText,
  measurePageOverflow,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, SERVICE_AREA_PART, installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import * as fx from "./fixtures/dataset";
import { walksPricedForSetup } from "../../src/lib/setup-walk-prices";

/**
 * #769, the walker-only path, end to end on the fixture backend.
 *
 * Product's live check of 2026-11-11 passed the business that scoops AND
 * walks; no walker-only business exists in production to check. This drives
 * one through /setup in a browser, with a stub that REMEMBERS what was
 * written, so the screens after setup read back what setup saved rather
 * than a fixed answer:
 *
 *   step 1    "Your workday" is shown, prefilled with what is stored (the
 *             column's 08:00-17:00 for a new business), and Save writes the
 *             hours the owner confirmed or typed with the address. Settings,
 *             Scheduling then shows those hours. (Acceptance 2.)
 *   step 2    the 30- and 60-minute walks are priced in place, the drop-in
 *             optional; one walk alone is refused; the area and both walks
 *             saved and the step is done, still on /setup. (Acceptance 1, 4.)
 *   after     Settings, Services lists the same prices, and the new-client
 *             Plan quotes the 30-minute walk from its price with no "has no
 *             price yet". (Acceptance 3.)
 *
 * The step's done-ness is the REAL rule (walksPricedForSetup) applied to the
 * services the stub holds, so a save that wrote the wrong walk would leave
 * the step open here as it would on the server.
 *
 * 390x844 and 1440x900: the sizes the PR's screenshots are taken at. Made-up
 * data only. Run with `npm run test:viewports:walker-setup`.
 */

const SIZES = [
  { w: 390, h: 844 },
  { w: 1440, h: 900 },
] as const;

const ADDRESS = "4413 North Ravenswood Manor Terrace, Chicago, IL 60611";
const id = (n: string) => `aaaaaaaa-0000-4000-8000-00000000${n}`;
const WALK_30 = id("c769");
const WALK_60 = id("c770");
const DROP_IN = id("c771");

type Walk = Record<string, any> & {
  id: string;
  default_duration_min: number | null;
  base_price_cents: number | null;
};

/** A walker-only business as signup leaves it: no address, the column's
 *  hours, signup's three walks unpriced (beside the dataset's long-named,
 *  priced walk, so the screens are not measured on a tidy list), no zone. */
function newWalker() {
  const walk = (wid: string, name: string, min: number): Walk => ({
    id: wid,
    organization_id: fx.ORG_ID,
    name,
    service_line: "dog_walking",
    price_unit: "visit",
    base_price_cents: null,
    extra_pet_cents: 0,
    default_duration_min: min,
    holiday_surcharge_pct: 0,
    active: true,
    created_at: "2026-11-17T12:00:00Z",
    updated_at: "2026-11-17T12:00:00Z",
  });
  const datasetWalks = ((BASE_STUBS.listServices as { services: Walk[] }).services ?? []).filter(
    (s) => s.service_line === "dog_walking",
  );
  return {
    address: null as string | null,
    // As Postgres returns a time: the column default, never shown before #769.
    dispatch: {
      ...((BASE_STUBS.getDispatchSettings as { settings: Record<string, any> }).settings ?? {}),
      workday_start: "08:00:00",
      workday_end: "17:00:00",
    } as Record<string, any>,
    dispatchWrites: [] as Record<string, any>[],
    zoneSaved: false,
    walks: [
      ...datasetWalks,
      walk(WALK_30, "30-minute walk", 30),
      walk(WALK_60, "60-minute walk", 60),
      walk(DROP_IN, "Drop-in visit (20 min)", 20),
    ],
    priceWrites: [] as Array<Array<{ id: string; cents: number | null }>>,
  };
}
type World = ReturnType<typeof newWalker>;

const dataOf = (a: Record<string, any>) => (a && "data" in a ? a.data : a) ?? {};

/** The server's answer, worked out from what the world holds now. */
function onboardingOf(world: World) {
  const signupWalks = world.walks.filter((w) => [WALK_30, WALK_60, DROP_IN].includes(w.id));
  const walksDone = walksPricedForSetup(signupWalks);
  const areaDone = world.zoneSaved;
  const steps = ["business", "zones", "clients", "staff", "dump_site", "payouts"].map((sid) => {
    if (sid === "business")
      return {
        id: sid,
        label: "Your business details",
        description:
          "Your business address and time zone. Routes start from the address, and the time zone decides what counts as today.",
        done: Boolean(world.address),
        to: "/setup",
        cta: "Add details",
        gate: "/settings/business",
      };
    if (sid === "zones")
      return {
        id: sid,
        label: "Price your walks",
        description:
          "Set what a 30-minute walk and a 60-minute walk cost, and a drop-in if you offer one. New clients are quoted these prices. Clients book inside the service area you set here.",
        done: areaDone && walksDone,
        to: "/setup",
        cta: "Price walks",
        gate: "/settings/services",
        parts: [
          { ...SERVICE_AREA_PART, done: areaDone },
          {
            id: "walks",
            label: "Walks",
            description: "What a 30-minute walk and a 60-minute walk cost.",
            done: walksDone,
            to: "/settings/services",
            cta: "Price walks",
          },
        ],
      };
    return {
      id: sid,
      label: sid === "dump_site" ? "Where does your day end?" : `Step ${sid}`,
      description: "",
      done: false,
      to: "/setup",
      cta: "Open",
      gate: sid === "payouts" ? "/payments" : sid === "clients" ? "/clients" : "/settings/users",
    };
  });
  return {
    steps,
    completed: steps.filter((s) => s.done).length,
    total: steps.length,
    dismissed: false,
    emailVerified: true,
  };
}

async function open(page: Page, world: World, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await installSignedInSession(page.context());
  const branding = BASE_STUBS.getOrgBranding as Record<string, any>;
  const report = await installStubBackend(page.context(), {
    role: "owner",
    serviceLines: ["dog_walking"],
    overrides: {
      getOrgBranding: () => ({
        ...branding,
        contact_address: world.address,
        latitude: world.address ? branding.latitude : null,
        longitude: world.address ? branding.longitude : null,
      }),
      updateOrgBranding: (a) => {
        const d = dataOf(a);
        if (d.contactAddress !== undefined) world.address = d.contactAddress;
        return { ok: true };
      },
      getDispatchSettings: () => ({ settings: { ...world.dispatch } }),
      updateDispatchSettings: (a) => {
        const d = dataOf(a);
        world.dispatchWrites.push(d);
        Object.assign(world.dispatch, d);
        return { ok: true };
      },
      getOnboardingStatus: () => onboardingOf(world),
      listServices: () => ({ services: world.walks.map((s) => ({ ...s })) }),
      setSetupWalkPrices: (a) => {
        const prices = dataOf(a).prices as Array<{ id: string; cents: number | null }>;
        world.priceWrites.push(prices);
        for (const p of prices) {
          const walk = world.walks.find((s) => s.id === p.id);
          if (walk) walk.base_price_cents = p.cents;
        }
        return { ok: true };
      },
      createZone: () => {
        world.zoneSaved = true;
        return { id: id("e769") };
      },
    },
  });
  return report;
}

async function measure(page: Page, width: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: the error boundary, not the page`).toBe(false);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

async function openStep1(page: Page) {
  await page.goto("/setup?step=business", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-setup-step="business"]')).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  // The walker-only branch, not the pet-waste default: walking is ticked.
  await expect(page.getByRole("checkbox", { name: /^Dog walking/ })).toBeChecked({
    timeout: FIRST_PAINT_MS,
  });
  const save = page.locator('[data-setup-action="save"]');
  await expect(save).toHaveText("Save and continue", { timeout: FIRST_PAINT_MS });
  return save;
}

const fieldset = (page: Page) => page.locator("fieldset[data-setup-workday]");

for (const { w, h } of SIZES) {
  test(`#769 a walker-only owner is shown the 08:00-17:00 workday, and confirming it writes it @${w}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const world = newWalker();
    await open(page, world, w, h);
    const save = await openStep1(page);

    const hours = fieldset(page);
    await expect(hours.getByText("Your workday", { exact: true })).toBeVisible();
    await expect(hours.getByLabel("Starts")).toHaveValue("08:00");
    await expect(hours.getByLabel("Ends")).toHaveValue("17:00");
    await expect(hours.getByText(/change this later in Settings, Scheduling/)).toBeVisible();
    await measure(page, w, `/setup step 1 workday (walker only) @${w}px`);

    // Saved untouched, the hours are still WRITTEN: the owner saw 08:00-17:00
    // and kept it, so it is an answer, not the column default left alone.
    await page.locator("#setup-address").fill(ADDRESS);
    await save.click();
    await expect(page.locator('[data-setup-step="zones"]')).toBeVisible({ timeout: 15_000 });
    expect(world.dispatchWrites.at(-1)).toMatchObject({
      workday_start: "08:00",
      workday_end: "17:00",
    });
    expect(world.address).toBe(ADDRESS);
  });

  test(`#769 a walker-only owner changes the workday on /setup, and Settings, Scheduling shows it @${w}px`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const world = newWalker();
    await open(page, world, w, h);
    const save = await openStep1(page);
    const hours = fieldset(page);
    await expect(hours.getByLabel("Starts")).toHaveValue("08:00");

    // A day that ends before it starts is refused, said beside the form,
    // and nothing is written.
    await page.locator("#setup-address").fill(ADDRESS);
    await hours.getByLabel("Starts").fill("15:00");
    await hours.getByLabel("Ends").fill("09:00");
    await save.click();
    await expect(page.locator("[data-setup-error]")).toHaveText(
      "Your workday has to end after it starts.",
    );
    await expect(page.locator('[data-setup-step="business"]')).toBeVisible();
    expect(world.dispatchWrites).toEqual([]);
    await measure(page, w, `/setup step 1 workday refused (walker only) @${w}px`);

    await hours.getByLabel("Starts").fill("07:00");
    await hours.getByLabel("Ends").fill("15:30");
    await save.click();
    await expect(page.locator('[data-setup-step="zones"]')).toBeVisible({ timeout: 15_000 });
    expect(world.dispatchWrites.at(-1)).toMatchObject({
      workday_start: "07:00",
      workday_end: "15:30",
    });

    // Where Settings stores and reads them.
    await page.goto("/settings/scheduling", { waitUntil: "domcontentloaded" });
    await expect(page.locator("#sched-workday-start")).toHaveValue("07:00", {
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.locator("#sched-workday-end")).toHaveValue("15:30");
  });

  test(`#769 a walker-only owner prices both walks on /setup, and Settings and the Plan step read them @${w}px`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const world = newWalker();
    world.address = ADDRESS;
    await open(page, world, w, h);
    await page.goto("/setup?step=zones", { waitUntil: "domcontentloaded" });
    const step = page.locator('[data-setup-step="zones"]');
    await expect(step).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByRole("heading", { name: "Price your walks" })).toBeVisible();

    // The walks, in place: no button off to Settings to price them.
    const form = page.locator('[data-setup-price-form="walks"] form[data-setup-walk-prices]');
    const walk30 = form.getByLabel(/^30-minute walk \(\$\)$/);
    const walk60 = form.getByLabel(/^60-minute walk \(\$\)$/);
    const dropIn = form.getByLabel(/^Drop-in visit \(20 min\) \(\$\), optional$/);
    await expect(walk30).toBeVisible({ timeout: 15_000 });
    await expect(walk30).toHaveAttribute("required", "");
    await expect(walk60).toHaveAttribute("required", "");
    await expect(dropIn).not.toHaveAttribute("required", "");
    await expect(page.getByRole("link", { name: "Price walks" })).toHaveCount(0);
    await measure(page, w, `/setup walk prices (walker only) @${w}px`);

    // The area first, as /setup draws it (#958).
    const area = page.locator('[data-setup-price-form="area"]');
    await area.locator('[data-setup-action="save-area"]').click();
    await expect(page.getByText("Service area saved").first()).toBeVisible({ timeout: 15_000 });
    await expect(area.locator("[data-setup-service-area-done]")).toBeVisible({
      timeout: 15_000,
    });

    // One walk alone is refused by the form: nothing is sent, the step stays.
    const save = form.locator('[data-setup-action="save-walks"]');
    await walk30.fill("25");
    await save.click();
    await expect(walk60).toHaveJSProperty("validity.valueMissing", true);
    expect(world.priceWrites).toEqual([]);
    await expect(step).toBeVisible();

    // Both, the drop-in left blank: written, and the step is done on /setup.
    await walk60.fill("40");
    await save.click();
    await expect(page.getByText("Walk prices saved").first()).toBeVisible({ timeout: 15_000 });
    // One write, the required walks first. The form sends every active walk
    // it draws, so the dataset's other walk goes too, at the price it had.
    expect(world.priceWrites).toHaveLength(1);
    expect(world.priceWrites[0].slice(0, 3)).toEqual([
      { id: WALK_30, cents: 2500 },
      { id: WALK_60, cents: 4000 },
      { id: DROP_IN, cents: null },
    ]);
    for (const p of world.priceWrites[0].slice(3)) {
      expect(p.cents, "a walk setup did not ask about keeps its price").toBe(
        (BASE_STUBS.listServices as { services: Walk[] }).services.find((s) => s.id === p.id)
          ?.base_price_cents,
      );
    }
    expect(onboardingOf(world).steps.find((s) => s.id === "zones")?.done).toBe(true);
    await expect(page.locator('[data-setup-step="clients"]')).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe("/setup");

    // Settings, Services: the same prices, read from the same rows.
    await page.goto("/settings/services", { waitUntil: "domcontentloaded" });
    const list = page.getByTestId("services-list");
    await expect(list).toBeVisible({ timeout: FIRST_PAINT_MS });
    const row = (name: string) =>
      list.locator("li").filter({ has: page.getByText(name, { exact: true }) });
    await expect(row("30-minute walk")).toContainText("$25.00 per visit");
    await expect(row("60-minute walk")).toContainText("$40.00 per visit");
    // The drop-in was left blank on purpose, and says so.
    await expect(row("Drop-in visit (20 min)")).toContainText("No price yet");
    await expect(list.getByText("Coming soon")).toHaveCount(0);
    await measure(page, w, `/settings/services after setup (walker only) @${w}px`);

    // The new-client Plan step quotes the walk from the price setup saved.
    await page.goto("/clients/new", { waitUntil: "domcontentloaded" });
    const allText = () => page.evaluate(() => document.body.textContent ?? "");
    await expect.poll(allText, { timeout: FIRST_PAINT_MS }).toContain("Step 1 of");
    const next = page.getByRole("button", { name: "Continue", exact: true });
    await page.locator("#dn").fill("Rex QA");
    await next.click();
    await expect.poll(allText).toContain("Step 2 of");
    await page.locator("#st").fill("4417 North Wolcott Avenue");
    await page.locator("#ci").fill("Chicago");
    await page.locator("#rg").fill("IL");
    await page.locator("#pc").fill("60640");
    const create = page.getByRole("button", { name: "Create client" });
    for (let i = 0; i < 4 && !(await create.isVisible()); i++) {
      const dog = page.getByPlaceholder("e.g. Bailey").first();
      if (await dog.isVisible()) await dog.fill("Rex");
      await next.click();
      await page.waitForTimeout(300);
    }
    await expect(create).toBeVisible();
    const service = page.locator("#nc-service");
    const walkValue = await service
      .locator("option", { hasText: /^30-minute walk/ })
      .first()
      .getAttribute("value");
    await service.selectOption(walkValue!);
    await expect(page.getByText("From the 30-minute walk price")).toBeVisible();
    await expect(page.getByText("$25.00").first()).toBeVisible();
    await expect(page.getByText(/30-minute walk has no price yet/)).toHaveCount(0);
    await measure(page, w, `/clients/new Plan, 30-minute walk (walker only) @${w}px`);
  });
}
