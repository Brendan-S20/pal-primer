/**
 * The five surfaces Product's review of #564 asked to see, in a real browser.
 *
 * #564 (#560) stopped a walk, a sit, a groom and a lesson reading as a
 * pet-waste add-on. The unit tests pin the words; nobody had looked at the
 * pages. None of these is a resting state any sweep opens:
 *
 *   - The portal's Report dialog on a completed SIT: the visit issues
 *     (VISIT_CONCERN_OPTIONS), not "Missed spot" / "Wrong yard serviced",
 *     and no re-clean offer even inside the guarantee window. The row under
 *     it is a pet-waste visit, the control: it keeps the yard list.
 *   - The booking page's eyebrow for a business that lists a walk and a sit:
 *     "Dog walking and pet sitting" above the headline.
 *   - My Day for a tech in a business that runs pet waste AND walking: the
 *     walk stop draws the neutral hazard words and no stations or DNA, the
 *     pet-waste stop beside it (the control) draws the yard words and both.
 *   - The on-my-way email for a sit, and the visit-completed email for a
 *     groom: no dog out in the yard, no dirty work.
 *
 * Each state is proved on screen by its own words before anything is
 * measured, and the yard words are asserted ABSENT where they must not be,
 * so a fixture that silently fell back to pet waste goes red rather than
 * green. A screenshot of each, at 360 and 1280, lands in docs/evidence/564/
 * when SHOTS=1.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import * as React from "react";
import { render } from "react-email";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, PORTAL_STUBS, installStubBackend } from "./fixtures/stub-backend";
import {
  PORTAL_CLIENT,
  PORTAL_CLIENT_NAME,
  PORTAL_ORG_NAME,
  PORTAL_RECENT_VISITS,
  PORTAL_SLUG,
  PORTAL_TOKEN,
  SIGNUP_FORM,
} from "./fixtures/portal-dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 768, 1280, 1920];
const SHOTS = join(process.cwd(), "docs/evidence/564");

async function measure(page: Page, label: string, width: number) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label} @${width}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label} @${width}: clipped`).toEqual([]);
  expect(
    await findControlsNarrowerThanTheirLabel(page),
    `${label} @${width}: a button narrower than its label`,
  ).toEqual([]);
  if (width < 768) {
    expect(await findControlsUnder44px(page), `${label} @${width}: under 44px`).toEqual([]);
  }
  await shot(page, label, width);
}

/** Full page, except with a dropdown open: the resize a full-page capture
 *  makes closes a Radix Select. Every width is measured; 360 and 1280 are
 *  the two kept, as #562 kept them. */
