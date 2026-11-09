/**
 * #412 in a real browser, at 360 / 768 / 1280 / 1920, touch on below 1280.
 *
 * What a groomer could not see, or say, on a groom's card until now:
 *
 *   1. Whether the van can plug in or fill up at the address. The parking
 *      note was there; power and water were a line somebody might write in it.
 *   2. The add-ons booked on this groom, one box each. Untick one the dog
 *      would not sit for and it is not billed when the groom is completed.
 *
 * Named under "what-the-tech-could-not-see" on purpose: Playwright selects
 * specs by a regular expression over the path, so the existing filter in
 * test:viewports:cases (and so Sandboxes' one-off cases job) runs this file
 * without a change to package.json, which two other open PRs are editing.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. The backend is the stub, which writes
 * nothing. This proves what the card draws for each answer and what it sends
 * when a box is unticked, at every width, with the layout rules applied. That
 * an unticked add-on is not billed, that only the visit's groomer may untick
 * it, and that a finished groom refuses, are the database's and are pinned in
 * tests/integration/a-groomer-says-which-add-ons-were-done.db.test.ts.
 *
 * Every state is proved on screen by its own words before anything is
 * measured: each rule below is "nothing is wrong", which a blank card passes.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 768, 1280, 1920];
const TEETH = "a0d0e000-0000-4000-8000-000000000001";
const DESHED = "a0d0e000-0000-4000-8000-000000000002";
// Long on purpose: a fixture tidier than reality measures nothing.
const DESHED_NAME = "De-shed and undercoat rake-out for double-coated breeds (husky, malamute)";

function serverFnName(route: Route): string {
  const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
  try {
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}
const reply = (route: Route, result: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) });

/** My Day with its in-progress stop turned into a groom. */
function groomDay() {
  const day = structuredClone((BASE_STUBS.getMyDay as (a: object) => any)({}));
  const visit = (day.visits as any[]).find((v) => v.status === "in_progress");
  if (!visit) throw new Error("the stub day has no stop in progress to make a groom of");
  visit.services = {
    name: "Full groom",
    service_line: "mobile_grooming",
    default_duration_min: 90,
  };
  visit.groom_summary = `Full groom + Teeth brushing, ${DESHED_NAME}`;
  visit.groom_dog_ids = null;
  visit.groom_pets = [];
  return { day, visitId: visit.id as string };
}

async function expectSound(page: Page, label: string) {
  const width = page.viewportSize()!.width;
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label}: a control is off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label}: text is cut off`).toEqual([]);
  expect(
    await findControlsNarrowerThanTheirLabel(page),
    `${label}: a label runs out of its control`,
  ).toEqual([]);
  if (width < 768) {
    expect(await findControlsUnder44px(page), `${label}: a control under 44px`).toEqual([]);
  }
}

for (const width of WIDTHS) {
  test.describe(`#412 groom card at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: width < 1280,
      isMobile: width < 768,
    });

    test("the groomer sees the van's hookups and unticks an add-on that was not done", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, { role: "tech" });
      const { day, visitId } = groomDay();
      let notDone: string[] = [];
      const marks: Array<{ addonServiceId: string; done: boolean }> = [];
      await context.route("**/_serverFn/**", async (route) => {
        const name = serverFnName(route);
        if (name === "getMyDay") return reply(route, day);
        if (name === "getGroomVisitExtras") {
          return reply(route, {
            visitId,
            canMark: true,
            addons: [
              {
                addonServiceId: TEETH,
                name: "Teeth brushing",
                quantity: 1,
                done: !notDone.includes(TEETH),
              },
              {
                addonServiceId: DESHED,
                name: DESHED_NAME,
                quantity: 2,
                done: !notDone.includes(DESHED),
              },
            ],
            van: { power: true, water: true },
          });
        }
        if (name === "setGroomAddonDone") {
          // The body is seroval-encoded; the add-on's id is in it as text.
          // A tap flips the box, so done is the opposite of what it was.
          const text = route.request().postData() ?? "";
          const addonServiceId = text.includes(TEETH) ? TEETH : DESHED;
          const done = notDone.includes(addonServiceId);
          marks.push({ addonServiceId, done });
          notDone = done
            ? notDone.filter((x) => x !== addonServiceId)
            : [...notDone, addonServiceId];
          return reply(route, { notDone });
        }
        return route.fallback();
      });

      await page.goto("/my-day", { waitUntil: "domcontentloaded" });
      const heading = page.getByText("Add-ons on this groom").first();
      await expect(heading).toBeVisible({ timeout: FIRST_PAINT_MS });
      await heading.scrollIntoViewIfNeeded();
      await expect(page.getByText("Van hookups").first()).toBeVisible();
      await expect(page.getByText("Power available").first()).toBeVisible();
      await expect(page.getByText("Water available").first()).toBeVisible();
      await expect(page.getByText(`${DESHED_NAME} ×2`).first()).toBeVisible();
      await expect(page.getByText("Only add-ons marked done are billed.").first()).toBeVisible();
      await expectSound(page, `${width} groom card`);

      const teeth = page.getByRole("checkbox", { name: /Teeth brushing/ });
      await expect(teeth).toBeChecked();
      await teeth.click();
      await expect(
        page.getByText("Teeth brushing marked not done. It won't be billed.").first(),
      ).toBeVisible();
      await expect(teeth).not.toBeChecked();
      await expect(page.getByText("Not done", { exact: true }).first()).toBeVisible();
      expect(marks).toEqual([{ addonServiceId: TEETH, done: false }]);
      await expectSound(page, `${width} add-on not done`);
    });
  });
}
