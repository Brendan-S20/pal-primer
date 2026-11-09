/**
 * #729 in a real browser, at 360 / 768 / 1280 / 1920.
 *
 *   1. The office adds a safety NOTE and an INCIDENT WITH A PHOTO to a pet,
 *      and each entry says who reported it.
 *   2. A technician opens the same log from the client view My Day links to,
 *      sees who reported what, and adds to it.
 *   3. The owner chooses what a missing vaccine does at Start: warn, then
 *      block, then warn again, and the history records each change.
 *   4. An office manager sees that choice read-only, with no way to save it.
 *   5. A tech presses Start under WARN: it starts, and says which pet.
 *   6. A tech presses Start under BLOCK: refused in words, the button stays;
 *      once the record is current the same button starts the visit.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. The backend is the stub
 * (fixtures/stub-backend.ts), which answers by function name and writes
 * nothing. So this proves what the SCREENS do with each answer, at every
 * width, with the layout rules applied. Who may read, write or change what,
 * and that BLOCK is enforced by the database rather than the button, are the
 * database's questions and are pinned in
 * tests/integration/pet-safety-log-and-vaccine-start.db.test.ts against a
 * replayed schema. The two refusals here use the exact text the database
 * raises (start_visit_as, set_vaccine_start_rule), sent the way a thrown
 * server function reaches the client: a 500 whose body is the message.
 *
 * Every state is proved on screen by its own words before anything is
 * measured, because every layout rule here is of the form "nothing is wrong"
 * and passes on a blank panel.
 */
import { test, expect, type BrowserContext, type Page, type Route } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import * as fx from "./fixtures/dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 768, 1280, 1920];
const DOG_ID = "dddd0001";
const DOG_NAME = "Bartholomew";
const OWNER_NAME = "Dana Whitfield-Ramirez";
const TECH_NAME = "Theo Okonkwo-Bramwell";
// The smallest valid PNG: what a phone camera hands the file input, in miniature.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
// What start_visit_as raises under BLOCK, word for word.
const BLOCKED = "VACCINE_START_BLOCKED: required vaccine missing or expired: Bartholomew (rabies)";

type Entry = {
  id: string;
  entry_type: "note" | "incident";
  incident_kind: string | null;
  occurred_at: string;
  body: string;
  storage_path: string | null;
  reporter_name: string;
  reported_by: string | null;
  visit_id: string | null;
  created_at: string;
  photoUrl: string | null;
};

/** The server function a request names, or "" for anything else. */
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
/** A server function that threw, as the client receives it. */
const refuse = (route: Route, message: string) =>
  route.fulfill({ status: 500, contentType: "text/plain", body: message });

/** One field of a multipart body. */
function field(body: string, name: string): string | null {
  const m = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`));
  return m ? m[1] : null;
}

/**
 * The safety log's two functions, against a list that lives for the test. A
 * save is answered by adding to the list, named for whoever is signed in,
 * which is what the database's trigger does with the session; the list
 * refetches through the same stub, so what appears is what was sent.
 */
async function serveSafetyLog(context: BrowserContext, reporter: string, seed: Entry[] = []) {
  const entries = [...seed];
  const posts: { fields: Record<string, string | null>; hadPhoto: boolean }[] = [];
  await context.route("**/_serverFn/**", async (route) => {
    const name = serverFnName(route);
    if (name === "listPetSafetyEntries") return reply(route, [...entries]);
    if (name !== "addPetSafetyEntry") return route.fallback();
    const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
    const fields = Object.fromEntries(
      ["dogId", "entryType", "incidentKind", "occurredAt", "body"].map((k) => [k, field(body, k)]),
    );
    const hadPhoto = /name="photo"; filename="[^"]+"\r\nContent-Type: image\/png/.test(body);
    posts.push({ fields, hadPhoto });
    const id = `5afe0000-0000-4000-8000-${String(entries.length + 1).padStart(12, "0")}`;
    entries.unshift({
      id,
      entry_type: fields.entryType === "incident" ? "incident" : "note",
      incident_kind: fields.entryType === "incident" ? fields.incidentKind : null,
      occurred_at: fields.occurredAt ?? new Date().toISOString(),
      body: fields.body ?? "",
      storage_path: hadPhoto ? `${fx.ORG_ID}/${DOG_ID}/${id}.png` : null,
      reporter_name: reporter,
      reported_by: "sweep-user",
      visit_id: null,
      created_at: new Date().toISOString(),
      photoUrl: hadPhoto ? PNG_URL : null,
    });
    return reply(route, { id });
  });
  return { entries, posts };
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

/** The dialog is inside the screen on both sides. */
async function expectDialogFits(page: Page, label: string) {
  const dialog = page.getByRole("dialog");
  // Measured mid-zoom, a 44px button reads smaller than it is. Wait for the
  // open animation to end, as what-the-iphone-showed.spec.ts does.
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
  );
  const box = (await dialog.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x, `${label}: the dialog starts off the screen`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label}: the dialog runs off the screen`).toBeLessThanOrEqual(
    width + 1,
  );
}

