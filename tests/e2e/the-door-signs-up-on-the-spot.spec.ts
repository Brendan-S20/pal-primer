// Canvassing walk mode: pressing "Sign up" at a door starts a REAL signup.
//
// It used to flip the lead's status to converted and nothing else — a record
// of a signup with no way to happen, reported from the field as "if I click
// sign up, I should be able to sign them up then and there". The sheet now
// runs the same quote / details / card machine as /signup/{slug}, prefilled
// from the door.
//
// Two panels, two tests. With online signup OFF (the seeded org's default)
// the sheet says so and offers the status flip, which is the old behaviour
// surviving as the paper-signup fallback. With it ON the sheet holds the
// signup form prefilled from the door's address line. Payment is not driven
// here: the local org has no Stripe account, and the card step belongs to
// Stripe's test mode, which the owner QA list already tracks. What this spec
// pins is the wiring the field actually complained about — the button opens
// a flow instead of only writing a status.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { serviceDb, e2eOrgId } from "./service-db";
import { signIn } from "./sign-in";

const DOOR = "612 Maple St, Southfield, MI 48037";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

test("with online signup off, the sheet says so and the fallback still converts the door", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  // A clean queue: this spec owns the org's canvassing list for its run.
  await db.from("neighbor_leads").delete().eq("organization_id", orgId);
  const { error: insErr } = await db
    .from("neighbor_leads")
    .insert({ organization_id: orgId, address_line: DOOR, status: "new" });
  if (insErr) throw new Error(`inserting the door: ${insErr.message}`);

  // ESTABLISH off rather than assume it: the seeded default is off, but
  // three-more-settings-survive-a-refresh flips this very switch through the
  // UI, so a stack that has run the suite before arrives here with it on.
  const { data: before } = await db
    .from("organizations")
    .select("public_signup_enabled")
    .eq("id", orgId)
    .single();
  const { error: offErr } = await db
    .from("organizations")
    .update({ public_signup_enabled: false })
    .eq("id", orgId);
  if (offErr) throw new Error(`disabling signup: ${offErr.message}`);

  try {
    await signIn(page);
    await page.goto("/neighbors");

    await page.getByRole("button", { name: /Walk mode/ }).click();
    await expect(page.getByText(DOOR)).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await expect(page.getByText("Online signup is turned off")).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Mark signed up, office will finish it" }).click();

    // The door leaves the walk queue…
    await expect(page.getByText("No more doors in the queue.")).toBeVisible({ timeout: 20_000 });

    // …and Postgres agrees it converted.
    await expect
      .poll(async () => {
        const { data } = await db
          .from("neighbor_leads")
          .select("status")
          .eq("organization_id", orgId)
          .eq("address_line", DOOR)
          .single();
        return data?.status;
      })
      .toBe("converted");
  } finally {
    await db
      .from("organizations")
      .update({ public_signup_enabled: before?.public_signup_enabled ?? false })
      .eq("id", orgId);
    await db.from("neighbor_leads").delete().eq("organization_id", orgId);
  }
});

test("with online signup on, the sheet opens the signup flow prefilled from the door", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  await db.from("neighbor_leads").delete().eq("organization_id", orgId);
  const { error: insErr } = await db
    .from("neighbor_leads")
    .insert({ organization_id: orgId, address_line: DOOR, status: "new" });
  if (insErr) throw new Error(`inserting the door: ${insErr.message}`);

  // Turn the org's public signup on for this test only. portal_slug rather
  // than slug, because getCanvassSignupTarget mirrors the lookup RPC's
  // preference order and this pins that they agree.
  //
  // And a connected Stripe account that can take a charge. Since the lead
  // form and the signup became one form (2026-10-08), the card is offered
  // only where it can actually be taken: getPublicSignupForm checks the
  // account first, so a business without one gets a quote request on the
  // public page and, here, a sheet that says so. Nothing in this test
  // reaches Stripe; the id only has to exist and be marked charge-ready.
  const { data: before } = await db
    .from("organizations")
    .select(
      "portal_slug, public_signup_enabled, stripe_connect_account_id, stripe_connect_charges_enabled",
    )
    .eq("id", orgId)
    .single();
  const { error: onErr } = await db
    .from("organizations")
    .update({
      portal_slug: "e2e-demo-yard",
      public_signup_enabled: true,
      stripe_connect_account_id: "acct_e2e_door_signup",
      stripe_connect_charges_enabled: true,
    } as any)
    .eq("id", orgId);
  if (onErr) throw new Error(`enabling signup: ${onErr.message}`);

  try {
    await signIn(page);
    await page.goto("/neighbors");

    await page.getByRole("button", { name: /Walk mode/ }).click();
    await expect(page.getByText(DOOR)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Sign up", exact: true }).click();

    // The real flow, prefilled from the door: the quote step's ZIP and the
    // details step's address arrive split from the one-line address.
    await expect(page.locator("#postal_code")).toHaveValue("48037", { timeout: 20_000 });
    await expect(page.locator("#street")).toHaveValue("612 Maple St");
    await expect(page.locator("#city")).toHaveValue("Southfield");
    await expect(page.locator("#region")).toHaveValue("MI");
    await expect(page.getByRole("button", { name: "Get instant price" })).toBeVisible();

    // The paper-signup escape rides along under the form.
    await expect(
      page.getByRole("button", { name: "They signed up another way, just mark the door" }),
    ).toBeVisible();
  } finally {
    await db
      .from("organizations")
      .update({
        portal_slug: before?.portal_slug ?? null,
        public_signup_enabled: before?.public_signup_enabled ?? false,
        stripe_connect_account_id: (before as any)?.stripe_connect_account_id ?? null,
        stripe_connect_charges_enabled: (before as any)?.stripe_connect_charges_enabled ?? false,
      } as any)
      .eq("id", orgId);
    await db.from("neighbor_leads").delete().eq("organization_id", orgId);
  }
});
