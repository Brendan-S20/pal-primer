// Walker groups at the four house widths (#731), in a real browser.
//
// The owner's decision: several pets from different clients share one visit,
// each client is billed separately, each walker has a dog cap, and staff are
// assigned by capacity. Every piece of it is a screen somebody uses from a
// phone in a driveway as often as from a laptop, so each one is driven here at
// 360, 768, 1280 and 1920 and measured with the same rules as every other
// signed-in page:
//
//   1. a group walk is made and takes walks from three different clients, and
//      the card says each client is billed separately, with their own price;
//   2. giving a group to a walker whose dog cap it exceeds is refused with the
//      database's own words, and a group already over a lowered cap says so;
//   3. Assign by capacity gives the open group a walker and leaves a group
//      whose walk was assigned by hand exactly as it was, writing nothing to it;
//   4. R2-29: a group whose walks are held by a walker shows that walker, not
//      "Unassigned", including a walker who does not run routes;
//   5. the dog cap is set on Users & roles;
//   6. a walk plan names its walker in the plan's drawer.
//
// What this measures and what it does not. The backend is the stub
// (fixtures/stub-backend.ts), so this proves the screens: what they draw,
// what they send, and what they do with the answer, at every width. It does
// NOT prove the database enforces the cap; that is
// tests/sql/a-walker-has-a-dog-cap.proof.sql, which runs where a database
// does. The refusal below is the trigger's exact message, so what is measured
// is what a person would read. Assign by capacity's choice is made by the
// real planWalkerCapacity from src/lib/walk-groups.ts, not by the stub.

import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, StubRefusal, type Stub } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import {
  planWalkerCapacity,
  type WalkGroupSummary,
  type WalkGroupVisit,
} from "../../src/lib/walk-groups";

const WIDTHS = [360, 768, 1280, 1920];

const PACK = {
  id: "aaaaaaaa-0000-4000-8000-0000000c7310",
  organization_id: fx.ORG_ID,
  name: "Morning pack walk around the lakefront trail",
  service_line: "dog_walking",
  price_unit: "visit",
  base_price_cents: 2600,
  extra_pet_cents: 0,
  default_duration_min: 60,
  max_dogs: 6,
  active: true,
  created_at: "2026-10-09T12:00:00Z",
  updated_at: "2026-10-09T12:00:00Z",
};

const [ALEJANDRO, SAMANTHA, , WEN, , KAI] = fx.STAFF;

/** Three households, awkward on purpose: long names, one with a diacritic,
 *  different dog counts and prices. */
function walk(n: number, over: Partial<WalkGroupVisit> = {}): WalkGroupVisit {
  const people = [
    { client: "Marisol Castellanos-Whitaker", dogs: ["Biscuit", "Pumpernickel"], price: 2600 },
    { client: "Theo Lindqvist", dogs: ["Juniper"], price: 2400 },
    { client: "Agnieszka Wróblewska-Haddad", dogs: ["Ozzy", "Clementine"], price: 3100 },
    { client: "Rafael Domínguez-Okafor", dogs: ["Pepper"], price: 2600 },
  ][n];
  return {
    id: `aaaaaaaa-0000-4000-8000-0000000f731${n}`,
    serviceId: PACK.id,
    groupId: null,
    client: people.client,
    clientId: `aaaaaaaa-0000-4000-8000-0000000c731${n}`,
    dogs: people.dogs,
    dogCount: people.dogs.length,
    status: "scheduled",
    walkerId: null,
    pinned: false,
    priceCents: people.price,
    ...over,
  };
}

function group(id: string, members: WalkGroupVisit[], walkerId: string | null = null) {
  return {
    id,
    serviceId: PACK.id,
    service: PACK.name,
    maxDogs: PACK.max_dogs,
    walkerId,
    earliestTime: "09:00:00",
    latestTime: "10:30:00",
    members: members.map((m) => ({ ...m, groupId: id })),
  } satisfies WalkGroupSummary;
}

type World = {
  groups: WalkGroupSummary[];
  available: WalkGroupVisit[];
  caps: Record<string, number | null>;
  planWalker: string | null;
  writes: Array<{ name: string; args: Record<string, unknown> }>;
};

/** The day the Group walks panel reads, answered from `world` and changed by
 *  the panel's own writes, so every action round-trips through the screen. */
