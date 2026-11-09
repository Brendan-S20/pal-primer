import { mkdirSync } from "node:fs";
import { test, expect, type Page, type Route } from "@playwright/test";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";

/**
 * The office training path, on demo data: the catalog, a sold package, and
 * the lesson a trainer records. Customers still cannot book it.
 */

const WIDTHS = [
  { w: 390, h: 844, label: "phone" },
  { w: 820, h: 1180, label: "tablet" },
  { w: 1024, h: 900, label: "laptop" },
  { w: 1440, h: 900, label: "desktop" },
];

const LESSON_ID = "aaaaaaaa-0000-4000-8000-00000000c601";
const EVAL_ID = "aaaaaaaa-0000-4000-8000-00000000c602";
const PACKAGE_ID = "cccccccc-0000-4000-8000-00000000f001";
const SOLD_ID = "cccccccc-0000-4000-8000-00000000f101";
const SKILL_SIT = "dddddddd-0000-4000-8000-00000000f201";
const SKILL_DOWN = "dddddddd-0000-4000-8000-00000000f202";
const DOG_ID = "bbbbbbbb-0000-4000-8000-00000000b0d1";

const trainingServices = [
  ...fx.SERVICES,
  {
    id: LESSON_ID,
    organization_id: fx.ORG_ID,
    name: "Private lesson (60 min)",
    service_line: "training",
    price_unit: "visit",
    base_price_cents: 8000,
    extra_pet_cents: 0,
    default_duration_min: 60,
    active: true,
  },
  {
    id: EVAL_ID,
    organization_id: fx.ORG_ID,
    name: "Evaluation (45 min)",
    service_line: "training",
    price_unit: "visit",
    base_price_cents: 6500,
    extra_pet_cents: 0,
    default_duration_min: 45,
    active: true,
  },
];

const catalogPackage = {
  id: PACKAGE_ID,
  organization_id: fx.ORG_ID,
  service_id: LESSON_ID,
  name: "6-session package",
  sessions_count: 6,
  expires_after_days: 90,
  price_cents: 42000,
  active: true,
};

const soldPackage = {
  id: SOLD_ID,
  organization_id: fx.ORG_ID,
  client_id: fx.CLIENT_ID,
  dog_id: DOG_ID,
  service_package_id: PACKAGE_ID,
  service_id: LESSON_ID,
  name: "6-session package",
  sessions_count: 6,
  price_cents: 42000,
  purchased_on: "2026-10-01",
  expires_on: "2026-12-30",
  sessions_used: 1,
  invoice_id: fx.INVOICES[0].id,
  request_id: null,
  status: "active",
  canceled_at: null,
  held: 3,
  bookedAfterToday: 2,
  left: 5,
  free: 3,
  state: "active",
  invoice: { id: fx.INVOICES[0].id, number: fx.INVOICES[0].number, status: "open" },
};

const skills = [
  { id: SKILL_SIT, name: "Sit", sort_order: 0, active: true },
  { id: SKILL_DOWN, name: "Down", sort_order: 1, active: true },
];

