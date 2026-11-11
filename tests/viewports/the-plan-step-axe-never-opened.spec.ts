/**
 * axe on every step of the New client wizard, Plan included (#871).
 *
 * #709 lifted the contrast of the shared pieces axe flagged, and its jsdom
 * scan (tests/axe-finds-nothing-serious-in-the-shared-pieces.test.tsx) says
 * of itself that it cannot see colour: jsdom has no layout, so axe's
 * color-contrast rule comes back "incomplete" there and a green run says
 * nothing about it. Nothing in the browser suite ran axe at all, so the Plan
 * step, the last of five and the one only reached by filling in the other
 * four, shipped three serious color-contrast nodes on a live build:
 *
 *   * "No zone matches ZIP …" in text-amber-600 on the bg-primary/5 box,
 *     #e17100 on #f3f3f4, 2.88:1 in light;
 *   * the "SUGGESTED PRICE / VISIT" label and the "Based on 1 dog · Weekly"
 *     line, text-muted-foreground on the same tinted box, 4.29:1 in light.
 *
 * muted-foreground clears 4.5:1 on white and not on a 5% tint of primary,
 * which is why a page-level check of the token never saw it.
 *
 * This walks the wizard the way the owner does, from a saved draft on
 * Contact pressing Continue through Property, Outline and Dogs to Plan, and
 * runs axe-core's color-contrast rule on each step, inside the page column
 * (the trial banner and sidebar are other pages' chrome, not the wizard's), in light and dark, at the four widths. The Plan step is
 * scanned twice: with no zone for the ZIP (the warning) and with a zone that
 * sets the price (the badge and the dollar figure).
 *
 * Each step proves it is the step it claims to be before it is scanned:
 * "nothing is wrong" passes on a blank page (CLAUDE.md).
 *
 * Runs with `npm run test:viewports:cases`. Locally:
 *     npx playwright test the-plan-step-axe-never-opened
 */
import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { installSignedInSession, SWEEP_USER_ID } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { WIDTHS } from "./rules";

const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** A zone that prices the ZIP, for the Plan step's other state. */
const ZONE_QUOTE = {
  available: true,
  quote: {
    zoneId: "eeeeeeee-0000-4000-8000-00000000e871",
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

/** The wizard's saved draft, on Contact, with every later step filled so
 *  Continue is enabled on each. The same shape the wizard writes itself. */
function contactStepDraft() {
  return {
    step: 0,
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
    startedOn: fx.day(7),
    serviceDays: null,
    serviceId: "",
    weekdays: null,
    fcChoice: "",
    fcOverride: "",
  };
}

async function openWizard(page: Page, quote: unknown, scheme: "light" | "dark") {
  await installSignedInSession(page.context());
  // The app defaults to light whatever the OS says (src/lib/theme.ts), so
  // dark is the stored preference, as the Theme card writes it.
  await page.addInitScript((s) => localStorage.setItem("scoop:theme", s), scheme);
  // `{ available: false }` is what getInternalQuote answers when no zone
  // lists the ZIP: the "No zone matches" branch the live check failed on.
  await installStubBackend(page.context(), {
    role: "owner",
    overrides: { getInternalQuote: quote },
  });
  const key = `hs:form-draft:${SWEEP_USER_ID}:${fx.ORG_ID}:new-client`;
  const row = JSON.stringify({ v: 1, savedAt: Date.now(), value: contactStepDraft() });
  await page.addInitScript(
    ([k, v]) => {
      if (!sessionStorage.getItem("sweep:draft-seeded")) {
        localStorage.setItem(k, v);
        sessionStorage.setItem("sweep:draft-seeded", "1");
      }
    },
    [key, row] as const,
  );
  await page.goto("/clients/new", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
}

type Finding = { rule: string; impact: string; target: string; summary: string };

/** axe-core's color-contrast rule over the page column as drawn, serious
 *  and critical nodes only, the bar #871 sets. Other rules are not asserted
 *  here: this sweep found two unnamed <select>s on the Plan step that are
 *  their own fix, and adding them would make this red for a reason that is
 *  not contrast. Returns every node so one failure names all of them. */
async function axeSerious(page: Page): Promise<Finding[]> {
  await page.waitForLoadState("networkidle").catch(() => {});
  // Let the step's own entry motion finish: a half-faded node is measured at
  // its in-between opacity and reports a contrast nobody ever sees.
  await page.waitForTimeout(400);
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: typeof import("axe-core") }).axe;
    const column = document.querySelector("[data-page-shell]");
    if (!column) throw new Error("no page column to scan");
    const r = await axe.run(column, {
      runOnly: { type: "rule", values: ["color-contrast"] },
      resultTypes: ["violations"],
    });
    const out: Finding[] = [];
    for (const v of r.violations)
      for (const n of v.nodes)
        if (n.impact === "serious" || n.impact === "critical")
          out.push({
            rule: v.id,
            impact: n.impact,
            target: n.target.join(" "),
            summary: n.failureSummary ?? "",
          });
    return out;
  });
}

const STEPS: Array<{ name: string; proof: (p: Page) => ReturnType<Page["getByText"]> }> = [
  { name: "Contact", proof: (p) => p.locator("input[value='Rivera-Okafor household']") },
  { name: "Property", proof: (p) => p.locator("input[value='4417 North Wolcott Avenue']") },
  { name: "Outline", proof: (p) => p.getByRole("button", { name: "Continue" }) },
  { name: "Dogs", proof: (p) => p.locator("input[value='Biscuit']") },
  { name: "Plan", proof: (p) => p.getByRole("button", { name: "Create client" }) },
];

for (const scheme of ["light", "dark"] as const) {
  for (const { w, h, label } of WIDTHS) {
    test.describe(`New client wizard, ${scheme}, at ${label}`, () => {
      test.use({
        viewport: { width: w, height: h },
        isMobile: w < 768,
        hasTouch: w < 768,
        colorScheme: scheme,
      });

      test(`every step, Plan with no zone for the ZIP, has no serious axe node @${w}px ${scheme}`, async ({
        page,
      }) => {
        test.setTimeout(240_000);
        await openWizard(page, { available: false }, scheme);
        expect(
          await page.evaluate(() => document.documentElement.classList.contains("dark")),
          "the theme this run claims",
        ).toBe(scheme === "dark");
        for (const [i, step] of STEPS.entries()) {
          if (i > 0) await page.getByRole("button", { name: "Continue" }).click();
          await expect(step.proof(page).first(), `${step.name} step`).toBeVisible({
            timeout: 30_000,
          });
          if (step.name === "Plan")
            await expect(page.getByText("No zone matches ZIP 60640.")).toBeVisible({
              timeout: 30_000,
            });
          expect(await axeSerious(page), `${step.name} @${w}px ${scheme}`).toEqual([]);
        }
      });

      test(`Plan with a zone that sets the price has no serious axe node @${w}px ${scheme}`, async ({
        page,
      }) => {
        test.setTimeout(240_000);
        await openWizard(page, ZONE_QUOTE, scheme);
        for (let i = 1; i < STEPS.length; i++)
          await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("button", { name: "Create client" })).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByText("Zone: North Shore and Lakeview")).toBeVisible({
          timeout: 30_000,
        });
        expect(await axeSerious(page), `Plan (zone) @${w}px ${scheme}`).toEqual([]);
      });
    });
  }
}
