// QA: "Platform: edit a plan (monthly + annual price fields) ..."
//
// ── WHY THE ADMIN GRANT LIVES IN THIS FILE AND NOWHERE ELSE ───────────────
//
// is_platform_admin is one row in platform_admins, and granting it to the
// seeded owner is one service-role insert — but auth.tsx routes platform
// admins to /platform UNCONDITIONALLY at sign-in ("never inside a tenant
// dashboard"), so a grant in seed.mjs would hijack every other spec's
// signIn(). The row is created here, used here, and removed in a finally
// that also runs when the assertions in between have already failed —
// leaving it behind would break every spec file that sorts after this one.
//
// The edit itself is Stripe-free: updatePlatformPlan writes platform_plans
// and a platform_admin_audit row. The Stripe mirror is a SEPARATE button
// this spec must never press.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { serviceDb } from "./service-db";
import { OWNER, signIn } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

test("a plan takes a monthly and an annual price, and the audit trail says who", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const db = serviceDb();
  const { data: users, error: usersErr } = await db.auth.admin.listUsers({ perPage: 200 });
  if (usersErr) throw new Error(`listUsers: ${usersErr.message}`);
  const owner = users.users.find((u) => u.email === OWNER.email);
  expect(owner, "the seeded owner exists").toBeTruthy();

  const { data: plan, error: planErr } = await db
    .from("platform_plans")
    .select("id, price_cents, annual_price_cents, interval")
    .eq("name", "Launch")
    .single();
  if (planErr) throw new Error(`the Launch plan: ${planErr.message}`);

  // Values are relative to what the catalog holds, and everything is put
  // back in the finally — the plans catalog is shared state every billing
  // surface reads, not this spec's sandbox.
  const newBase = (plan.price_cents ?? 7900) + 100;
  const newAnnual = (plan.annual_price_cents ?? plan.price_cents * 10) + 1000;

  await db.from("platform_admins").delete().eq("user_id", owner!.id);
  const { error: grantErr } = await db.from("platform_admins").insert({ user_id: owner!.id });
  if (grantErr) throw new Error(`granting platform admin: ${grantErr.message}`);

  try {
    // A platform admin's sign-in LANDS on /platform — that redirect is
    // itself the first assertion.
    await signIn(page);
    await expect(page).toHaveURL(/\/platform/, { timeout: 20_000 });

    await page.goto("/platform/plans");
    await page.getByRole("button", { name: "Edit Launch" }).click();

    // The price labels carry no htmlFor, so each input is the one that
    // follows its label in document order.
    const base = page
      .getByText("Base price ($/month)", { exact: true })
      .locator("xpath=following::input[1]");
    await expect(base).toBeVisible({ timeout: 20_000 });
    await base.fill((newBase / 100).toFixed(2));

    // The annual field only exists once the interval says Annual — the
    // QA item's "monthly + annual price fields" is this dependency.
    await page.locator("#plan-billing-interval").selectOption({ label: "Annual" });
    const annual = page
      .getByText("Annual price ($/year)", { exact: true })
      .locator("xpath=following::input[1]");
    await expect(annual).toBeVisible();
    await annual.fill((newAnnual / 100).toFixed(2));

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Plan updated")).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const { data } = await db
            .from("platform_plans")
            .select("price_cents, annual_price_cents, interval")
            .eq("id", plan.id)
            .single();
          return `${data?.price_cents}|${data?.annual_price_cents}|${data?.interval}`;
        },
        { timeout: 20_000 },
      )
      .toBe(`${newBase}|${newAnnual}|year`);

    const { count } = await db
      .from("platform_admin_audit")
      .select("*", { count: "exact", head: true })
      .eq("action", "update_plan");
    expect(count ?? 0).toBeGreaterThan(0);
  } finally {
    // Both restorations matter even when the test failed halfway: the admin
    // row would reroute every later spec's sign-in, and the plan prices are
    // what every tenant-facing billing surface quotes.
    await db
      .from("platform_plans")
      .update({
        price_cents: plan.price_cents,
        annual_price_cents: plan.annual_price_cents,
        interval: plan.interval,
      })
      .eq("id", plan.id);
    await db.from("platform_admins").delete().eq("user_id", owner!.id);
  }
});
