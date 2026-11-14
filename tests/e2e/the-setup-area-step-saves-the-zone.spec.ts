// Guided setup, step 2 ("Your service area and price"), saved ONCE by a
// business that was made a minute ago (#881).
//
// ── WHAT THE TESTER SAW ───────────────────────────────────────────────────
//
// On a fresh signup (build 3a02850), Price per visit $20, Save and continue:
// no error, the step did not advance, the price field was empty again, and
// /zones said "No zones yet". Twice. A zone could only be made by hand on
// Zones -> New zone.
//
// Every earlier spec runs against the seeded "E2E Demo Yard", which already
// has zones, prices, a first-cleanup mode and twenty clients: the one state
// this step is never in. So this one makes its own business the way signup
// does -- an auth user, then `bootstrap_organization` called AS that user --
// and gives it only what step 1 leaves behind (an address with a pin). The
// unpriced "Pet waste removal" service is already there, made by the org
// insert's own trigger, and is read back rather than seeded. Then it drives
// step 2 in a browser and asks Postgres what it wrote.
//
// What it proves:
//   * ONE press of Save and continue creates exactly one zone for this
//     business and no other, and the step advances;
//   * the price typed ($20.00 -> 2000) is the pet-waste service's standard
//     price (services.base_price_cents) and the business's Standard price;
//   * the zone does NOT copy it. Under the shared price model (#860, PR #870)
//     a zone's base_price_cents is an OVERRIDE, and setup's first area gets
//     none when the typed price is the standard that results, so it is NULL.
//
// ── WHY THE ZONE ASSERTION READS THE SOURCE ───────────────────────────────
//
// The model lands with #870, which makes zones.base_price_cents nullable and
// teaches setup to send no override (setupZoneOverride in
// src/lib/standard-price.ts). Before it, the column is NOT NULL and setup
// sends the typed price, so the same Save stores 2000 on the zone. The
// assertion keys on whether setupZoneOverride exists in this checkout: with
// it, NULL and nothing else; without it, 2000 and nothing else. Either way
// the service holds the price. Once #870 is on main the first branch is the
// only one that runs, and this block can be reduced to it.
//
// And when it fails, it says why: every server-function response and every
// console error of the run is printed with the failure, because "nothing
// happened" is exactly the report this spec exists to turn into a cause.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { serviceDb } from "./service-db";
import { signIn, waitForHydration } from "./sign-in";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

/** Whether this checkout has the shared price model, in which setup's first
 *  area carries no price of its own (#870). See the header. */
// Playwright runs from the repo root (tests/e2e/run.sh cds there first).
const STANDARD_PRICE = join(process.cwd(), "src", "lib", "standard-price.ts");
const ZONE_PRICE_IS_AN_OVERRIDE =
  existsSync(STANDARD_PRICE) &&
  readFileSync(STANDARD_PRICE, "utf8").includes("export function setupZoneOverride");

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, { url: SUPABASE_URL, anonKey: ANON });
});