function walkerStubs(world: World): Record<string, Stub> {
  const people = () =>
    fx.STAFF.map((s) => ({
      id: s.id,
      display_name: s.display_name,
      is_field_tech: s.is_field_tech,
      active: true,
      routingAvailable: true,
      maxDogs: world.caps[s.id] ?? null,
    }));
  const holding = (m: WalkGroupVisit) => m.status === "scheduled" || m.status === "in_progress";
  const dogs = (g: WalkGroupSummary) =>
    g.members.filter(holding).reduce((n, m) => n + m.dogCount, 0);
  const record = (name: string, args: Record<string, unknown>) => world.writes.push({ name, args });
  return {
    listServices: { services: [...fx.SERVICES, PACK] },
    listWalkGroups: () => ({ groups: world.groups, available: world.available, staff: people() }),
    createWalkGroup: (args) => {
      record("createWalkGroup", args);
      const id = "aaaaaaaa-0000-4000-8000-000000097310";
      world.groups = [...world.groups, group(id, [], args.walkerId ?? null)];
      return { id };
    },
    setWalkGroupMember: (args) => {
      record("setWalkGroupMember", args);
      const target = world.groups.find((g) => g.id === args.groupId);
      const v =
        world.available.find((w) => w.id === args.visitId) ??
        world.groups.flatMap((g) => g.members).find((w) => w.id === args.visitId);
      if (!v) throw new StubRefusal("That scheduled walk was not found. Refresh the day.");
      if (target && dogs(target) + v.dogCount > target.maxDogs)
        throw new StubRefusal(
          `This group walk is full: ${dogs(target) + v.dogCount} of ${target.maxDogs} dogs.`,
        );
      world.available = world.available.filter((w) => w.id !== v.id);
      world.groups = world.groups.map((g) => ({
        ...g,
        members: [
          ...g.members.filter((m) => m.id !== v.id),
          ...(g.id === args.groupId
            ? [{ ...v, groupId: g.id, walkerId: g.walkerId ?? v.walkerId }]
            : []),
        ],
      }));
      if (!target) world.available = [...world.available, { ...v, groupId: null }];
      return { ok: true };
    },
    setWalkGroupWalker: (args) => {
      record("setWalkGroupWalker", args);
      const g = world.groups.find((x) => x.id === args.groupId)!;
      const cap = args.walkerId ? (world.caps[args.walkerId] ?? null) : null;
      if (cap != null && dogs(g) > cap && !args.overCapAcknowledged) {
        const name = fx.STAFF.find((s) => s.id === args.walkerId)!.display_name;
        // What setWalkGroupWalker answers when walk_dog_cap_guard refused an
        // unconfirmed over-cap write (20261111160000): the warning, nothing
        // saved. Confirmed, it falls through and saves.
        return {
          overCap: {
            dogs: dogs(g),
            cap,
            walker: name,
            walkGroupId: g.id,
            staffId: args.walkerId,
          },
        };
      }
      world.groups = world.groups.map((x) =>
        x.id === g.id
          ? {
              ...x,
              walkerId: args.walkerId,
              members: x.members.map((m) =>
                m.status === "scheduled" ? { ...m, walkerId: args.walkerId } : m,
              ),
            }
          : x,
      );
      return { ok: true };
    },
    assignWalkGroupsByCapacity: (args) => {
      record("assignWalkGroupsByCapacity", args);
      const walkers = people()
        .filter((p) => p.is_field_tech)
        .map((p) => ({ id: p.id, name: p.display_name, maxDogs: p.maxDogs, services: [] }));
      const decisions = planWalkerCapacity(world.groups, walkers);
      const assigned: Array<{ groupId: string; walkerId: string }> = [];
      const kept: Array<{ groupId: string; reason: string }> = [];
      for (const d of decisions) {
        if (d.action === "keep") {
          kept.push({ groupId: d.groupId, reason: d.reason });
          continue;
        }
        // The server's conditional write: only a group that still has no walker.
        record("walk_groups.update", { id: d.groupId, assigned_staff_id: d.walkerId });
        world.groups = world.groups.map((g) =>
          g.id === d.groupId
            ? {
                ...g,
                walkerId: d.walkerId,
                members: g.members.map((m) =>
                  m.status === "scheduled" ? { ...m, walkerId: d.walkerId } : m,
                ),
              }
            : g,
        );
        assigned.push({ groupId: d.groupId, walkerId: d.walkerId });
      }
      return { assigned, kept };
    },
    listWalkerDogCaps: () => ({
      rows: fx.STAFF.map((s) => ({ id: s.id, maxDogs: world.caps[s.id] ?? null })),
    }),
    setWalkerDogCap: (args) => {
      record("setWalkerDogCap", args);
      world.caps[args.staffId] = args.maxDogs;
      return { ok: true };
    },
    getPlanWalker: () => ({
      walkerId: world.planWalker,
      people: fx.STAFF.map((s) => ({
        id: s.id,
        display_name: s.display_name,
        is_field_tech: s.is_field_tech,
        active: true,
      })),
    }),
    setPlanWalker: (args) => {
      record("setPlanWalker", args);
      world.planWalker = args.walkerId;
      return { ok: true };
    },
  };
}

