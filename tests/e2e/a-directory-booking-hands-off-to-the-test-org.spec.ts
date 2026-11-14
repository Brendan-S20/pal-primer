// A directory booking hands off to the TEST org's own booking link (#630;
// mypets v2 step 7), against the real local stack: real Postgres, real RLS,
// the real /d/{slug}/book route and /signup/{slug} page behind the dev server.
//
// Only the e2e org seed.mjs builds (e2eOrgId), only a local database
// (serviceDb refuses anything else), only made-up addresses on example.test,
// and every service it lists is a labelled "(TEST)" one it makes itself.
// Nobody real is emailed, nothing is charged, and nothing reaches production.
// Everything it writes or changes is put back in `finally`.
//
//   1. The OWNER publishes a profile listing two TEST services: a recurring
//      walk and a request-only meet and greet.
//   2. Switch OFF (the default): the listing says request_only for both and
//      books_online false; /d/{slug}/book for the walk lands on the booking
//      link with ref and the ZIP but WITHOUT book=1, and the page there is the
//      quote request (no instant price, no card). A quote sent from it is ONE
//      lead with source directory_booking, which Leads labels "Directory
//      booking, asked for a quote". The quote request starts on the walk the
//      listing named, in the server's HTML and after hydration (#929).
//   3. The owner turns "Show Book online" on in Settings, with a policy, and
//      Save writes both (the database says so). With public signup and
//      Stripe charges also on, the walk is recurring and books_online true;
//      its hand-off carries book=1 and the page offers the instant price. The
//      request-only service still hands off without book=1.
//   4. A listing that is not published answers with a page, not a charge.

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER, signIn, waitForHydration } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SLUG = "e2e-directory-booking";
const PORTAL = "e2e-directory-booking-portal";
const ZIP = "48067";
const REF = "mypets";
const POLICY = "Cancel 24 hours ahead for a full refund. TEST policy.";

type ListedService = { label: string; booking_mode: string; booking_key: string };