function serverFnName(route: Route): string {
  const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
  try {
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}

function lessonVisit() {
  const v = fx
    .visitsBetween(fx.TODAY, fx.TODAY)
    .find((x) => x.assigned_staff_id === fx.STAFF[0].id);
  if (!v) throw new Error("the fixture day has no visit for the first technician");
  return {
    ...v,
    organization_id: fx.ORG_ID,
    status: "in_progress",
    started_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    completed_at: null,
    skip_reason: null,
    skip_reason_code: null,
    services: { name: "Private lesson (60 min)", service_line: "training" },
    clients: {
      display_name: (v.clients as { display_name?: string }).display_name,
      primary_phone: "+1 (312) 555-0142",
      dna_compliance_enabled: false,
    },
    properties: {
      ...(v.properties as object),
      account_type: "residential",
      has_units: false,
      dogs: [{ name: "Biscuit", temperament: "friendly" }],
      yard_size: "medium",
      gate_code: null,
      lock_box_code: null,
      key_location: null,
      parking_notes: null,
      access_notes: null,
    },
    visit_photos: [],
    visit_checklist: null,
    gate_reply: null,
  };
}

const ANSWERS: Record<string, unknown> = {
  ensureTrainingCatalog: { ok: true },
  listServices: { services: trainingServices },
  listServicePackages: { packages: [catalogPackage] },
  listTrainingSkills: { skills },
  listClientPackages: { packages: [soldPackage] },
  listTrainingBookingOptions: {
    properties: [{ id: "pppppppp-0000-4000-8000-000000000001", street: "1842 W Wilson Ave" }],
    dogs: [{ id: DOG_ID, name: "Biscuit", property_id: "pppppppp-0000-4000-8000-000000000001" }],
    staff: [{ id: fx.STAFF[0].id, display_name: fx.STAFF[0].display_name }],
    packages: [{ ...catalogPackage, services: { name: "Private lesson (60 min)" } }],
    lessonMinutes: { [LESSON_ID]: 60 },
  },
  getTrainingSessionRules: { lateCancelHours: 24, missedUsesSession: true },
  getTrainingSession: { n: 2, total: 6 },
  getSessionProgress: {
    skills,
    scores: [{ skill_id: SKILL_SIT, score: 3 }],
    note: "Held a sit while the door opened.",
    homework: "Five sits before dinner.",
    homeworkDue: "2026-10-20",
    dog: { id: DOG_ID, name: "Biscuit" },
    // Two dogs, one with a long name: the dog picker wraps rather than
    // widens the stop card (R2-26).
    dogs: [
      { id: DOG_ID, name: "Biscuit" },
      { id: "dddddddd-0000-4000-8000-000000000002", name: "Sir Reginald Tillingham-Barkworth III" },
    ],
    dogGuessed: false,
    trends: [
      { skill: "Sit", scores: [1, 2, 3, 3, 4, 4], first: 1, latest: 4, lessons: 8 },
      {
        skill: "Loose-leash walking past the neighbour's reactive terrier",
        scores: [1, 1, 2],
        first: 1,
        latest: 2,
        lessons: 3,
      },
    ],
    // Long on purpose: an earlier lesson's note and homework wrap rather
    // than widen the stop card.
    history: [
      {
        visitId: "vvvvvvvv-0000-4000-8000-000000000101",
        scheduledOn: "2026-10-09",
        scores: [
          { skill: "Sit", score: 2 },
          { skill: "Loose-leash walking past the neighbour's reactive terrier", score: 1 },
        ],
        note: "Pulled hard at the corner of Wilson and Ashland every time the bus went past, settled after about ten minutes of turns.",
        homework:
          "Three five-minute loose-leash walks a day, turning away before the corner, treats at the hip.",
      },
    ],
  },
  getMyDay: () => ({
    staff: { ...fx.STAFF[0], organization_id: fx.ORG_ID },
    visits: [lessonVisit()],
    previewing: false,
  }),
};

async function open(page: Page, path: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await installSignedInSession(page);
  await installStubBackend(page, { role: "owner", serviceLines: ["pet_waste", "training"] });
  await page.route("**/_serverFn/**", async (route) => {
    const name = serverFnName(route);
    if (!(name in ANSWERS)) return route.fallback();
    const value = ANSWERS[name];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: typeof value === "function" ? value() : value }),
    });
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function measure(page: Page, width: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: error boundary`).toBe(false);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

const shotDir = "test-results/training-ui";

for (const { w, h, label } of WIDTHS) {
  test.describe(`training, ${label}`, () => {
    test(`settings, a sold package, and a lesson @${w}px`, async ({ page }) => {
      mkdirSync(shotDir, { recursive: true });

      await open(page, "/settings/services", w, h);
      await expect(page.getByTestId("training-packages-settings")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("6-session package")).toBeVisible();
      await expect(
        page.getByText("Clients cannot book a training lesson from the portal yet."),
      ).toBeVisible();
      await expect(page.getByTestId("training-skills-settings")).toBeVisible();
      await measure(page, w, `settings ${label}`);
      await page.screenshot({ path: `${shotDir}/settings-${w}.png`, fullPage: true });

      await open(page, `/clients/${fx.CLIENT_ID}?tab=services`, w, h);
      await expect(page.getByTestId("client-training-packages")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("5 of 6 sessions left")).toBeVisible();
      await expect(page.getByText("INV-10420")).toBeVisible();
      await measure(page, w, `client ${label}`);
      await page.screenshot({ path: `${shotDir}/client-package-${w}.png`, fullPage: true });

      await open(page, "/my-day", w, h);
      await expect(page.getByText("Session 2 of 6")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Record progress" }).click();
      await expect(page.getByRole("group", { name: "Score for Sit" })).toBeVisible();
      await expect(page.getByLabel("Session note")).toHaveValue(
        "Held a sit while the door opened.",
      );
      await measure(page, w, `my day ${label}`);
      await page.screenshot({ path: `${shotDir}/lesson-progress-${w}.png`, fullPage: true });
    });
  });
}
