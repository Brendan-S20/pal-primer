// QA: "Settings: scheduling, client portal, online signup, franchise. For
// each: change one value, refresh, confirm it stuck." Scheduling is covered
// by a-setting-survives-a-refresh; these are the other three — with an
// honest substitution for the fourth.
//
// FRANCHISE IS DELIBERATELY NOT HERE. For the seeded solo org that page
// renders exactly one writable thing: the "Join a franchise" form, which the
// QA list itself flags as "the one with consequences". Joining would turn the
// fixture into a franchise child and change what half the other surfaces
// mean. A settings screen whose only round trip is irreversible is verified
// by a person, on a disposable org — recorded here so the gap is a decision.
//
// In its place, the QA item this file DOES pick up is one the list filed
// under Routes: "set Work days ... and confirm it persists after refresh".
// The dispatch panel it names is stale — WorkDaysPicker's only remaining home
// is /settings/scheduling — so the round trip is asserted where the control
// actually lives.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { e2eOrgId, serviceDb } from "./service-db";
import { signIn, waitForHydration } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

async function orgRow(orgId: string) {
  const db = serviceDb();
  const { data, error } = await db
    .from("organizations")
    .select("public_signup_enabled, portal_reschedule_cutoff_hours, work_days, contact_address")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(`reading the org row: ${error.message}`);
  return data;
}

test("online signup: the switch flips, survives a refresh, and lands in Postgres", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const orgId = await e2eOrgId(serviceDb());
  const before = Boolean((await orgRow(orgId)).public_signup_enabled);

  await signIn(page);
  await page.goto("/settings/online-signup");

  const toggle = page.getByLabel("Accept signups online");
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  // The switch is server-rendered, so it is visible before React attaches its
  // handler, and a click in that gap does nothing. On a loaded runner the gap
  // is long enough to land in: twice on 2026-10-09/10 (#378, #358) the page
  // snapshot showed the switch still off and no toast. Wait for the fiber, as
  // signIn does for /auth.
  await waitForHydration(page, "#public-signup");
  await toggle.click();

  // exact: turning signup on for an org with no web address also draws an
  // amber panel beginning with the same words.
  await expect(
    page.getByText(before ? "Online signup is off" : "Online signup is on", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => Boolean((await orgRow(orgId)).public_signup_enabled), { timeout: 20_000 })
    .toBe(!before);

  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", String(!before), { timeout: 30_000 });

  // Put it back: this spec is about the round trip, not about what the org
  // offers, and the signup surface gates real routes.
  await toggle.click();
  await expect
    .poll(async () => Boolean((await orgRow(orgId)).public_signup_enabled), { timeout: 20_000 })
    .toBe(before);
});

test("client portal: the reschedule cutoff saves, survives a refresh, and geocodes nothing", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  // "Save portal settings" always resubmits the contact address, and a
  // NON-EMPTY address is geocoded server-side against live Nominatim — the
  // one external call this suite refuses to make. Guaranteeing the column is
  // empty keeps the save local (updateOrgBranding only geocodes inside
  // `if (data.contactAddress)`), and doubles as the assertion that nothing
  // in the fixture drifted into making this spec network-dependent.
  await db.from("organizations").update({ contact_address: null }).eq("id", orgId);

  const before = (await orgRow(orgId)).portal_reschedule_cutoff_hours ?? 18;
  const next = before === 24 ? 12 : 24;

  await signIn(page);
  await page.goto("/settings/client-portal");

  // The branding card renders its defaults BEFORE its query answers and only
  // effect-syncs afterwards — a premature edit gets stomped. The business
  // name is "" until hydration, so a non-empty value is the hydration signal.
  await expect
    .poll(async () => (await page.getByPlaceholder("Acme Pet Waste Removal").inputValue()).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);

  const cutoff = page.locator('input[type="number"][max="168"]');
  await cutoff.fill(String(next));
  await page.getByRole("button", { name: "Save portal settings" }).click();
  await expect(page.getByText("Business details saved")).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(async () => (await orgRow(orgId)).portal_reschedule_cutoff_hours, { timeout: 20_000 })
    .toBe(next);

  await page.reload();
  await expect
    .poll(async () => (await page.getByPlaceholder("Acme Pet Waste Removal").inputValue()).length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect(cutoff).toHaveValue(String(next));

  // And the address really did stay empty — the save wrote no geocode.
  expect((await orgRow(orgId)).contact_address ?? null).toBeNull();
});

test("work days: toggling Saturday persists to the org and back onto the pills", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const orgId = await e2eOrgId(serviceDb());
  const before: number[] = (await orgRow(orgId)).work_days ?? [0, 1, 2, 3, 4, 5, 6];
  const hadSaturday = before.includes(6);

  await signIn(page);
  await page.goto("/settings/scheduling");
  await expect(page.getByText("How far ahead the schedule is built")).toBeVisible({
    timeout: 30_000,
  });

  const sat = page.getByRole("button", { name: "Sat", exact: true });
  await expect(sat).toHaveAttribute("aria-pressed", String(hadSaturday));
  await sat.click();
  await expect(page.getByText("Scheduling settings saved").first()).toBeVisible({
    timeout: 20_000,
  });

  await expect
    .poll(async () => ((await orgRow(orgId)).work_days ?? []).includes(6), { timeout: 20_000 })
    .toBe(!hadSaturday);

  await page.reload();
  await expect(page.getByText("How far ahead the schedule is built")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Sat", exact: true })).toHaveAttribute(
    "aria-pressed",
    String(!hadSaturday),
  );

  // Restore: the visit generator reads this array, and a fixture that lost
  // its Saturdays would quietly reshape every later schedule assertion.
  await page.getByRole("button", { name: "Sat", exact: true }).click();
  await expect
    .poll(async () => ((await orgRow(orgId)).work_days ?? []).includes(6), { timeout: 20_000 })
    .toBe(hadSaturday);
});
