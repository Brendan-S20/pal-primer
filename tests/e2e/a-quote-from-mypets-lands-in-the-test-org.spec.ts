// A quote from the standalone directory app (mypets.services, #630) lands in
// the TEST org's leads, against the real local stack: real Postgres, real RLS,
// the real /api/public/directory/quotes handler behind the dev server.
//
// Only the e2e org seed.mjs builds (e2eOrgId), only a local database
// (serviceDb refuses anything else), and only made-up addresses on
// example.test. Nobody real is emailed and nothing reaches production.
//
//   1. The OWNER publishes a profile covering two ZIPs: 48067, which the
//      seeded "Downtown Core" zone lists, and 48201, which no seeded zone
//      reaches.
//   2. A visitor with the publishable key ONLY (what mypets holds) finds it
//      in 48067, does not find it in 48201 (its zones say "outside", and the
//      database now drops that itself), lists it through
//      directory_public_listings with exactly the public fields, and cannot
//      read the tables under the view.
//   3. The quote is POSTed the way the mypets form will: Origin
//      https://mypets.services, directory_slug, an empty website_url,
//      elapsed_ms >= 3000. The Origin is echoed back, and exactly one leads
//      row with source = 'directory' lands on the test org, with the ZIP as
//      its location. A quoted ZIP is refused and writes nothing; a page on any
//      other origin is refused before the body is read.
//
// Everything it writes is taken out again in `finally`.

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SLUG = "e2e-mypets-yard";
const SERVED = "48067";
const OUTSIDE = "48201";
const MYPETS = "https://mypets.services";
// PUBLIC_LISTING_FIELDS in lib/directory.ts, sorted: the view's columns and
// nothing more (20261112090000 added tagline, highlights and areas;
// 20261112100000 books_online, booking_policy_text and book_path).
// tests/a-directory-profile-says-what-a-business-is-and-where.test.ts holds
// this list to that one.
const PUBLIC_FIELDS = [
  "areas",
  "bio",
  "book_path",
  "booking_policy_text",
  "books_online",
  "coverage_cities",
  "coverage_zips",
  "display_name",
  "highlights",
  "logo_url",
  "published_at",
  "service_lines",
  "services",
  "slug",
  "tagline",
];

test("a quote from mypets.services is one directory lead on the test org", async ({ request }) => {
  test.setTimeout(120_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const email = `mypets-${Date.now()}@example.test`;

  const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await owner.auth.signInWithPassword(OWNER);
  if (signInErr) throw new Error(`owner sign-in: ${signInErr.message}`);

  try {
    const { data: svc } = await db
      .from("services")
      .select("id")
      .eq("organization_id", orgId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    expect(svc?.id, "the seeded org sells something to list").toBeTruthy();

    const { error: pubErr } = await owner.rpc("set_directory_profile", {
      _org: orgId,
      _slug: SLUG,
      _display_name: "E2E Mypets Yard",
      _bio: "We scoop.",
      _show_logo: false,
      _coverage_zips: [SERVED, OUTSIDE],
      _coverage_cities: ["Royal Oak", "Detroit"],
      _services: [{ service_id: svc!.id, price_from_cents: 1500 }],
      _published: true,
    });
    expect(pubErr?.message ?? null, "the owner publishes").toBeNull();

    // ── What mypets can read with the publishable key alone ────────────────
    const visitor = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { data: profile } = await db
      .from("directory_profiles")
      .select("service_lines")
      .eq("organization_id", orgId)
      .single();
    const line = (profile!.service_lines as string[])[0];

    const served = await visitor.rpc("directory_search", { _service_line: line, _zip: SERVED });
    expect(served.error?.message ?? null).toBeNull();
    expect((served.data as Array<{ slug: string }>).map((r) => r.slug)).toContain(SLUG);

    const outside = await visitor.rpc("directory_search", { _service_line: line, _zip: OUTSIDE });
    expect(outside.error?.message ?? null).toBeNull();
    expect(
      (outside.data as Array<{ slug: string }>).map((r) => r.slug),
      "the seeded zones say 48201 is outside, so the database drops the listing",
    ).not.toContain(SLUG);

    const listed = await visitor.from("directory_public_listings").select("*").eq("slug", SLUG);
    expect(listed.error?.message ?? null).toBeNull();
    expect(listed.data).toHaveLength(1);
    const row = listed.data![0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(PUBLIC_FIELDS);
    // PUBLIC_SERVICE_FIELDS, sorted (20261112100000 added booking_mode,
    // booking_key and package). Switched off by default, so request_only.
    const svc0 = (row.services as Array<Record<string, unknown>>)[0];
    expect(Object.keys(svc0).sort()).toEqual([
      "booking_key",
      "booking_mode",
      "label",
      "package",
      "price_from_cents",
      "price_unit",
      "service_line",
    ]);
    expect(svc0.booking_mode).toBe("request_only");
    expect(row.books_online).toBe(false);
    expect(JSON.stringify(row)).not.toContain(orgId);

    for (const table of ["directory_profiles", "directory_profile_services", "directory_reviews"]) {
      const direct = await visitor.from(table).select("*").limit(1);
      expect(direct.error, `a visitor cannot read ${table} itself`).toBeTruthy();
    }
    const lookup = await visitor.rpc("directory_org_for_quote", { _slug: SLUG });
    expect(lookup.error, "a visitor cannot turn a slug into an org id").toBeTruthy();

    // ── The quote, the way the mypets form posts it ────────────────────────
    const body = {
      directory_slug: SLUG,
      name: "Mypets Probe",
      email,
      phone: "",
      location: SERVED,
      message: "Asked about: Pet waste removal.\n\nSent from mypets.services.",
      source: "directory",
      website_url: "",
      elapsed_ms: 4_000,
    };

    const preflight = await request.fetch("/api/public/directory/quotes", {
      method: "OPTIONS",
      headers: { Origin: MYPETS, "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()["access-control-allow-origin"]).toBe(MYPETS);

    const elsewhere = await request.post("/api/public/directory/quotes", {
      data: body,
      headers: { Origin: "https://tenant-site.example" },
    });
    expect(elsewhere.status(), await elsewhere.text()).toBe(403);

    const quoted = await request.post("/api/public/directory/quotes", {
      data: { ...body, location: '"48067"' },
      headers: { Origin: MYPETS },
    });
    expect(quoted.status(), await quoted.text()).toBe(400);

    const first = await request.post("/api/public/directory/quotes", {
      data: body,
      headers: { Origin: MYPETS },
    });
    expect(first.status(), await first.text()).toBe(201);
    expect(first.headers()["access-control-allow-origin"]).toBe(MYPETS);

    const { data: leads } = await db
      .from("leads")
      .select("id, organization_id, source, status, name, location")
      .eq("email", email);
    expect(leads, "exactly one lead, on the test org").toHaveLength(1);
    expect(leads![0]).toMatchObject({
      organization_id: orgId,
      source: "directory",
      status: "new",
      name: "Mypets Probe",
      location: SERVED,
    });
  } finally {
    await db.from("leads").delete().eq("organization_id", orgId).eq("email", email);
    await db.from("directory_profiles").delete().eq("organization_id", orgId);
    await owner.auth.signOut();
  }
});
