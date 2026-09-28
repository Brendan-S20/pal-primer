// The owner creates a client and a property, and gets each row back.
//
// From 2026-08-10 until this spec landed, they could not. createClient and
// onboardClient insert as the signed-in user and ask for the row back
// (`.insert(...).select(...)`, i.e. INSERT ... RETURNING), and RETURNING has
// to pass the table's SELECT policy. That policy was `may_read_client(id)`, a
// STABLE helper that re-read public.clients from the snapshot taken before
// the insert, so it never found the row being created: "new row violates
// row-level security policy for table clients", for the owner, on the most
// basic action in the product. properties had the same shape. Production
// shows no client created by hand in the seven weeks after the policy split.
//
// No spec had ever created a client the way the app does, which is how it
// shipped. This one does, through the same client library and the same
// insert-then-select call, as the owner, against a database built from the
// migrations. (That the fix kept techs off off-route customers was checked
// when it landed; the seeded CI tenant has no tech-role login to repeat it.)

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

test("an owner's new client and property come back from the insert", async () => {
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signInErr } = await owner.auth.signInWithPassword(OWNER);
  if (signInErr) throw new Error(`owner sign-in: ${signInErr.message}`);

  const name = `Read-back probe ${Date.now()}`;
  try {
    const client = await owner
      .from("clients")
      .insert({ organization_id: orgId, account_type: "residential", display_name: name })
      .select("id, portal_token")
      .single();
    expect(client.error?.message ?? null, "insert ... returning on clients").toBeNull();
    expect(client.data?.id).toBeTruthy();

    const property = await owner
      .from("properties")
      .insert({
        organization_id: orgId,
        client_id: client.data!.id,
        street: "1 Read-back Ln",
        city: "New York",
        postal_code: "10001",
      })
      .select("id")
      .single();
    expect(property.error?.message ?? null, "insert ... returning on properties").toBeNull();
    expect(property.data?.id).toBeTruthy();
  } finally {
    const { data: rows } = await db.from("clients").select("id").eq("display_name", name);
    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length) {
      await db.from("properties").delete().in("client_id", ids);
      await db.from("clients").delete().in("id", ids);
    }
  }
});