async function openSafetyLog(page: Page) {
  const button = page.getByRole("button", { name: "Safety log" }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Safety log: ${DOG_NAME}` })).toBeVisible();
  return dialog;
}

for (const width of WIDTHS) {
  test.describe(`#729 at ${width}px`, () => {
    test.use({
      viewport: { width, height: 900 },
      hasTouch: width < 1280,
      isMobile: width < 768,
    });

    test("the office logs a note and an incident with a photo, each with who reported it", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      const log = await serveSafetyLog(context, OWNER_NAME);
      await page.goto(`/clients/${fx.CLIENT_ID}`, { waitUntil: "domcontentloaded" });
      const tab = page.getByRole("tab", { name: "Properties", exact: true }).first();
      await expect(tab).toBeVisible({ timeout: FIRST_PAINT_MS });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText(DOG_NAME, { exact: true }).first()).toBeVisible();

      const dialog = await openSafetyLog(page);
      await expect(dialog.getByText("Nothing logged for this pet yet.")).toBeVisible();
      await expectDialogFits(page, `${width} empty log`);
      await expectSound(page, `${width} empty log`);

      // A note: no kind, no photo field.
      await dialog.getByRole("button", { name: "Safety note" }).click();
      await expect(dialog.getByLabel("What kind")).toHaveCount(0);
      await dialog
        .getByLabel("Note")
        .fill("Muzzle for nails. Slips a flat collar; use the martingale.");
      await dialog.getByRole("button", { name: "Add to log" }).click();
      await expect(page.getByText("Added to the safety log").first()).toBeVisible();
      const note = dialog.locator("li", { hasText: "Muzzle for nails" });
      await expect(note).toBeVisible();
      await expect(note).toContainText("Safety note");
      await expect(note).toContainText(`Reported by ${OWNER_NAME}`);

      // An incident: kind, when, what, and a photo.
      await dialog.getByRole("button", { name: "Incident", exact: true }).click();
      await dialog.getByLabel("What kind").selectOption("bite");
      await expect(dialog.getByLabel("When it happened")).not.toHaveValue("");
      await dialog
        .getByLabel("What happened")
        .fill("Nipped the groomer's wrist when the dryer started. Skin not broken.");
      await dialog
        .getByLabel("Photo (optional)")
        .setInputFiles({ name: "wrist.png", mimeType: "image/png", buffer: PNG });
      await dialog.getByRole("button", { name: "Add to log" }).click();
      const incident = dialog.locator("li", { hasText: "Nipped the groomer" });
      await expect(incident).toBeVisible();
      await expect(incident).toContainText("Bite");
      await expect(incident).toContainText(`Reported by ${OWNER_NAME}`);
      await expect(incident.getByRole("img", { name: "Incident photo" })).toBeVisible();

      // What went over the wire is what the screen shows.
      expect(log.posts.map((p) => p.fields.entryType)).toEqual(["note", "incident"]);
      expect(log.posts[1].fields.incidentKind).toBe("bite");
      expect(log.posts[1].fields.dogId).toBe(DOG_ID);
      expect(log.posts[1].hadPhoto, "the incident's photo was sent").toBe(true);
      expect(log.posts[0].hadPhoto, "a note sends no photo").toBe(false);
      // Newest first.
      await expect(dialog.locator("ul > li").first()).toContainText("Nipped the groomer");

      await expectDialogFits(page, `${width} two entries`);
      await expectSound(page, `${width} two entries`);

      // Closed, the pet card says there is an incident on file.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByText("1 incident").first()).toBeVisible();
      await expectSound(page, `${width} pet card`);
    });

    test("a tech opens the same log from the client view, sees who reported it, and adds to it", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        role: "tech",
        overrides: {
          getFieldClientInfo: {
            client: {
              id: fx.CLIENT_ID,
              display_name: "Anastasia Vandermolen-Whitaker",
              primary_phone: "+1 (312) 555-0199",
              notes: null,
            },
            properties: [fx.PROPERTIES[0]],
            dogs: [
              {
                id: DOG_ID,
                property_id: fx.PROPERTY_ID,
                name: DOG_NAME,
                breed: "Bernese Mountain Dog",
                weight_class: "large",
                temperament: "friendly",
                species: "dog",
                notes: null,
              },
            ],
            ownVisitLines: ["pet_waste"],
          },
        },
      });
      await serveSafetyLog(context, TECH_NAME, [
        {
          id: "5afe0000-0000-4000-8000-0000000000a1",
          entry_type: "incident",
          incident_kind: "escape",
          occurred_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          body: "Slipped the lead at the side gate; caught two houses down.",
          storage_path: `${fx.ORG_ID}/${DOG_ID}/5afe0000-0000-4000-8000-0000000000a1.png`,
          reporter_name: OWNER_NAME,
          reported_by: "someone-else",
          visit_id: null,
          created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          photoUrl: PNG_URL,
        },
      ]);
      await page.goto(`/clients/${fx.CLIENT_ID}`, { waitUntil: "domcontentloaded" });
      // The tech's view, not the office's: the link back to My Day only it draws.
      await expect(page.getByRole("link", { name: /My Day/ })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByText("1 incident").first()).toBeVisible();
      await expectSound(page, `${width} tech client view`);

      const dialog = await openSafetyLog(page);
      const prior = dialog.locator("li", { hasText: "Slipped the lead" });
      await expect(prior).toContainText("Escape or slipped lead");
      await expect(prior).toContainText(`Reported by ${OWNER_NAME}`);
      await expect(prior.getByRole("img", { name: "Incident photo" })).toBeVisible();

      await dialog.getByLabel("What kind").selectOption("aggression");
      await dialog.getByLabel("What happened").fill("Lunged at the fence when the mower started.");
      await dialog.getByRole("button", { name: "Add to log" }).click();
      const mine = dialog.locator("li", { hasText: "Lunged at the fence" });
      await expect(mine).toContainText(`Reported by ${TECH_NAME}`);
      await expect(mine).toContainText("Aggression");
      await expectDialogFits(page, `${width} tech log`);
      await expectSound(page, `${width} tech log`);
    });

    test("the owner chooses warn or block for a missing vaccine at Start, and each change is kept", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      let rule: "warn" | "block" = "warn";
      const history: {
        changed_at: string;
        old_value: string;
        new_value: string;
        changed_by: string;
      }[] = [];
      const saves: string[] = [];
      await installStubBackend(context, {
        serviceLines: ["pet_waste", "mobile_grooming"],
        overrides: {
          getVaccineSettings: {
            enabled: true,
            rule: "warn",
            required: ["rabies", "dhpp"],
            today: fx.TODAY,
            bufferMin: 15,
          },
        },
      });
      await context.route("**/_serverFn/**", async (route) => {
        const name = serverFnName(route);
        if (name === "getVaccineStartRule")
          return reply(route, {
            rule,
            setAt: history[0]?.changed_at ?? null,
            canChange: true,
            history: [...history],
          });
        if (name === "setVaccineStartRule") {
          const next = route.request().postData()?.includes('"block"') ? "block" : "warn";
          saves.push(next);
          if (next !== rule) {
            history.unshift({
              changed_at: new Date(Date.now() + history.length * 60_000).toISOString(),
              old_value: rule,
              new_value: next,
              changed_by: "sweep-user",
            });
            rule = next;
          }
          return reply(route, { rule });
        }
        return route.fallback();
      });
      await page.goto("/settings/services", { waitUntil: "domcontentloaded" });
      const card = page.locator("form", {
        has: page.getByRole("heading", { name: "Vaccines at Start" }),
      });
      await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
      const select = card.getByLabel(/When a tech starts a groom/);
      await card.scrollIntoViewIfNeeded();
      await expect(select).toBeEnabled();
      await expect(select).toHaveValue("warn");
      await expect(select.locator("option:checked")).toHaveText(
        "Warn the tech and start (default)",
      );
      await expect(
        card.getByText("Only the owner can change this.", { exact: false }),
      ).toBeVisible();
      const save = card.getByRole("button", { name: "Save" });
      await expect(save, "nothing to save until the choice changes").toBeDisabled();
      await expectSound(page, `${width} owner, warn`);

      await select.selectOption("block");
      await save.click();
      await expect(page.getByText("Vaccine rule at Start saved").first()).toBeVisible();
      await expect(select).toHaveValue("block");
      await card.getByText("Change history").click();
      await expect(card.locator("li")).toHaveCount(1);
      await expect(card.locator("li").first()).toContainText(
        "Warn the tech and start → Do not start until the record is updated",
      );
      await expectSound(page, `${width} owner, block`);

      await select.selectOption("warn");
      await card.getByRole("button", { name: "Save" }).click();
      await expect(select).toHaveValue("warn");
      if (!(await card.locator("details").evaluate((d) => (d as HTMLDetailsElement).open)))
        await card.getByText("Change history").click();
      await expect(card.locator("li")).toHaveCount(2);
      await expect(card.locator("li").first()).toContainText(
        "Do not start until the record is updated → Warn the tech and start",
      );
      expect(saves).toEqual(["block", "warn"]);
      await expectSound(page, `${width} owner, back to warn`);
    });

    test("an office manager sees the vaccine Start rule read-only", async ({ page, context }) => {
      await installSignedInSession(context);
      const saves: string[] = [];
      await installStubBackend(context, {
        role: "office_manager",
        serviceLines: ["pet_waste", "mobile_grooming"],
        overrides: {
          getVaccineSettings: {
            enabled: true,
            rule: "warn",
            required: ["rabies"],
            today: fx.TODAY,
            bufferMin: 15,
          },
          getVaccineStartRule: {
            rule: "block",
            setAt: "2026-11-08T15:00:00Z",
            canChange: false,
            history: [
              {
                changed_at: "2026-11-08T15:00:00Z",
                old_value: "warn",
                new_value: "block",
                changed_by: "owner",
              },
            ],
          },
          setVaccineStartRule: () => {
            saves.push("called");
            return { rule: "block" };
          },
        },
      });
      await page.goto("/settings/services", { waitUntil: "domcontentloaded" });
      const card = page.locator("form", {
        has: page.getByRole("heading", { name: "Vaccines at Start" }),
      });
      await expect(card).toBeVisible({ timeout: FIRST_PAINT_MS });
      await card.scrollIntoViewIfNeeded();
      const select = card.getByLabel(/When a tech starts a groom/);
      await expect(select).toHaveValue("block");
      await expect(select).toBeDisabled();
      await expect(card.getByRole("button", { name: "Save" })).toHaveCount(0);
      await expect(
        card.getByText("Only the owner can change this.", { exact: true }),
      ).toBeVisible();
      await card.getByText("Change history").click();
      await expect(card.locator("li").first()).toContainText(
        "Warn the tech and start → Do not start until the record is updated",
      );
      expect(saves, "the office manager's page never asked to save").toEqual([]);
      await expectSound(page, `${width} office manager`);
    });

    test("WARN: Start goes ahead and says which pet is missing a vaccine", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, { role: "tech" });
      const starts: number[] = [];
      await context.route("**/_serverFn/**", async (route) => {
        if (serverFnName(route) !== "startVisit") return route.fallback();
        starts.push(Date.now());
        return reply(route, {
          ok: true,
          vaccineWarnings: [{ dog_id: DOG_ID, dog_name: DOG_NAME, vaccine: "rabies" }],
        });
      });
      await page.goto("/my-day", { waitUntil: "domcontentloaded" });
      const card = page.locator("ol > li").first();
      const start = card.getByRole("button", { name: "Start", exact: true });
      await expect(start).toBeVisible({ timeout: FIRST_PAINT_MS });
      await start.click();
      await expect(
        page.getByText(`Started. Missing or expired vaccine: ${DOG_NAME}`).first(),
      ).toBeVisible();
      expect(starts).toHaveLength(1);
      // Started: the button has moved on to the next step.
      await expect(start).toHaveCount(0);
      await expectSound(page, `${width} warn start`);
    });

    test("BLOCK: Start is refused in words, and goes ahead once the record is current", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, { role: "tech" });
      let current = false;
      const starts: string[] = [];
      await context.route("**/_serverFn/**", async (route) => {
        if (serverFnName(route) !== "startVisit") return route.fallback();
        starts.push(current ? "current" : "missing");
        return current ? reply(route, { ok: true, vaccineWarnings: [] }) : refuse(route, BLOCKED);
      });
      await page.goto("/my-day", { waitUntil: "domcontentloaded" });
      const card = page.locator("ol > li").first();
      const start = card.getByRole("button", { name: "Start", exact: true });
      await expect(start).toBeVisible({ timeout: FIRST_PAINT_MS });
      await start.click();
      await expect(
        page
          .getByText(
            "Not started. A required vaccine is missing or expired, and this business does not start a visit until it is updated. Ask the office.",
          )
          .first(),
      ).toBeVisible();
      // Refused, not queued: nothing says it will start later, and the button is still Start.
      await expect(page.getByText("Queued. Starts when back online")).toHaveCount(0);
      await expect(start).toBeVisible();
      await expectSound(page, `${width} blocked start`);

      // The office updates the record; the same button now starts the visit.
      current = true;
      await start.click();
      await expect(page.getByText("Started", { exact: true }).first()).toBeVisible();
      await expect(start).toHaveCount(0);
      expect(starts).toEqual(["missing", "current"]);
      await expectSound(page, `${width} start once current`);
    });
  });
}