test("a directory booking hands off to the test org, and only books online when the owner says so", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const email = `directory-booking-${Date.now()}@example.test`;

  const { data: before, error: beforeErr } = await db
    .from("organizations")
    .select(
      "portal_slug, public_signup_enabled, stripe_connect_charges_enabled, stripe_connect_account_id, directory_booking_enabled, booking_policy_text",
    )
    .eq("id", orgId)
    .single();
  if (beforeErr) throw new Error(`reading the org: ${beforeErr.message}`);
  expect(before!.directory_booking_enabled, "off by default on the test org").toBe(false);

  const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await owner.auth.signInWithPassword(OWNER);
  if (signInErr) throw new Error(`owner sign-in: ${signInErr.message}`);

  const made: string[] = [];
  try {
    await db.from("organizations").update({ portal_slug: PORTAL }).eq("id", orgId);
    const { data: svcs, error: svcErr } = await db
      .from("services")
      .insert([
        {
          organization_id: orgId,
          name: "Booking walk (TEST)",
          service_line: "dog_walking",
          price_unit: "visit",
          base_price_cents: 2500,
          extra_pet_cents: 0,
          default_duration_min: 30,
          active: true,
          public_booking_mode: "recurring",
        },
        {
          organization_id: orgId,
          name: "Meet and greet (TEST)",
          service_line: "dog_walking",
          price_unit: "visit",
          base_price_cents: 1000,
          extra_pet_cents: 0,
          default_duration_min: 30,
          active: true,
          public_booking_mode: "request_only",
        },
      ])
      .select("id, name");
    if (svcErr) throw new Error(`making the TEST services: ${svcErr.message}`);
    made.push(...svcs!.map((s) => s.id as string));
    const walkId = svcs!.find((s) => s.name.startsWith("Booking walk"))!.id as string;
    const meetId = svcs!.find((s) => s.name.startsWith("Meet and greet"))!.id as string;

    const { error: pubErr } = await owner.rpc("set_directory_profile", {
      _org: orgId,
      _slug: SLUG,
      _display_name: "E2E Directory Booking (TEST)",
      _bio: "A test listing.",
      _show_logo: false,
      _coverage_zips: [ZIP],
      _coverage_cities: ["Royal Oak"],
      _services: [
        { service_id: walkId, price_from_cents: 2500 },
        { service_id: meetId, price_from_cents: null },
      ],
      _published: true,
    });
    expect(pubErr?.message ?? null, "the owner publishes").toBeNull();

    const visitor = createClient(URL_, ANON, { auth: { persistSession: false } });
    const listing = async () => {
      const { data, error } = await visitor
        .from("directory_public_listings")
        .select("*")
        .eq("slug", SLUG)
        .single();
      expect(error?.message ?? null).toBeNull();
      return data as Record<string, unknown> & { services: ListedService[] };
    };
    const handOff = async (key: string) => {
      const res = await request.get(`/d/${SLUG}/book?service=${key}&zip=${ZIP}`, {
        maxRedirects: 0,
      });
      expect(res.status(), await res.text()).toBe(302);
      return new URL(res.headers()["location"], "http://x.test");
    };

    // ── 2. Switch off: request only everywhere, and the hand-off asks ───────
    let row = await listing();
    expect(row.books_online).toBe(false);
    expect(row.book_path).toBeNull();
    expect(row.services.map((s) => s.booking_mode)).toEqual(["request_only", "request_only"]);
    expect(JSON.stringify(row)).not.toContain(orgId);
    expect(JSON.stringify(row)).not.toContain(walkId);
    expect(JSON.stringify(row)).not.toContain(PORTAL);
    const walkKey = row.services.find((s) => s.label.startsWith("Booking walk"))!.booking_key;
    const meetKey = row.services.find((s) => s.label.startsWith("Meet and greet"))!.booking_key;
    expect(walkKey).toMatch(/^[0-9a-f]{12}$/);

    const off = await handOff(walkKey);
    expect(off.pathname).toBe(`/signup/${PORTAL}`);
    expect(off.searchParams.get("ref")).toBe(REF);
    expect(off.searchParams.get("service")).toBe(walkId);
    expect(off.searchParams.get("zip")).toBe(ZIP);
    expect(off.searchParams.has("book"), "switch off: no book=1").toBe(false);

    // The server's own HTML, before any script runs, already names the
    // service in "What would you like?" (#929). Read as text so nothing can
    // hydrate first and fill it in.
    const firstPaint = await (await request.get(`${off.pathname}${off.search}`)).text();
    expect(firstPaint).toMatch(/id="service"[^>]*>[\s\S]{0,400}?Booking walk \(TEST\)/);

    await page.goto(`${off.pathname}${off.search}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Request a quote", {
      timeout: 30_000,
    });
    await expect(page.locator("#postal_code")).toHaveValue(ZIP);
    // The quote fallback starts on the service the listing named too (#929),
    // in the server's first paint and after hydration: "What would you
    // like?" is never left blank.
    await expect(page.locator("#service")).toContainText("Booking walk (TEST)");
    await waitForHydration(page, "#service");
    await expect(page.locator("#service")).toContainText("Booking walk (TEST)", {
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: "Get instant price" })).toHaveCount(0);

    // The quote the page sends: one lead, tagged as a directory booking.
    const quote = await page.evaluate(
      async ({ slug, email, zip, serviceId }) => {
        const r = await fetch("/api/public/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            name: "Directory Booking Probe",
            email,
            phone: "",
            location: zip,
            dog_count: 1,
            frequency: "",
            message: "TEST quote from the directory hand-off.",
            source: "directory_booking",
            service_id: serviceId,
            website_url: "",
            elapsed_ms: 4_000,
          }),
        });
        return r.status;
      },
      { slug: PORTAL, email, zip: ZIP, serviceId: walkId },
    );
    expect(quote).toBeLessThan(300);
    const { data: leads } = await db
      .from("leads")
      .select("organization_id, source, status")
      .eq("email", email);
    expect(leads, "exactly one lead, on the test org").toHaveLength(1);
    expect(leads![0]).toMatchObject({
      organization_id: orgId,
      source: "directory_booking",
      status: "new",
    });

    // ── 3. The owner turns it on in Settings ───────────────────────────────
    await signIn(page);
    await page.goto("/settings/directory");
    const sw = page.getByRole("switch", { name: /Show Book online on/ });
    await expect(sw).toBeVisible({ timeout: 30_000 });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await page.getByLabel("Cancellation and refund policy").fill(POLICY);
    // The profile is published, so Save asks for the confirmation it already has.
    await page.getByRole("button", { name: /^Save/ }).click();
    await expect
      .poll(
        async () =>
          (
            await db
              .from("organizations")
              .select("directory_booking_enabled, booking_policy_text")
              .eq("id", orgId)
              .single()
          ).data,
        { timeout: 20_000 },
      )
      .toEqual({ directory_booking_enabled: true, booking_policy_text: POLICY });

    // The switch alone sells nothing.
    row = await listing();
    expect(row.books_online).toBe(false);
    expect(row.booking_policy_text).toBe(POLICY);

    // Public signup and Stripe charges on, as the platform would set them.
    const { error: gateErr } = await db
      .from("organizations")
      .update({
        public_signup_enabled: true,
        stripe_connect_charges_enabled: true,
        stripe_connect_account_id: before!.stripe_connect_account_id ?? "acct_e2e_directory_test",
      })
      .eq("id", orgId);
    if (gateErr) throw new Error(`turning the gates on: ${gateErr.message}`);

    row = await listing();
    expect(row.books_online).toBe(true);
    expect(row.book_path).toBe(`/d/${SLUG}/book`);
    expect(Object.fromEntries(row.services.map((s) => [s.label, s.booking_mode]))).toEqual({
      "Booking walk (TEST)": "recurring",
      "Meet and greet (TEST)": "request_only",
    });

    const on = await handOff(walkKey);
    expect(on.pathname).toBe(`/signup/${PORTAL}`);
    expect(on.searchParams.get("ref")).toBe(REF);
    expect(on.searchParams.get("book")).toBe("1");
    expect(await (await request.get(`${on.pathname}${on.search}`)).text()).toMatch(
      /id="service"[^>]*>[\s\S]{0,400}?Booking walk \(TEST\)/,
    );
    await page.goto(`${on.pathname}${on.search}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Get an instant quote", {
      timeout: 30_000,
    });
    await expect(page.locator("#postal_code")).toHaveValue(ZIP);
    // The service the listing named is the one picked.
    await waitForHydration(page, "#service");
    await expect(page.locator("#service")).toContainText("Booking walk (TEST)", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Get instant price" })).toBeVisible();

    // A request-only service does not become Book online.
    const meet = await handOff(meetKey);
    expect(meet.searchParams.get("service")).toBe(meetId);
    expect(meet.searchParams.has("book")).toBe(false);

    // ── 4. Not published: a page, not a charge ────────────────────────────
    const gone = await request.get(`/d/no-such-listing-e2e/book?service=${walkKey}`, {
      maxRedirects: 0,
    });
    expect(gone.status()).toBe(200);
    expect(await gone.text()).toContain("taking bookings here right now");
  } finally {
    await db.from("leads").delete().eq("organization_id", orgId).eq("email", email);
    await db.from("directory_profiles").delete().eq("organization_id", orgId);
    if (made.length) await db.from("services").delete().in("id", made);
    await db
      .from("organizations")
      .update({
        portal_slug: before?.portal_slug ?? null,
        public_signup_enabled: before?.public_signup_enabled ?? false,
        stripe_connect_charges_enabled: before?.stripe_connect_charges_enabled ?? false,
        stripe_connect_account_id: before?.stripe_connect_account_id ?? null,
      })
      .eq("id", orgId);
    // The switch and policy go back through the owner's own writer.
    await owner.rpc("set_directory_booking", {
      _org: orgId,
      _enabled: before?.directory_booking_enabled ?? false,
      _policy_text: before?.booking_policy_text ?? null,
    });
    await owner.auth.signOut();
  }
});
