// #784: the owner adds a SECOND client, on a ZIP no zone covers, at a price
// typed by hand -- and Create client must either create it or say why.
//
// Onboarding QA, 2026-11-09, live build 78611cf3: an org with one client,
// `/clients/new`, ZIP 48933, "No zone matches ZIP 48933. Set price manually
// below.", $20, Create client. The wizard stayed open, the button stayed
// enabled, no error on the screen, and /clients still said "1 total". A new
// owner cannot tell a typo from a broken product.
//
// Driven through the real wizard against the real database, because the
// question is the whole round trip: the plan step's manual price, the server
// function, the rows it writes, and what the screen does afterwards.
//
// Two halves, because the acceptance is an either/or:
//
//   * it works: the client and its plan at the typed price are written, and
//     the wizard moves to the new client. The price is typed the way the
//     issue writes it, "$20" -- the box's own "$" sits outside it, and a
//     typed one used to read as no price at all.
//   * it does not: the request fails (the live run measured 10-16 s step
//     transitions, which is a server that is slow or falling over). The only
//     word of that used to be a toast, gone four seconds later; a person
//     looking at the screen after that saw exactly what the issue describes.
//     The reason now stays under the button until the next try.

import { expect, test, type Page } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { signIn, waitForHydration } from "./sign-in";

async function next(page: Page) {
  await page.getByRole("button", { name: /^continue$/i }).click();
}

/** From /clients/new to the Plan step, as the tester did, with the price typed. */
async function wizardToPlan(page: Page, name: string, price: string) {
  await signIn(page);
  await page.goto("/clients/new");
  await waitForHydration(page, "#dn");

  // Contact
  await page.locator("#dn").fill(name);
  await next(page);

  // Property: typed by hand, the way a person does when they do not pick a
  // suggestion.
  await page.locator("#st").fill("200 Test Ave");
  await page.keyboard.press("Escape");
  await page.locator("#ci").fill("Lansing");
  await page.locator("#rg").fill("MI");
  await page.locator("#pc").fill("48933");
  await next(page);

  // Every step between Property and Plan (Outline is pet-waste-only and
  // optional; Dogs gets the tester's dog). Waits for the step to move each
  // time, because the next step's controls are not there until it has.
  for (let i = 0; i < 4; i++) {
    if (await page.getByRole("button", { name: /^create client$/i }).isVisible()) break;
    const dogName = page.getByPlaceholder("Bailey").first();
    if (await dogName.isVisible()) await dogName.fill("Testdog2");
    const stepBefore = await page.locator("[aria-current='step']").getAttribute("aria-label");
    await next(page);
    await expect(page.locator("[aria-current='step']")).not.toHaveAttribute(
      "aria-label",
      stepBefore ?? "",
    );
  }

  // #860: outside every zone the Plan step offers the standard price. The
  // seeded org has none, so it says so and asks for a price, which is the
  // manual-price path this spec is about.
  await expect(
    page.getByText(/no zone matches zip 48933 and there is no standard price yet/i),
    "the no-zone message",
  ).toBeVisible({ timeout: 20_000 });
  await page.locator("#po").fill(price);
}

async function clientsNamed(name: string) {
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const { data } = await db
    .from("clients")
    .select("id, subscriptions(price_cents)")
    .eq("organization_id", orgId)
    .eq("display_name", name);
  return data ?? [];
}

async function removeClientsNamed(name: string) {
  const db = serviceDb();
  for (const r of await clientsNamed(name)) await db.from("clients").delete().eq("id", r.id);
}

test.beforeAll(async () => {
  // The QA org already had a client; the seeded org has ten. Either way this
  // is not the business's first.
  const db = serviceDb();
  const { count } = await db
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", await e2eOrgId(db));
  expect(count ?? 0, "the org already has a client").toBeGreaterThan(0);
});

test("a second client at a manual $20, on a ZIP with no zone, is created", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `QA Test Client 2 (fake) ${Date.now()}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    await wizardToPlan(page, name, "$20");

    const create = page.getByRole("button", { name: /^create client$/i });
    await expect(create, "a typed $20 is a price").toBeEnabled();
    await create.click();

    // Either the client exists and the wizard has moved to it, or the screen
    // says why it does not. Never neither.
    await expect
      .poll(
        async () => {
          if (/\/clients\/[0-9a-f-]{36}/.test(page.url())) return "navigated";
          const alert = page.getByTestId("create-client-error");
          if (await alert.count()) return `error: ${await alert.innerText()}`;
          return "nothing";
        },
        { timeout: 30_000, message: "Create client did something a person can see" },
      )
      .toBe("navigated");

    const rows = await clientsNamed(name);
    expect(rows.length, "exactly one client written").toBe(1);
    const subs = (rows[0] as { subscriptions: Array<{ price_cents: number }> }).subscriptions;
    expect(
      subs.map((s) => s.price_cents),
      "the plan at the typed price",
    ).toEqual([2000]);
    expect(pageErrors, "nothing thrown in the page").toEqual([]);
  } finally {
    await removeClientsNamed(name);
  }
});

test("a create that fails says why, and keeps saying it", async ({ page }) => {
  test.setTimeout(120_000);
  const name = `QA Test Client 2 (fake) ${Date.now()}`;

  try {
    await wizardToPlan(page, name, "20");

    // The create request, and only that one, dies on the way: what a person
    // sees when the server is slow or down.
    await page.route("**/_serverFn/**", async (route) => {
      if (route.request().method() === "POST" && route.request().postData()?.includes(name)) {
        await route.abort("failed");
        return;
      }
      await route.fallback();
    });

    const create = page.getByRole("button", { name: /^create client$/i });
    await create.click();

    const alert = page.getByTestId("create-client-error");
    await expect(alert, "the reason is on the page").toBeVisible({ timeout: 30_000 });
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText(/did not finish/i);

    // Past the toast's own lifetime: whoever looks at the screen now still
    // reads why, and can try again.
    await page.waitForTimeout(6_000);
    await expect(alert, "still there after the toast has gone").toBeVisible();
    await expect(create, "and the button can be pressed again").toBeEnabled();
    await expect(page, "still on the wizard").toHaveURL(/\/clients\/new/);
    expect(await clientsNamed(name), "nothing was written").toHaveLength(0);

    // The next try clears it, and with the server back, works.
    await page.unroute("**/_serverFn/**");
    await create.click();
    await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}/, { timeout: 30_000 });
    expect(await clientsNamed(name)).toHaveLength(1);
  } finally {
    await removeClientsNamed(name);
  }
});
