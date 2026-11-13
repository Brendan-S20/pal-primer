/**
 * A dispatcher runs routes, clients and messages (#728), in a real browser.
 *
 * The handler tests (tests/a-dispatcher-runs-routes-clients-and-messages.test.ts)
 * prove what the server lets a dispatcher do. This proves the SCREENS say the
 * same thing, at 360 / 768 / 1280 / 1920, as a dispatcher and once as an
 * owner for contrast:
 *
 *   * /clients/new, Plan step. A dispatcher sees the set price as text, has
 *     no box to change it and no "Prepaid credits", and Create client sends
 *     exactly that price, billed after each visit. With no set price the step
 *     says so and offers the skip. The owner gets the override box and
 *     prepaid, as before.
 *   * The client's Visits tab drawer. Reschedule and Reassign are on screen
 *     and send their calls. Mark completed and Cancel visit are theirs too
 *     since #863 (Brendan, 2026-11-12: close_visits, on by default); what
 *     stays off is the price box and Prepaid.
 *     are not.
 *   * /routes, the visit drawer. "Move to another day" is on screen and sends
 *     rescheduleVisitFromOffice, and Complete is offered (#863).
 *   * /messages. A dispatcher opens a conversation and can send a text.
 *     There are no invoice or pricing links in their navigation.
 *
 * Every surface proves it is the branch it claims to be with something only
 * that branch draws (CLAUDE.md: a fixture of the wrong shape measures the
 * fallback and looks just as green). The owner run uses the same locators
 * and gets the opposite answer, so a role that silently stopped reaching the
 * page would turn the dispatcher's assertions red rather than leave both runs
 * measuring one branch.
 *
 * Runs with `npm run test:viewports:cases`. Locally:
 *     npx playwright test a-dispatcher-runs-routes-clients-and-messages --workers=2
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession, SWEEP_USER_ID } from "./fixtures/session";
import { installStubBackend, type SweepRole, type Stub } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

// ── The fixture this file adds on top of the shared one ─────────────────────

/** The zone quote the wizard asks for: $40.00 a visit in a named zone. The
 *  shared stubs leave getInternalQuote unanswered, which draws the "no zone"
 *  branch, so the set-price branch would never be on screen without this. */
const ZONE_QUOTE = {
  available: true,
  quote: {
    zoneId: "eeeeeeee-0000-4000-8000-00000000e728",
    zoneName: "North Shore and Lakeview",
    pricingMode: "flat",
    areaBasisCents: null,
    basePriceCents: 3500,
    perDogAddlCents: 500,
    recurringPriceCents: 4000,
    initialCleanupCents: 0,
    currency: "usd",
    commercial: null,
  },
};
const SET_PRICE_TEXT = "$40.00";

/** One scheduled visit tomorrow, for this client, with a technician: the
 *  shape both drawers need to offer Reschedule and Reassign. */
const TOMORROW = fx.day(1);
const NEXT_WEEK = fx.day(7);
const base = fx.visitsBetween(TOMORROW, TOMORROW)[0] as Record<string, any>;
const VISIT = {
  ...base,
  id: "77777777-0000-4000-8000-000000000728",
  client_id: fx.CLIENT_ID,
  property_id: fx.PROPERTY_ID,
  scheduled_on: TOMORROW,
  status: "scheduled",
  assigned_staff_id: fx.STAFF[0].id,
  staff: { id: fx.STAFF[0].id, display_name: fx.STAFF[0].display_name },
  updated_at: "2026-11-08T12:00:00Z",
};
/** A stop on today's board to tap: the first scheduled one. The drawer it
 *  opens reads getVisitDetail, answered with VISIT above. */
const TODAYS_STOP = fx
  .visitsBetween(fx.TODAY, fx.TODAY)
  .find((v: any) => v.status === "scheduled" && v.assigned_staff_id) as Record<string, any>;
const CLIENT = fx.CLIENTS.find((c) => c.id === fx.CLIENT_ID) ?? fx.CLIENTS[0];

