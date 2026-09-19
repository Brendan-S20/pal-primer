// QA: "Settings: scheduling ... change one value, refresh, confirm it stuck."
//
// The canonical round-trip shape on the checklist, run against the settings
// screen with the most machinery behind it: /settings/scheduling saves every
// control on blur/change through update_org_dispatch_settings, a SECURITY
// DEFINER RPC with its own role check — so this also proves an owner clears
// that gate through the real sign-in, which no unit test of the RPC does.
//
// Two controls, because they save on different events and a page can get one
// right and the other wrong: the traffic select saves onChange, the days-ahead
// number input saves onBlur. Both new values are chosen relative to what the
// database currently holds — the page only writes when a value actually
// changed, and a spec that always writes 117 is a no-op on its second run.

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

async function orgSettings(orgId: string) {
  const db = serviceDb();
  const { data, error } = await db
    .from("organizations")
    .select("traffic_profile, auto_generate_days_ahead")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(`reading org settings: ${error.message}`);
  return data;
}

test("scheduling settings save on change and on blur, and a refresh agrees", async ({ page }) => {
  test.setTimeout(180_000);

  const orgId = await e2eOrgId(serviceDb());
  const before = await orgSettings(orgId);

  const nextTraffic = before.traffic_profile === "heavy" ? "light" : "heavy";
  const nextDays = (before.auto_generate_days_ahead ?? 90) === 117 ? 118 : 117;

  await signIn(page);
  await page.goto("/settings/scheduling");
  await expect(
    page.getByText("How far ahead the schedule is built"),
  ).toBeVisible({ timeout: 30_000 });

  // ── The select, which saves onChange ────────────────────────────────────
  //
  // Located by its own options rather than its label: the "Traffic profile"
  // Label carries no htmlFor, so getByLabel cannot bind to it.
  const traffic = page.locator('select:has(option[value="heavy"])');
  await traffic.selectOption(nextTraffic);
  await expect(page.getByText("Scheduling settings saved").first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await orgSettings(orgId)).traffic_profile, { timeout: 20_000 })
    .toBe(nextTraffic);

  // ── The number input, which saves onBlur ────────────────────────────────
  //
  // Located by its bounds (min 1, max 365) for the same no-htmlFor reason.
  const days = page.locator('input[type="number"][max="365"]');
  await days.fill(String(nextDays));
  await days.blur();
  await expect
    .poll(async () => (await orgSettings(orgId)).auto_generate_days_ahead, { timeout: 20_000 })
    .toBe(nextDays);

  // ── The refresh, which is the whole point ───────────────────────────────
  //
  // Both inputs are uncontrolled with defaultValue from the query, so what
  // they show after a reload is what came back out of Postgres — a page that
  // saved into the void would render its old defaults here.
  await page.reload();
  await expect(
    page.getByText("How far ahead the schedule is built"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('select:has(option[value="heavy"])')).toHaveValue(nextTraffic);
  await expect(page.locator('input[type="number"][max="365"]')).toHaveValue(String(nextDays));
});