const SHOT_WIDTHS = [360, 1280];
async function shot(page: Page, label: string, width: number, fullPage = true) {
  if (!process.env.SHOTS || !SHOT_WIDTHS.includes(width)) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${label}-${width}.png`), fullPage });
}

// ── The portal ───────────────────────────────────────────────────────────

/** The first row is a SIT completed six hours ago: inside the 48-hour
 *  re-clean window, so a yard visit there would draw "Request a re-clean".
 *  The second is the fixture's own pet-waste visit, as it always was. */
const SIT_HISTORY = PORTAL_RECENT_VISITS.map((r, i) =>
  i === 0 ? { ...r, service_line: "pet_sitting" } : { ...r, service_line: "pet_waste" },
);

// ── The booking page ─────────────────────────────────────────────────────

const WALK_AND_SIT_SERVICES = [
  {
    id: "55555555-0000-4000-8000-000000005601",
    name: "30-minute walk",
    service_line: "dog_walking",
    price_unit: "visit",
    base_price_cents: 3000,
    extra_pet_cents: 500,
    default_duration_min: 30,
  },
  {
    id: "55555555-0000-4000-8000-000000005602",
    name: "Drop-in visit (30 min)",
    service_line: "pet_sitting",
    price_unit: "visit",
    base_price_cents: 2800,
    extra_pet_cents: 0,
    default_duration_min: 30,
  },
];

// ── My Day ───────────────────────────────────────────────────────────────

const WALK_CLIENT = "Margarethe Oyelaran-Castellanos";
const YARD_CLIENT = "Bo Ng";

/** Two stops on one property shape, both under way: a commercial building
 *  with units and stations, a DNA-enrolled client, and the critical yard
 *  hazards on file. The only difference is the service's line. */
function mixedDay() {
  const day = (BASE_STUBS.getMyDay as () => { visits: any[]; [k: string]: unknown })();
  const [a, b] = day.visits;
  const startedAt = new Date(Date.now() - 22 * 60_000).toISOString();
  const shape = (v: any, name: string, services: Record<string, unknown>, seq: number) => ({
    ...v,
    status: "in_progress",
    started_at: startedAt,
    sequence: seq,
    services,
    clients: { ...v.clients, display_name: name, dna_compliance_enabled: true },
    properties: {
      ...b.properties,
      account_type: "commercial",
      has_units: true,
      escape_risk: true,
      aggressive_dog: true,
      do_not_enter_if_dog_out: true,
      dog_in_yard_during_service: true,
    },
  });
  return {
    ...day,
    visits: [
      shape(
        a,
        WALK_CLIENT,
        { name: "30-minute walk", service_line: "dog_walking", default_duration_min: 30 },
        1,
      ),
      shape(
        b,
        YARD_CLIENT,
        { name: "Weekly cleanup", service_line: "pet_waste", default_duration_min: 20 },
        2,
      ),
    ],
  };
}

/** A stop's card: My Day draws each as <li id="visit-{id}">. */
function card(page: Page, visitId: string): Locator {
  return page.locator(`li[id="visit-${visitId}"]`);
}

// ── The emails ───────────────────────────────────────────────────────────

/** The props the server builds: sendOnMyWay for a pet_sitting visit adds
 *  `yard: false`; completeVisit for a mobile_grooming visit adds
 *  `petWaste: false`. The checklist is left empty on purpose: it is the
 *  org's one list for every line, which is #565, not this PR. */
const SIT_ON_MY_WAY = {
  orgName: PORTAL_ORG_NAME,
  clientName: "Priya",
  techName: "Alejandro",
  eta: "between 10:15 AM and 10:45 AM",
  address: "4417 N Sacramento Ave, Chicago",
  trackUrl: "https://app.houndstack.com/t/example",
  yard: false,
  // Since #713 "reply to this email" is said only when a reply-to exists, and
  // that is the wording this case was written for. Without one the line names
  // the business (the next test, and tests/a-reply-that-reaches-nobody.test.tsx).
  orgEmail: "office@example.test",
};
const GROOM_COMPLETED = {
  orgName: PORTAL_ORG_NAME,
  clientName: "Priya",
  visitDate: "Oct 28, 2026",
  address: "4417 N Sacramento Ave, Chicago",
  photoUrls: [],
  checklist: [],
  petWaste: false,
};

/** A template, as the server renders it. Not imported: Playwright compiles a
 *  spec's JSX into its own component-testing objects, which React then
 *  refuses to render, so the template is bundled with esbuild (real React,
 *  tsconfig paths) and loaded from node_modules/.cache, where its bare
 *  imports resolve. */
async function loadTemplate(file: string) {
  const { build } = await import("esbuild");
  const outfile = join(process.cwd(), "node_modules/.cache/five-surfaces-564", `${file}.mjs`);
  await build({
    entryPoints: [join(process.cwd(), "src/lib/email-templates", `${file}.tsx`)],
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    packages: "external",
    outfile,
    logLevel: "silent",
  });
  return (await import(pathToFileURL(outfile).href)).template as {
    component: React.ComponentType<any>;
    subject: (d: Record<string, any>) => string;
  };
}

async function showEmail(page: Page, html: string, subject: string) {
  // The subject line as a mail client draws it above the body, so the
  // capture shows both halves of what the customer reads.
  const head = `<div style="font:600 15px system-ui;padding:12px 16px;border-bottom:1px solid #ddd" data-subject>Subject: ${subject}</div>`;
  // A phone's mail app lays the message out at the screen's width; without
  // the meta a mobile browser would lay it out at 980px and zoom out.
  const meta = `<meta name="viewport" content="width=device-width, initial-scale=1">`;
  await page.setContent(
    html.replace(/<head([^>]*)>/i, `<head$1>${meta}`).replace(/<body([^>]*)>/i, `<body$1>${head}`),
  );
}

for (const width of WIDTHS) {
  test.describe(`#564 surfaces at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 2 });

    test("portal: Report on a completed sit offers visit issues, no re-clean", async ({ page }) => {
      // portalContext hands the first paint its own copy of the history, so
      // the override goes in both places or the page draws the fixture's.
      const client = { ...PORTAL_CLIENT, pet_waste: true };
      const baseContext = PORTAL_STUBS.portalContext as (a: Record<string, any>) => any;
      await installStubBackend(page, {
        portal: true,
        overrides: {
          portalListRecentVisits: SIT_HISTORY,
          portalGetClient: client,
          portalContext: (args) => {
            const ctx = baseContext(args);
            return ctx.home ? { ...ctx, home: { ...ctx.home, client, history: SIT_HISTORY } } : ctx;
          },
        },
      });
      await page.goto(`/portal/${PORTAL_SLUG}/${PORTAL_TOKEN}/visits`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.getByText(PORTAL_CLIENT_NAME).first()).toBeVisible({ timeout: 30_000 });
      const reports = page.getByRole("button", { name: "Report", exact: true });
      await expect(reports.first()).toBeVisible({ timeout: 15_000 });
      // The sit is first and inside the window; only a yard visit would offer
      // a re-clean, and the yard rows below it are weeks old.
      await expect(page.getByText(/Request a re-clean/i)).toHaveCount(0);
      await page.waitForTimeout(400);
      await shot(page, "portal-sit-history", width);

      await reports.first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Report a concern")).toBeVisible();
      await expect(dialog.getByPlaceholder("Tell us what happened")).toBeVisible();
      await dialog.getByRole("combobox").click();
      const listbox = page.getByRole("listbox");
      await expect(
        listbox.getByRole("option", { name: "The visit was shorter than booked" }),
      ).toBeVisible();
      await expect(
        listbox.getByRole("option", { name: "A door, gate or key was left unsecured" }),
      ).toBeVisible();
      await expect(listbox.getByRole("option", { name: "Missed spot" })).toHaveCount(0);
      await expect(listbox.getByRole("option", { name: "Wrong yard serviced" })).toHaveCount(0);
      await page.waitForTimeout(300);
      await shot(page, "portal-sit-concern-options", width, false);
      await listbox.getByRole("option", { name: "The visit was shorter than booked" }).click();
      await expect(listbox).toHaveCount(0);
      // The dialog's open animation scales it; measure it at rest.
      await page.waitForTimeout(500);
      await measure(page, "portal-sit-concern-dialog", width);

      // The control: the pet-waste row's Report still offers the yard list.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
      await reports.nth(1).click();
      await expect(page.getByPlaceholder("Tell us what to look for or fix")).toBeVisible();
      await page.getByRole("dialog").getByRole("combobox").click();
      await expect(page.getByRole("option", { name: "Missed spot" })).toBeVisible();
      await shot(page, "portal-yard-concern-options-control", width, false);
    });

    test("booking page: the eyebrow names a walk and a sit", async ({ page }) => {
      await installStubBackend(page, {
        portal: true,
        overrides: {
          getPublicSignupForm: {
            ...SIGNUP_FORM,
            firstCleanup: { mode: "off", tiers: [] },
            services: WALK_AND_SIT_SERVICES,
            lines: ["dog_walking", "pet_sitting"],
          },
        },
      });
      await page.goto(`/signup/${PORTAL_SLUG}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(PORTAL_ORG_NAME).first()).toBeVisible({ timeout: 30_000 });
      const eyebrow = page.locator("[data-booking-services]");
      await expect(eyebrow).toHaveText("Dog walking and pet sitting", { timeout: 15_000 });
      await expect(page.getByText("When was your yard last cleaned?")).toHaveCount(0);
      await page.waitForTimeout(400);
      await measure(page, "booking-eyebrow-walk-and-sit", width);
    });

    test("My Day, mixed business: the walk stop has no yard framing", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, {
        role: "tech",
        serviceLines: ["pet_waste", "dog_walking"],
        overrides: { getMyDay: mixedDay },
      });
      await page.goto("/my-day", { waitUntil: "domcontentloaded" });
      await expect(page.getByText(WALK_CLIENT).first()).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText(YARD_CLIENT).first()).toBeVisible();

      const [walkVisit, yardVisit] = mixedDay().visits;
      const walk = card(page, walkVisit.id);
      const yard = card(page, yardVisit.id);
      await expect(walk.getByText(WALK_CLIENT).first()).toBeVisible();
      await expect(yard.getByText(YARD_CLIENT).first()).toBeVisible();

      // The control first: the same property, on a pet-waste stop, still
      // draws every yard word, the stations and the DNA button. If the
      // fixture stopped reaching the card, this is what goes red.
      await expect(yard.getByText("Escape risk: close gate immediately")).toBeVisible();
      await expect(yard.getByText("DO NOT ENTER if a pet is loose")).toBeVisible();
      await expect(yard.getByRole("button", { name: "Stations", exact: true })).toBeVisible();
      await expect(yard.getByRole("button", { name: "DNA sample" })).toBeVisible();

      // The walk: neutral words, nothing to count, nothing to swab.
      await expect(walk.getByText("Escape risk: secure all exits")).toBeVisible();
      await expect(walk.getByText("Do not approach an unsecured pet")).toBeVisible();
      await expect(walk.getByText("Pet may be loose at arrival")).toBeVisible();
      await expect(walk.getByText("Escape risk: close gate immediately")).toHaveCount(0);
      await expect(walk.getByText("Loose pet during service")).toHaveCount(0);
      await expect(walk.getByText(/waste station/i)).toHaveCount(0);
      await expect(walk.getByRole("button", { name: "Stations", exact: true })).toHaveCount(0);
      await expect(walk.getByRole("button", { name: "DNA sample" })).toHaveCount(0);
      await page.waitForTimeout(400);
      await measure(page, "my-day-mixed-walker", width);
      if (process.env.SHOTS && SHOT_WIDTHS.includes(width)) {
        await walk.scrollIntoViewIfNeeded();
        await walk.screenshot({ path: join(SHOTS, `my-day-mixed-walk-card-${width}.png`) });
        await yard.scrollIntoViewIfNeeded();
        await yard.screenshot({
          path: join(SHOTS, `my-day-mixed-yard-card-control-${width}.png`),
        });
      }
    });

    test("on-my-way email for a sit: no dog out in the yard", async ({ page }) => {
      const onMyWay = await loadTemplate("on-my-way");
      const html = await render(React.createElement(onMyWay.component, SIT_ON_MY_WAY));
      await showEmail(page, html, onMyWay.subject(SIT_ON_MY_WAY));
      await expect(page.getByRole("heading", { name: "On the way" })).toBeVisible();
      await expect(
        page.getByText(
          "If anything has changed, or there is anything we should know, reply to this email.",
        ),
      ).toBeVisible();
      await expect(page.getByText(/out in the yard/)).toHaveCount(0);
      await measure(page, "email-on-my-way-sit", width);
    });

    test("on-my-way email with no contact email: no reply promised", async ({ page }) => {
      const onMyWay = await loadTemplate("on-my-way");
      const noContact = { ...SIT_ON_MY_WAY, orgEmail: undefined };
      const html = await render(React.createElement(onMyWay.component, noContact));
      await showEmail(page, html, onMyWay.subject(noContact));
      await expect(page.getByRole("heading", { name: "On the way" })).toBeVisible();
      await expect(
        page.getByText(
          `If anything has changed, or there is anything we should know, contact ${PORTAL_ORG_NAME}.`,
        ),
      ).toBeVisible();
      await expect(page.getByText(/reply to this email/)).toHaveCount(0);
      await measure(page, "email-on-my-way-sit-no-contact", width);
    });

    test("visit-completed email for a groom: no dirty work", async ({ page }) => {
      const visitCompleted = await loadTemplate("visit-completed");
      const html = await render(React.createElement(visitCompleted.component, GROOM_COMPLETED));
      await showEmail(page, html, visitCompleted.subject(GROOM_COMPLETED));
      await expect(page.getByRole("heading", { name: "Visit complete" })).toBeVisible();
      await expect(page.getByText("Thanks for trusting us with your pets.")).toBeVisible();
      await expect(page.getByText(/dirty work/)).toHaveCount(0);
      await expect(page.getByText(/clean/i)).toHaveCount(0);
      await measure(page, "email-visit-completed-groom", width);
    });
  });
}