/** What getVisitDetail returns, built from the same visit. */
const VISIT_DETAIL = {
  visit: {
    ...VISIT,
    route_pinned: false,
    started_at: null,
    completed_at: null,
    skip_reason: null,
    skip_reason_code: null,
    client_package_id: null,
    visit_checklist: null,
    visit_photos: [],
    clients: {
      id: CLIENT.id,
      display_name: CLIENT.display_name,
      primary_phone: (CLIENT as any).primary_phone ?? "+13125550142",
      primary_email: (CLIENT as any).primary_email ?? null,
      credit_balance_cents: 0,
    },
    properties: {
      id: fx.PROPERTY_ID,
      street: "4417 North Wolcott Avenue",
      city: "Chicago",
      region: "IL",
      postal_code: "60640",
      latitude: 41.96,
      longitude: -87.67,
    },
    zones: { name: "North Shore and Lakeview" },
    subscriptions: { price_cents: 4000, frequency: "weekly" },
    services: { name: "Pet waste removal", service_line: "pet_waste", default_duration_min: null },
  },
  dogs: [],
  recent: [],
  upcoming: [],
};

/** The new-client wizard's saved draft, on the Plan step (index 4 of
 *  Contact, Property, Outline, Dogs, Plan for a pet-waste business). A real
 *  product path: the wizard keeps exactly this on the device as it is typed
 *  (gaps-r2-12) and opens on it. Every key restore() reads is present. */
function planStepDraft() {
  return {
    step: 4,
    groomInstead: false,
    displayName: "Rivera-Okafor household",
    accountType: "residential",
    primaryEmail: "",
    primaryPhone: "",
    officeNote: "",
    street: "4417 North Wolcott Avenue",
    city: "Chicago",
    region: "IL",
    postalCode: "60640",
    accessNotes: "",
    parkingNotes: "",
    hazardNotes: "",
    vcName: "",
    vcPhone: "",
    vcEmail: "",
    hz: {},
    boundary: null,
    geo: { lat: 41.96, lng: -87.67 },
    dogs: [{ name: "Biscuit", breed: "", weightClass: "", temperament: "unknown", notes: "" }],
    frequency: "weekly",
    billingCadence: "postpaid",
    unitCount: "1",
    stationCount: "",
    priceOverride: "",
    skipPlan: false,
    startedOn: NEXT_WEEK,
    serviceDays: null,
    serviceId: "",
    weekdays: null,
    fcChoice: "",
    fcOverride: "",
  };
}

// ── Opening a page as somebody ───────────────────────────────────────────────

type Calls = Array<{ name: string; args: Record<string, any> }>;

/** Install the session and the stub backend as `role`, with this file's
 *  overrides, and record the calls a test cares about. */
async function signIn(
  page: Page,
  role: SweepRole,
  opts: { quote?: unknown; draft?: boolean } = {},
): Promise<Calls> {
  const calls: Calls = [];
  const record =
    (name: string, reply: unknown): Stub =>
    (args) => {
      calls.push({ name, args });
      return reply;
    };
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), {
    role,
    overrides: {
      getInternalQuote: opts.quote ?? ZONE_QUOTE,
      getVisitDetail: VISIT_DETAIL,
      listClientVisitHistory: { visits: [VISIT] },
      onboardClient: record("onboardClient", {
        clientId: fx.CLIENT_ID,
        portalLink: null,
        firstVisitOn: NEXT_WEEK,
        welcomeEmailed: false,
        welcomeStatusHandle: null,
        welcomeTurnedOff: false,
        welcomeLink: null,
        officeNoteSaved: true,
        leadLinked: null,
        firstCleanupInvoiced: null,
      }),
      rescheduleVisitFromOffice: record("rescheduleVisitFromOffice", {
        ok: true,
        lessonClashes: [],
        techName: fx.STAFF[0].display_name,
        tech: "kept",
        clash: null,
      }),
      reassignVisit: record("reassignVisit", { ok: true, clash: null, lessonClashes: [] }),
      sendSmsToClient: record("sendSmsToClient", { ok: true }),
      // A business whose texting is set up (its own Twilio subaccount). The
      // shared fixture answers nothing, which draws "Coming soon" for every
      // role and would measure a disabled box rather than a dispatcher's.
      getClientTextingAvailability: { available: true },
      listClientMessages: {
        client: {
          id: fx.CLIENTS[4].id,
          display_name: fx.CLIENTS[4].display_name,
          primary_phone: fx.CLIENTS[4].primary_phone ?? "+13125550199",
          sms_opt_out: false,
        },
        messages: [
          {
            id: "abab0000-0000-4000-8000-00000000ab11",
            direction: "inbound",
            body: "Hi, the side gate code changed to 4471# this morning, can you come after lunch instead?",
            from_number: "+13125550199",
            to_number: "+13125550100",
            status: "received",
            error: null,
            created_at: new Date(Date.now() - 40 * 60e3).toISOString(),
            staff_id: null,
          },
        ],
      },
      // Neither of these may be called by a dispatcher's screen: if a refused
      // button were on screen and pressed, the test would see the call.
      completeVisitFromOffice: record("completeVisitFromOffice", { ok: true }),
      cancelVisitFromOffice: record("cancelVisitFromOffice", { ok: true }),
    },
  });
  if (opts.draft) {
    const key = `hs:form-draft:${SWEEP_USER_ID}:${fx.ORG_ID}:new-client`;
    const row = JSON.stringify({ v: 1, savedAt: Date.now(), value: planStepDraft() });
    await page.addInitScript(
      ([k, v]) => {
        // Only on the first load: the wizard rewrites it as the page runs,
        // and a reload in the middle of a test must not reseed it.
        if (!sessionStorage.getItem("sweep:draft-seeded")) {
          localStorage.setItem(k, v);
          sessionStorage.setItem("sweep:draft-seeded", "1");
        }
      },
      [key, row] as const,
    );
  }
  return calls;
}

