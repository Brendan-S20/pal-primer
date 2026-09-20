// QA: "Pricing drift (/pricing-drift). Confirm a client priced off-card
// appears, and that fixing the price clears them."
//
// The page itself changes nothing — its own subtitle says so — which is why
// this is a two-surface round trip: the drift is READ on /pricing-drift, and
// the FIX is written on the client's Services tab, where updateSubscription
// stamps price_overridden_at and logs service.price_changed. "Clears them"
// gets its honest meaning here: on the default (all) filter the row STAYS and
// its badge flips to "On the card" with a "By hand" mark; what empties is the
// "Below the card" group. The spec asserts that version, because it is the
// one the page actually implements.
//
// Seeded drift: Riverside HOA pays $95.00 twice-weekly against a per-sqft
// Westside Suburb card that works out to roughly ten times that — the same
// gap the client header warns about ("90% below the ... zone baseline").
// The card price depends on the org's frequency multipliers, so it is READ
// OFF THE PAGE rather than recomputed here; a fixture is not a rate engine.

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

test("Riverside HOA is below the card until its price is fixed, and the fix sticks", async ({
  page,
}) => {
  test.setTimeout(240_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  // Own the drift. A previous run of this spec fixed the price, so put the
  // seeded state back: $95.00, never hand-priced. Idempotence lives here
  // rather than in hoping the seed ran more recently than the last run.
  const { data: client } = await db
    .from("clients")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", "Riverside HOA")
    .single();
  expect(client, "the seeded commercial client").toBeTruthy();

  const { data: sub, error: subErr } = await db
    .from("subscriptions")
    .select("id")
    .eq("client_id", client!.id)
    .eq("status", "active")
    .single();
  if (subErr) throw new Error(`Riverside's subscription: ${subErr.message}`);
  await db
    .from("subscriptions")
    .update({ price_cents: 9500, price_overridden_at: null })
    .eq("id", sub.id);

  await signIn(page);

  // ── The drift is visible, and the card price is what the page says ──────
  await page.goto("/pricing-drift");
  await expect(page.getByText("Who is off the rate card")).toBeVisible({ timeout: 30_000 });
  // The comparison walks every active service; on a loaded machine the
  // "Working it out." card outlives a polite timeout.
  await expect(page.getByText("Working it out.")).not.toBeVisible({ timeout: 90_000 });

  const row = page.getByRole("row").filter({ hasText: "Riverside HOA" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText("Below the card")).toBeVisible();

  const belowStat = page.getByRole("button", { name: /Below the card/ });
  const belowBefore = Number(/\d+/.exec((await belowStat.innerText()).trim())?.[0] ?? NaN);
  expect(belowBefore).toBeGreaterThan(0);

  // "Card today", read off the row: the 5th cell (Client, Zone, Frequency,
  // Pays, Card today). Currency-formatted; strip to cents.
  const cardText = await row.getByRole("cell").nth(4).innerText();
  const cardDollars = Number(cardText.replace(/[^0-9.]/g, ""));
  expect(cardDollars, `a readable card price (got "${cardText}")`).toBeGreaterThan(0);

  // ── The fix, through the drawer's own deep link ──────────────────────────
  //
  // ?editService is the route's purpose-built entry (validateSearch strips it
  // after opening), which spares this spec from disambiguating the page's
  // several Edit buttons.
  await page.goto(`/clients/${client!.id}?tab=services&editService=${sub.id}`);
  await expect(page.getByText("Edit service")).toBeVisible({ timeout: 30_000 });

  const price = page.getByLabel("Price ($ per visit)");
  await price.fill(cardDollars.toFixed(2));
  await page.getByRole("button", { name: "Save changes" }).click();

  // Jumping from $95 to the card trips the big-deviation guard — a dialog is
  // the product working, not the test failing.
  const keep = page.getByRole("button", { name: "Keep price" });
  if (await keep.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await keep.click();
  }
  await expect(page.getByText("Service saved")).toBeVisible({ timeout: 30_000 });

  // ── Postgres agrees about the price, the override, and the paper trail ──
  await expect
    .poll(
      async () => {
        const { data } = await db
          .from("subscriptions")
          .select("price_cents, price_overridden_at")
          .eq("id", sub.id)
          .single();
        return data?.price_overridden_at ? data.price_cents : null;
      },
      { timeout: 20_000 },
    )
    .toBe(Math.round(cardDollars * 100));

  const { count: activityCount } = await db
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("kind", "service.price_changed");
  expect(activityCount ?? 0).toBeGreaterThan(0);

  // ── And the drift page reads the new truth after a full reload ──────────
  await page.goto("/pricing-drift");
  await expect(page.getByText("Who is off the rate card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Working it out.")).not.toBeVisible({ timeout: 90_000 });
  const rowAfter = page.getByRole("row").filter({ hasText: "Riverside HOA" }).first();
  await expect(rowAfter.getByText("On the card")).toBeVisible({ timeout: 30_000 });
  // exact: the provenance cell beside the badge reads "Set by hand on …".
  await expect(rowAfter.getByText("By hand", { exact: true })).toBeVisible();

  const belowAfter = Number(
    /\d+/.exec(
      (await page.getByRole("button", { name: /Below the card/ }).innerText()).trim(),
    )?.[0] ?? NaN,
  );
  expect(belowAfter).toBe(belowBefore - 1);
});
