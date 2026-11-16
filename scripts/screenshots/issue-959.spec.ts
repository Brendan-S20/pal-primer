// #959 PR evidence: /setup's price step at a sitter, a groomer, a trainer and
// a business that does all three, before and after, at 390 and 1440.
//
// Stub backend only (tests/viewports/fixtures), made-up data: no hosted
// database, nothing written. PHASE=before is run against origin/main's src,
// PHASE=after at the PR head. Before, the server described each of these as
// a link to Settings, Services; that shape is restored here for the before
// run, so main draws what it drew for a real business.
//
// Full-page shots, so the whole form is in one picture. A full-page capture
// paints the sticky Back/Next bar where the FIRST screen ended, not at the
// bottom: that is the capture, not the layout.
//
//   PHASE=after npx playwright test -c scripts/screenshots/issue-959.config.ts
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { installSignedInSession } from "../../tests/viewports/fixtures/session";
import { installStubBackend } from "../../tests/viewports/fixtures/stub-backend";
import { setupLinePriceOverrides } from "../../tests/viewports/fixtures/setup-line-prices";

const directory = ".helm/screenshots/issue-959";
const phase = process.env.PHASE === "before" ? "before" : "after";

/** What origin/main's loadOnboardingStatus said for the same business:
 *  before #958 too, so no service-area part, and a one-line business had no
 *  parts at all. */
function asMainSaidIt(merged: Record<string, any>, lines: string[]) {
  const parts = (merged.parts ?? []).filter((p: Record<string, any>) => p.id !== "area");
  const step: Record<string, any> =
    lines.length === 1
      ? {
          ...merged,
          parts: undefined,
          description: String(merged.description).replace(
            " Clients book inside the service area you set here.",
            lines[0] === "training" ? " Your service area is on Zones." : "",
          ),
        }
      : {
          ...merged,
          parts,
          description: String(merged.description).replace(
            "Set your service area, and a price for each",
            "Set a price for each",
          ),
        };
  if (lines.length === 1 && lines[0] === "pet_sitting")
    return {
      ...step,
      description:
        "Review Drop-in, Overnight stay and House sit prices, holiday dates and the deposit refund window before booking your first stay.",
      to: "/settings/services",
      cta: "Review sitting services",
    };
  if (lines.length === 1 && lines[0] === "training") return { ...step, to: "/settings/services" };
  if (lines.length === 1 && lines[0] === "mobile_grooming")
    return {
      ...step,
      description:
        "Review the starter size grid, required vaccines and setup, cleanup and travel minutes in Settings, Services.",
    };
  const cta: Record<string, string> = {
    stays: "Review sitting prices",
    grooms: "Review grooming setup",
    lessons: "Price lessons",
  };
  return {
    ...step,
    parts: step.parts.map((p: Record<string, any>) => ({
      ...p,
      cta: cta[p.id],
      ...(p.id === "stays"
        ? {
            description:
              "Drop-in, Overnight stay and House sit prices, holiday dates and the deposit refund window.",
          }
        : {}),
    })),
  };
}

async function open(page: Page, lines: string[], width: number, skills: boolean) {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
  await installSignedInSession(page);
  const overrides = setupLinePriceOverrides(lines, { skills }) as Record<string, any>;
  if (phase === "before") {
    const status = overrides.getOnboardingStatus;
    overrides.getOnboardingStatus = {
      ...status,
      steps: status.steps.map((s: Record<string, any>) =>
        s.id === "zones" ? asMainSaidIt(s, lines) : s,
      ),
    };
  }
  await installStubBackend(page, { serviceLines: lines, overrides });
  await page.goto("/setup?step=zones", { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-setup-step="zones"]')).toBeVisible({ timeout: 90_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function shoot(page: Page, width: number, state: string) {
  await page.waitForTimeout(600);
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    settingsButtons: [...document.querySelectorAll('[data-setup-step="zones"] a')]
      .filter((a) => a.getAttribute("href") === "/settings/services")
      .map((a) => a.textContent),
    forms: [...document.querySelectorAll("form")]
      .map((f) =>
        ["data-setup-stay-prices", "data-setup-groom", "data-setup-training"].find((k) =>
          f.hasAttribute(k),
        ),
      )
      .filter(Boolean),
  }));
  expect(geometry.scrollWidth, `${state} @${width}: no horizontal page scroll`).toBeLessThanOrEqual(
    width + 1,
  );
  mkdirSync(directory, { recursive: true });
  const name = `${phase}-${state}-${width}`;
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true });
  writeFileSync(
    `${directory}/${name}.json`,
    JSON.stringify({ phase, state, width, ...geometry }, null, 2) + "\n",
  );
}

const CASES = [
  { state: "sitter", lines: ["pet_sitting"], skills: true },
  { state: "groomer", lines: ["mobile_grooming"], skills: true },
  { state: "trainer", lines: ["training"], skills: false },
  {
    state: "sits-grooms-trains",
    lines: ["pet_sitting", "mobile_grooming", "training"],
    skills: true,
  },
];

for (const size of [
  { width: 390, touch: true },
  { width: 1440, touch: false },
]) {
  test.describe(`#959 @${size.width}`, () => {
    test.use({ isMobile: size.touch, hasTouch: size.touch });
    for (const c of CASES) {
      test(c.state, async ({ page }) => {
        test.setTimeout(180_000);
        await open(page, c.lines, size.width, c.skills);
        await shoot(page, size.width, c.state);
      });
    }
  });
}