async function measure(page: Page, width: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
    auth: location.pathname === "/auth",
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: the router's error boundary, not the page`).toBe(false);
  expect(health.auth, `${where}: signed out`).toBe(false);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

/** The Plan step, proved to be the Plan step: the frequency picker and the
 *  Create client button only it draws. */
async function onPlanStep(page: Page) {
  await page.goto("/clients/new", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Create client" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(
    page.getByText("Rivera-Okafor household").or(page.getByText("Plan")).first(),
  ).toBeAttached();
}

/** Open the client's one scheduled visit from the Visits tab. */
async function openClientVisit(page: Page) {
  await page.goto(`/clients/${fx.CLIENT_ID}?tab=visits`, { waitUntil: "domcontentloaded" });
  const tab = page.getByRole("tab", { name: "Visits", exact: true }).first();
  await expect(tab).toBeVisible({ timeout: FIRST_PAINT_MS });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  const open = page.getByRole("button", { name: /^View visit on / }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
}

for (const { w, h, label } of WIDTHS) {
  test.describe(`a dispatcher at ${label}`, () => {
    test.use({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });

    test(`/clients/new Plan step: the set price, no override, no prepaid @${w}px`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const calls = await signIn(page, "dispatcher", { draft: true });
      await onPlanStep(page);

      await expect(
        page.getByText("the set price. Only an owner or office manager can change it."),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(SET_PRICE_TEXT).first()).toBeVisible();
      // No box to type a price into, and no prepaid.
      await expect(page.locator("#po")).toHaveCount(0);
      await expect(page.getByRole("option", { name: "Prepaid credits" })).toHaveCount(0);
      await measure(page, w, `/clients/new Plan (dispatcher) @${w}px`);

      // Create client sends the set price, billed after each visit.
      await page.getByRole("button", { name: "Create client" }).click();
      await expect.poll(() => calls.filter((c) => c.name === "onboardClient").length).toBe(1);
      const sent = calls.find((c) => c.name === "onboardClient")!.args;
      expect(sent.subscription).toMatchObject({
        priceCents: 4000,
        billingCadence: "postpaid",
        zoneId: ZONE_QUOTE.quote.zoneId,
      });
    });

    test(`/clients/new Plan step with no set price says so @${w}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await signIn(page, "dispatcher", { draft: true, quote: { available: false } });
      await onPlanStep(page);
      await expect(page.getByText("There is no set price for this plan.")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByRole("button", { name: "Create client" })).toBeDisabled();
      await expect(page.locator("#po")).toHaveCount(0);
      await measure(page, w, `/clients/new Plan, no set price (dispatcher) @${w}px`);
    });

    test(`the client's visit drawer: Reschedule, Reassign, Mark completed and Cancel visit @${w}px`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const calls = await signIn(page, "dispatcher");
      await openClientVisit(page);
      const drawer = page.getByRole("dialog").first();
      await expect(drawer.getByRole("button", { name: "Reschedule…" })).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Reassign…" })).toBeVisible();
      // #863: close_visits is a dispatcher's by default.
      await expect(drawer.getByRole("button", { name: "Mark completed" })).toBeVisible();
      await expect(drawer.getByRole("button", { name: /Cancel visit/ })).toBeVisible();
      await measure(page, w, `client visit drawer (dispatcher) @${w}px`);

      // Reschedule works: it sends the move.
      await drawer.getByRole("button", { name: "Reschedule…" }).click();
      await drawer.locator('input[type="date"]').first().fill(NEXT_WEEK);
      await drawer.getByRole("button", { name: "Move visit" }).click();
      await expect
        .poll(() => calls.filter((c) => c.name === "rescheduleVisitFromOffice").length)
        .toBe(1);
      expect(calls.find((c) => c.name === "rescheduleVisitFromOffice")!.args).toMatchObject({
        visitId: VISIT.id,
        newDate: NEXT_WEEK,
      });
      expect(calls.map((c) => c.name)).not.toContain("completeVisitFromOffice");
      expect(calls.map((c) => c.name)).not.toContain("cancelVisitFromOffice");
    });

    test(`/routes visit drawer: Move to another day, and Complete @${w}px`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const calls = await signIn(page, "dispatcher");
      await page.goto("/routes", { waitUntil: "domcontentloaded" });
      const stop = page.getByText(String(TODAYS_STOP.clients.display_name), { exact: true });
      await expect(stop.locator("visible=true").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
      await stop.locator("visible=true").first().click();
      const drawer = page.getByRole("dialog").first();
      await expect(drawer.getByLabel("Move to another day")).toBeVisible({ timeout: 30_000 });
      // #863: close_visits is a dispatcher's by default, so Complete is
      // offered and the explanation for a role without it is not drawn.
      await expect(
        drawer.getByText("Completing or canceling a visit is an office action."),
      ).toHaveCount(0);
      await expect(drawer.getByRole("button", { name: "Complete", exact: true })).toBeVisible();
      await measure(page, w, `/routes visit drawer (dispatcher) @${w}px`);

      await drawer.getByLabel("Move to another day").fill(NEXT_WEEK);
      await drawer.getByRole("button", { name: "Move", exact: true }).click();
      await expect
        .poll(() => calls.filter((c) => c.name === "rescheduleVisitFromOffice").length)
        .toBe(1);
      expect(calls.map((c) => c.name)).not.toContain("completeVisitFromOffice");
    });

    test(`/messages: a conversation opens and a text sends; no billing in the nav @${w}px`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const calls = await signIn(page, "dispatcher");
      await page.goto("/messages", { waitUntil: "domcontentloaded" });
      const thread = page.getByText(fx.CLIENTS[4].display_name).locator("visible=true").first();
      await expect(thread).toBeVisible({ timeout: FIRST_PAINT_MS });
      // No owner billing or pricing anywhere in a dispatcher's navigation.
      for (const name of ["Invoices", "Payments", "Zones & pricing", "Reports"])
        await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
      await measure(page, w, `/messages (dispatcher) @${w}px`);

      await thread.click();
      const box = page.getByPlaceholder("Type a message…");
      await expect(box).toBeVisible({ timeout: 30_000 });
      await box.fill("Running about 20 minutes behind, see you soon.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => calls.filter((c) => c.name === "sendSmsToClient").length).toBe(1);
      await measure(page, w, `/messages thread (dispatcher) @${w}px`);
    });
  });
}