function freshWorld(over: Partial<World> = {}): World {
  return { groups: [], available: [], caps: {}, planWalker: null, writes: [], ...over };
}

async function open(page: Page, world: World, path: string, extra: Record<string, Stub> = {}) {
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), {
    serviceLines: ["pet_waste", "dog_walking"],
    overrides: { ...walkerStubs(world), ...extra },
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function openRoutes(page: Page, world: World) {
  await open(page, world, "/routes");
  const panel = page.getByRole("region", { name: "Group walks" });
  // Proof this is the Routes page with the walking panel, not /auth or an
  // empty board: the panel only draws for a walking business with a group
  // service, and it names the day.
  await expect(panel.getByRole("heading", { name: "Group walks" })).toBeVisible({
    timeout: 45_000,
  });
  return panel;
}

/** The four rules every signed-in page is held to. */
async function expectLaidOut(page: Page, label: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label}: clipped`).toEqual([]);
  if (page.viewportSize()!.width < 768) {
    expect(await findControlsUnder44px(page), `${label}: under 44px`).toEqual([]);
  }
}

const card = (panel: ReturnType<Page["getByRole"]>, groupId: string) =>
  panel.locator("article").filter({ has: panel.page().locator(`#walker-${groupId}`) });

const selectedText = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.textContent);