test("a new business saves its service area and price once, and the zone exists at that price", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const db = serviceDb();

  // ── A business made the way signup makes one ────────────────────────────
  const stamp = Date.now();
  const who = { email: `setup-area-${stamp}@e2e.houndstack.test`, password: `e2e-area-${stamp}` };
  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: who.email,
    password: who.password,
    email_confirm: true,
    user_metadata: { full_name: "Area Owner" },
  });
  if (userErr || !created.user) throw new Error(`createUser: ${userErr?.message}`);
  const userId = created.user.id;

  const asOwner = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signErr } = await asOwner.auth.signInWithPassword(who);
  if (signErr) throw new Error(`sign in as the new owner: ${signErr.message}`);
  const { data: orgId, error: bootErr } = await asOwner.rpc("bootstrap_organization", {
    _org_name: `Setup Area Yard ${stamp}`,
    _display_name: "Area Owner",
    _timezone: "America/Detroit",
  });
  if (bootErr || typeof orgId !== "string") {
    throw new Error(`bootstrap_organization: ${bootErr?.message ?? "no org id"}`);
  }

  try {
    // What step 1 leaves: an address with a pin, so step 2 centres the area on
    // it rather than asking a ZIP (which would need the geocoder, off-box).
    const { error: pinErr } = await db
      .from("organizations")
      .update({
        contact_address: "1 Woodward Ave, Detroit, MI 48226",
        latitude: 42.3293,
        longitude: -83.0454,
      })
      .eq("id", orgId);
    if (pinErr) throw new Error(`pinning the business address: ${pinErr.message}`);

    // The unpriced "Pet waste removal" service is already there: signup made
    // it (organizations_default_services -> ensure_default_services, on the
    // org insert bootstrap_organization does). Read it, rather than seed a
    // second one that the services_org_name unique index would refuse.
    const { data: starter, error: starterErr } = await db
      .from("services")
      .select("base_price_cents")
      .eq("organization_id", orgId)
      .eq("service_line", "pet_waste")
      .eq("name", "Pet waste removal")
      .single();
    if (starterErr) throw new Error(`reading the starter service: ${starterErr.message}`);
    expect(starter?.base_price_cents, "signup's pet-waste service starts unpriced").toBeNull();

    const { count: before } = await db
      .from("zones")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    expect(before, "a business made a minute ago has no zone").toBe(0);

    // ── The evidence a failure prints ─────────────────────────────────────
    const serverFns: string[] = [];
    const consoleErrors: string[] = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (!url.includes("/_serverFn/")) return;
      let name = url;
      try {
        const id = new URL(url).pathname.split("/_serverFn/")[1] ?? "";
        name = String(
          JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export,
        );
      } catch {
        /* the raw URL is the name */
      }
      let body = "";
      try {
        body = (await res.text()).slice(0, 400);
      } catch {
        body = "(no body)";
      }
      serverFns.push(`${res.status()} ${name.replace(/_createServerFn_handler$/, "")} ${body}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400));
    });
    const evidence = () =>
      `\nserver functions:\n  ${serverFns.join("\n  ") || "(none)"}\nconsole errors:\n  ${consoleErrors.join("\n  ") || "(none)"}`;

    // ── Step 2, in the browser ────────────────────────────────────────────
    await signIn(page, who);
    await page.goto("/setup?step=zones");
    await waitForHydration(page, "#setup-zone-price");
    await expect(page.locator('[data-setup-step="zones"]')).toBeVisible();

    const price = page.locator("#setup-zone-price");
    await price.fill("20");
    await page.locator("#setup-first-cleanup-off").click();

    const save = page.locator('[data-setup-action="save"]');
    await expect(save, "Save and continue is pressable once the prices load").toBeEnabled({
      timeout: 30_000,
    });
    await save.click();

    // Advanced: step 2 is no longer the step on screen.
    await expect(
      page.locator('[data-setup-step="zones"]'),
      `the step advanced after one Save${evidence()}`,
    ).toHaveCount(0, { timeout: 60_000 });

    // ── What Postgres says ─────────────────────────────────────────────────
    const { data: zones, error: zErr } = await db
      .from("zones")
      .select(
        "name, base_price_cents, per_dog_addl_cents, initial_cleanup_cents, geo_match_mode, radius_meters",
      )
      .eq("organization_id", orgId);
    if (zErr) throw new Error(`reading zones: ${zErr.message}`);
    expect(zones, `exactly one zone after one Save${evidence()}`).toHaveLength(1);
    expect(zones![0]).toMatchObject({
      name: "Main service area",
      initial_cleanup_cents: 0,
      geo_match_mode: "radius",
    });
    if (ZONE_PRICE_IS_AN_OVERRIDE) {
      expect(
        zones![0].base_price_cents,
        "the first area follows the standard price: no override of its own (#870)",
      ).toBeNull();
    } else {
      expect(zones![0].base_price_cents, "before #870 the zone carries the price").toBe(2000);
    }

    // The standard price lives on the pet-waste service.
    const { data: svc, error: svcReadErr } = await db
      .from("services")
      .select("base_price_cents")
      .eq("organization_id", orgId)
      .eq("service_line", "pet_waste")
      .eq("name", "Pet waste removal")
      .single();
    if (svcReadErr) throw new Error(`reading the pet-waste service: ${svcReadErr.message}`);
    expect(svc?.base_price_cents, "the typed price is the service's standard price").toBe(2000);

    const { data: org } = await db
      .from("organizations")
      .select("std_base_price_cents")
      .eq("id", orgId)
      .single();
    expect(org?.std_base_price_cents, "the same price is the Standard price (#766)").toBe(2000);
  } finally {
    // This business exists for this spec alone. Its rows go; the seeded org
    // the other specs read is never touched.
    for (const table of ["zones", "services", "staff", "user_roles"]) {
      await db.from(table).delete().eq("organization_id", orgId);
    }
    await db.from("organizations").delete().eq("id", orgId);
    await db.auth.admin.deleteUser(userId);
  }
});