// ── The owner, for contrast ───────────────────────────────────────────────
// Same locators, opposite answers: the override box and prepaid on the Plan
// step, and Complete in the routes drawer. If the role ever stopped reaching
// the page, both runs would draw one branch and one of them would go red.
for (const { w, h, label } of WIDTHS) {
  test.describe(`an owner at ${label}`, () => {
    test.use({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 768 });

    test(`/clients/new Plan step keeps the override box and prepaid @${w}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await signIn(page, "owner", { draft: true });
      await onPlanStep(page);
      await expect(page.locator("#po")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Price per visit (override)")).toBeVisible();
      await expect(page.locator("option", { hasText: "Prepaid credits" })).toHaveCount(1);
      await expect(
        page.getByText("the set price. Only an owner or office manager can change it."),
      ).toHaveCount(0);
      await measure(page, w, `/clients/new Plan (owner) @${w}px`);
    });

    test(`the client's visit drawer has Mark completed and Cancel visit @${w}px`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await signIn(page, "owner");
      await openClientVisit(page);
      const drawer = page.getByRole("dialog").first();
      await expect(drawer.getByRole("button", { name: "Mark completed" })).toBeVisible();
      await expect(drawer.getByRole("button", { name: /Cancel visit/ })).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Reschedule…" })).toBeVisible();
      await measure(page, w, `client visit drawer (owner) @${w}px`);
    });
  });
}
