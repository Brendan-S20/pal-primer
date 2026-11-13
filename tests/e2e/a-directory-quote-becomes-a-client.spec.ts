// A quote from the directory is one lead, and Convert to client opens on it
// (#630, phase 1), against the real local stack: real Postgres, real RLS,
// the real /api/public/leads handler behind the dev server.
//
//   1. The OWNER publishes a profile through set_directory_profile on their
//      own signed-in client (the path the settings page takes).
//   2. A visitor (the publishable key, nobody signed in) finds it with
//      directory_search, and cannot read the table itself.
//   3. The quote is POSTed the way the quote page posts it. Exactly one
//      `leads` row with source = 'directory' lands, and a repeat within 24
//      hours does not make a second.
//   4. Signed in as the owner, Convert to client opens the new-client wizard
//      with the lead's name already in it.
//
// Everything it writes is taken out again in `finally`.

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER, signIn } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const SLUG = "e2e-directory-yard";
// A ZIP the seeded org's "Downtown Core" zone lists (seed_demo_org, 20261004010000).
// Since 20261112020000 directory_search drops a business whose zones say
// "outside", and the seeded zones do not reach downtown Detroit's 48201.
const ZIP = "48067";

test("a directory quote is one lead, and Convert to client opens on it", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const email = `directory-${Date.now()}@example.test`;

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
      _display_name: "E2E Directory Yard",
      _bio: "We scoop.",
      _show_logo: false,
      _coverage_zips: [ZIP],
      _coverage_cities: ["Detroit"],
      _services: [{ service_id: svc!.id, price_from_cents: 1500 }],
      _published: true,
    });
    expect(pubErr?.message ?? null, "the owner publishes").toBeNull();

    const visitor = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { data: line } = await db
      .from("directory_profiles")
      .select("service_lines")
      .eq("organization_id", orgId)
      .single();
    const { data: found, error: searchErr } = await visitor.rpc("directory_search", {
      _service_line: (line!.service_lines as string[])[0],
      _zip: ZIP,
    });
    expect(searchErr?.message ?? null).toBeNull();
    expect((found as Array<{ slug: string }>).map((r) => r.slug)).toContain(SLUG);
    expect(Object.keys((found as Array<Record<string, unknown>>)[0])).not.toContain(
      "organization_id",
    );
    const direct = await visitor.from("directory_profiles").select("slug");
    expect(direct.error, "a visitor cannot read the table itself").toBeTruthy();

    const body = {
      directory_slug: SLUG,
      name: "Directory Probe",
      email,
      phone: "",
      location: ZIP,
      message: "Asked about: Poop scooping.",
      source: "directory",
      website_url: "",
      elapsed_ms: 20_000,
    };
    const first = await request.post("/api/public/leads", { data: body });
    expect(first.status(), await first.text()).toBe(201);
    const second = await request.post("/api/public/leads", { data: body });
    expect(second.status(), await second.text()).toBe(200);

    const { data: leads } = await db
      .from("leads")
      .select("id, source, status, name")
      .eq("organization_id", orgId)
      .eq("email", email);
    expect(leads, "exactly one directory lead").toHaveLength(1);
    expect(leads![0]).toMatchObject({ source: "directory", status: "new" });

    await signIn(page);
    await page.goto(`/clients/new?fromLead=${leads![0].id}`);
    await expect(page.locator("#dn")).toHaveValue("Directory Probe", { timeout: 30_000 });
  } finally {
    await db.from("leads").delete().eq("organization_id", orgId).eq("email", email);
    await db.from("directory_profiles").delete().eq("organization_id", orgId);
    await owner.auth.signOut();
  }
});
