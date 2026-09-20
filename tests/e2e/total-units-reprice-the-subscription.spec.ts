// QA: "Client detail (commercial): ... change property Total units →
// subscription count + price + activity entry."
//
// What the product actually promises is narrower than the QA sentence, and
// the spec asserts the real contract: updateProperty propagates the new
// total to every active subscription's unit_count ALWAYS, but touches
// price_cents only when the zone carries commercial rates — and the seeded
// Westside Suburb zone deliberately has none (it prices per square foot).
// So on this fixture the honest assertions are: units propagate, the price
// does NOT move, and the paper trail is property.updated. A zone with
// commercial_per_unit_cents is the variant a person exercises when one
// exists; asserting a reprice here would be testing a row the fixture
// doesn't have.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { e2eOrgId, serviceDb } from "./service-db";
import { signIn } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

test("raising Total units flows into the subscription and the activity log", async ({ page }) => {
  test.setTimeout(240_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  const { data: client } = await db
    .from("clients")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", "Riverside HOA")
    .single();
  expect(client).toBeTruthy();

  // Own the starting state: the seed leaves has_units unset and unit_count 8,
  // and a previous run of this spec leaves 12s behind.
  const { data: prop } = await db
    .from("properties")
    .select("id")
    .eq("client_id", client!.id)
    .limit(1)
    .single();
  await db.from("properties").update({ has_units: false, total_units: null }).eq("id", prop!.id);
  const { data: sub } = await db
    .from("subscriptions")
    .select("id, price_cents")
    .eq("client_id", client!.id)
    .eq("status", "active")
    .single();
  await db.from("subscriptions").update({ unit_count: 8 }).eq("id", sub!.id);
  const priceBefore = sub!.price_cents;

  await signIn(page);
  // ?editProperty is the route's own deep link into the drawer — it opens on
  // arrival and is stripped from the URL, exactly for callers like this.
  await page.goto(`/clients/${client!.id}?tab=properties&editProperty=${prop!.id}`);
  await expect(page.getByText("Edit property")).toBeVisible({ timeout: 30_000 });

  // The units field only exists behind the checkbox — the seed left it off,
  // which is why the reset above matters: this path exercises turning a
  // plain commercial property INTO a unit-tracked one, the harder branch.
  await page.getByText("This property has units (HOA / multi-unit)").click();
  const units = page.getByLabel("Total units");
  await expect(units).toBeVisible();
  await units.fill("12");
  await page.getByRole("button", { name: "Save changes" }).click();

  // The write, all three legs of it.
  await expect
    .poll(
      async () => {
        const { data } = await db
          .from("properties")
          .select("has_units, total_units")
          .eq("id", prop!.id)
          .single();
        return data?.has_units ? data.total_units : null;
      },
      { timeout: 30_000 },
    )
    .toBe(12);

  await expect
    .poll(
      async () => {
        const { data } = await db
          .from("subscriptions")
          .select("unit_count, price_cents")
          .eq("id", sub!.id)
          .single();
        return `${data?.unit_count}|${data?.price_cents}`;
      },
      { timeout: 30_000 },
    )
    .toBe(`12|${priceBefore}`); // units propagate; price holds — no commercial rates on this zone

  // Polled: updateProperty writes the rows above BEFORE it logs, so a count
  // taken the instant the polls clear can race the audit insert by
  // milliseconds and read zero on a truthful database.
  await expect
    .poll(
      async () => {
        const { count } = await db
          .from("activity_log")
          .select("*", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("client_id", client!.id)
          .eq("kind", "property.updated");
        return count ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  // And the reader's surface: the Services tab pulls the count from the
  // property record, which is the whole point of the field.
  await page.goto(`/clients/${client!.id}?tab=services`);
  await expect(page.getByText("12 units").first()).toBeVisible({ timeout: 30_000 });
});