for (const width of WIDTHS) {
  test.describe(`walker groups at ${width}`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width < 1280 });

    test("a group walk takes pets from three clients and bills each one", async ({ page }) => {
      const world = freshWorld({ available: [walk(0), walk(1), walk(2)] });
      const panel = await openRoutes(page, world);
      await expect(panel.getByText("No group walks for this day.")).toBeVisible();

      await panel.getByRole("button", { name: "Create group" }).click();
      await panel.getByRole("button", { name: "Create group walk" }).click();
      const id = "aaaaaaaa-0000-4000-8000-000000097310";
      const made = card(panel, id);
      await expect(made).toBeVisible();

      for (const n of [0, 1, 2]) {
        const v = walk(n);
        await made.locator(`#member-${id}`).selectOption(v.id);
        await made.getByRole("button", { name: "Add walk" }).click();
        await expect(made.getByText(v.client, { exact: true }).first()).toBeVisible();
      }
      expect(
        world.writes.filter((w) => w.name === "setWalkGroupMember").map((w) => w.args),
        // Each is sent once, unconfirmed: under the cap, nothing is asked (#731).
      ).toEqual(
        [0, 1, 2].map((n) => ({ visitId: walk(n).id, groupId: id, overCapAcknowledged: false })),
      );
      await expect(made).toContainText("5 of 6 dogs");
      await expect(made).toContainText("Each client is billed separately");
      for (const [who, price] of [
        ["Marisol Castellanos-Whitaker, 2 dogs", "$26.00"],
        ["Theo Lindqvist, 1 dog", "$24.00"],
        ["Agnieszka Wróblewska-Haddad, 2 dogs", "$31.00"],
      ]) {
        const line = made.locator("li").filter({ hasText: who });
        await expect(line).toHaveCount(1);
        await expect(line).toContainText(price);
      }
      // The dog names from each household, under its own client.
      await expect(made).toContainText("Biscuit, Pumpernickel");
      await expect(made).toContainText("Ozzy, Clementine");
      await expectLaidOut(page, `${width} three clients`);
    });

    test("a walker's dog cap warns before a group it does not fit, and flags one over it", async ({
      page,
    }) => {
      const open3 = "aaaaaaaa-0000-4000-8000-000000097311";
      const over = "aaaaaaaa-0000-4000-8000-000000097312";
      const world = freshWorld({
        caps: { [SAMANTHA.id]: 2 },
        groups: [
          group(open3, [walk(0), walk(1)]),
          // Booked with Samantha before her cap was lowered to 2.
          group(
            over,
            [walk(2, { walkerId: SAMANTHA.id }), walk(3, { walkerId: SAMANTHA.id })],
            SAMANTHA.id,
          ),
        ],
      });
      const panel = await openRoutes(page, world);

      // Warn, then allow (#731): one dog over shows the owner's sentence
      // before anything is saved.
      await page.locator(`#walker-${open3}`).selectOption(SAMANTHA.id);
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("This walk will have 3 dogs; the cap is 2.");
      await expect(dialog).toContainText(`${SAMANTHA.display_name} walks up to 2 dogs at a time.`);
      // Measure the dialog where it comes to rest, not partway through its
      // zoom-in-95: its 44px buttons read 43.1px at scale 0.98 (run 43320304654).
      await dialog.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
      await expectLaidOut(page, `${width} cap warning`);
      // Cancel changes nothing: the group still has nobody, and says so.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => selectedText(page, `#walker-${open3}`)).toBe("Unassigned");
      expect(world.groups.find((g) => g.id === open3)!.walkerId).toBeNull();
      // Assign anyway saves it, sent again with the confirmation.
      await page.locator(`#walker-${open3}`).selectOption(SAMANTHA.id);
      await dialog.getByRole("button", { name: "Assign anyway" }).click();
      await expect.poll(() => world.groups.find((g) => g.id === open3)!.walkerId).toBe(SAMANTHA.id);
      expect(
        world.writes
          .filter((c) => c.name === "setWalkGroupWalker")
          .map((c) => Boolean(c.args.overCapAcknowledged)),
      ).toEqual([false, false, true]);
      const confirmed = card(panel, open3);
      await expect(confirmed).toContainText("over the cap");

      const flagged = card(panel, over);
      await expect(flagged).toContainText("3 of 2 dogs");
      await expect(flagged).toContainText("(walker's cap)");
      await expect(flagged).toContainText("over the cap");
      await expectLaidOut(page, `${width} cap`);
    });

    test("assign by capacity fills the open group and never touches a hand assignment", async ({
      page,
    }) => {
      const openG = "aaaaaaaa-0000-4000-8000-000000097313";
      const hand = "aaaaaaaa-0000-4000-8000-000000097314";
      const world = freshWorld({
        caps: { [ALEJANDRO.id]: 1 },
        groups: [
          group(openG, [walk(0), walk(1)]),
          // Wen holds this walk by hand and it is pinned (#609, D10): the one
          // walker this dog tolerates. The group row names nobody.
          group(hand, [walk(2, { walkerId: WEN.id, pinned: true })]),
        ],
      });
      const panel = await openRoutes(page, world);
      // The planner the server uses decides who; Alejandro's cap of 1 rules
      // him out of three dogs.
      const expected = planWalkerCapacity(
        world.groups,
        fx.STAFF.filter((s) => s.is_field_tech).map((s) => ({
          id: s.id,
          name: s.display_name,
          maxDogs: world.caps[s.id] ?? null,
          services: [],
        })),
      );
      const pick = expected.find((d) => d.groupId === openG);
      expect(pick?.action).toBe("assign");
      const pickedId = pick && pick.action === "assign" ? pick.walkerId : "";
      expect(pickedId).not.toBe(ALEJANDRO.id);
      expect(pickedId).not.toBe(WEN.id); // Wen already holds 2 dogs that day

      await panel.getByRole("button", { name: "Assign by capacity" }).click();
      await expect(page.getByText("Assigned 1 group walk by capacity.")).toBeVisible();
      const pickedName = fx.STAFF.find((s) => s.id === pickedId)!.display_name;
      await expect.poll(() => selectedText(page, `#walker-${openG}`)).toBe(pickedName);

      // The hand assignment: still Wen's, shown as Wen's, never written.
      await expect(card(panel, hand)).toContainText(
        `Every walk in this group is with ${WEN.display_name}`,
      );
      await expect.poll(() => selectedText(page, `#walker-${hand}`)).toBe(WEN.display_name);
      expect(world.writes.filter((w) => w.name === "walk_groups.update")).toEqual([
        { name: "walk_groups.update", args: { id: openG, assigned_staff_id: pickedId } },
      ]);
      expect(world.groups.find((g) => g.id === hand)!.members[0].walkerId).toBe(WEN.id);
      await expectLaidOut(page, `${width} capacity`);
    });

    test("R2-29: a group whose walks are held shows their walker, not Unassigned", async ({
      page,
    }) => {
      const held = "aaaaaaaa-0000-4000-8000-000000097315";
      const office = "aaaaaaaa-0000-4000-8000-000000097316";
      const world = freshWorld({
        groups: [
          // Assigned on the board; the group row was never written.
          group(held, [walk(0, { walkerId: ALEJANDRO.id }), walk(1, { walkerId: ALEJANDRO.id })]),
          // Held by someone who does not run routes (Kai is a dispatcher).
          group(office, [walk(2, { walkerId: KAI.id })], KAI.id),
        ],
      });
      const panel = await openRoutes(page, world);
      await expect.poll(() => selectedText(page, `#walker-${held}`)).toBe(ALEJANDRO.display_name);
      await expect(card(panel, held)).toContainText(
        `Every walk in this group is with ${ALEJANDRO.display_name}`,
      );
      await expect
        .poll(() => selectedText(page, `#walker-${office}`))
        .toBe(`${KAI.display_name} (does not run routes)`);
      await expectLaidOut(page, `${width} R2-29`);
    });

    test("the dog cap is set on Users & roles", async ({ page }) => {
      const world = freshWorld();
      await open(page, world, "/settings/users");
      await expect(page.getByRole("heading", { name: "Users & roles" }).first()).toBeVisible({
        timeout: 45_000,
      });
      const row = page.locator("tr").filter({ hasText: SAMANTHA.display_name }).first();
      await row.getByRole("button", { name: "Routing & addresses" }).click();
      const field = page.getByLabel("Most dogs walked at once");
      await expect(field).toBeVisible();
      await expect(field).toHaveAttribute("placeholder", "No cap");
      await expect(field).toHaveValue("");

      await field.fill("0");
      await expect(
        page.getByText("Enter a whole number from 1 to 50, or leave it empty."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Save cap" })).toBeDisabled();

      await field.fill("4");
      await page.getByRole("button", { name: "Save cap" }).click();
      await expect(page.getByText("Dog cap saved")).toBeVisible();
      expect(world.writes.filter((w) => w.name === "setWalkerDogCap")).toEqual([
        { name: "setWalkerDogCap", args: { staffId: SAMANTHA.id, maxDogs: 4 } },
      ]);
      await expect(field).toHaveValue("4");
      await expectLaidOut(page, `${width} dog cap`);
    });

    test("a walk plan names its walker", async ({ page }) => {
      const world = freshWorld();
      const planId = "ffffffff-0000-4000-8000-000000007310";
      await open(page, world, `/clients/${fx.CLIENT_ID}`, {
        listSubscriptionsForClient: {
          subscriptions: [
            {
              id: planId,
              client_id: fx.CLIENT_ID,
              property_id: fx.PROPERTY_ID,
              status: "active",
              frequency: "weekly",
              weekdays: [1, 3, 5],
              price_cents: 2_600,
              dog_count: 2,
              started_on: fx.TODAY,
              starts_on: fx.TODAY,
              ends_on: null,
              preferred_time_of_day: "morning",
              earliest_time: "09:00:00",
              latest_time: "10:30:00",
              account_type: "residential",
              billing_cadence: "per_visit",
              service_id: PACK.id,
              services: { name: PACK.name, service_line: "dog_walking" },
              stay_id: null,
            },
          ],
        },
      });
      await expect(page.getByRole("tab", { name: "Services" })).toBeVisible({ timeout: 45_000 });
      await page.getByRole("tab", { name: "Services" }).click();
      await page.getByText(PACK.name).first().click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByText("Service details")).toBeVisible();
      const select = drawer.getByLabel("Walker");
      await expect(select).toBeVisible();
      await expect.poll(() => select.evaluate((el: HTMLSelectElement) => el.value)).toBe("");
      await select.selectOption(WEN.id);
      await expect(page.getByText("Walker saved")).toBeVisible();
      expect(world.writes.filter((w) => w.name === "setPlanWalker")).toEqual([
        { name: "setPlanWalker", args: { subscriptionId: planId, walkerId: WEN.id } },
      ]);
      await expect.poll(() => select.evaluate((el: HTMLSelectElement) => el.value)).toBe(WEN.id);
      await expect(drawer).toContainText("Walks already on");
      // Measure the drawer where it comes to rest, not partway through its
      // slide in: a sheet in motion has its Close button off the side by
      // however far it still has to travel.
      await drawer.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
      await expectLaidOut(page, `${width} plan walker`);
    });
  });
}
