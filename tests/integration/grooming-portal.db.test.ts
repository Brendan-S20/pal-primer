// portal_request_groom and the vaccine rejection shape in a real database.
// While mobile grooming is not customer-requestable the function refuses
// every request and writes nothing; a business that does not groom gets
// nothing; the anon key cannot call it. A portal upload can be rejected only
// with a reason and never while verified.
// Skipped unless TEST_SUPABASE_* point at a local stack.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);
let admin: SupabaseClient;
const orgs: string[] = [];
const users: string[] = [];

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id;
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function tenant(lines: string[]) {
  const orgId = await insert("organizations", {
    name: `Groom portal ${runId}`,
    service_lines: lines,
    timezone: "UTC",
    work_days: [0, 1, 2, 3, 4, 5, 6],
  });
  orgs.push(orgId);
  const clientId = await insert("clients", {
    organization_id: orgId,
    display_name: "Portal client",
    account_type: "residential",
    active: true,
  });
  const { data: c } = await admin
    .from("clients")
    .select("portal_token")
    .eq("id", clientId)
    .single();
  const propertyId = await insert("properties", {
    organization_id: orgId,
    client_id: clientId,
    street: "1 Portal St",
    city: "Austin",
    postal_code: "78701",
  });
  const dogId = await insert("dogs", {
    organization_id: orgId,
    property_id: propertyId,
    name: "Biscuit",
    active: true,
  });
  const serviceId = await insert("services", {
    organization_id: orgId,
    name: `Groom ${runId}`,
    service_line: "mobile_grooming",
    price_unit: "visit",
    default_duration_min: 90,
    base_price_cents: 8000,
  });
  const addonId = await insert("addon_services", {
    organization_id: orgId,
    code: "TEETH",
    name: "Teeth brushing",
    unit_price_cents: 1500,
    duration_min: 10,
    service_line: "mobile_grooming",
  });
  return {
    orgId,
    clientId,
    token: c!.portal_token as string,
    propertyId,
    dogId,
    serviceId,
    addonId,
  };
}

describe.skipIf(!enabled)("a client asks for a groom in the database", () => {
  let t: Awaited<ReturnType<typeof tenant>>;
  let other: Awaited<ReturnType<typeof tenant>>;
  const day = addDays(new Date().toISOString().slice(0, 10), 5);

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    t = await tenant(["pet_waste", "mobile_grooming"]);
    other = await tenant(["pet_waste", "mobile_grooming"]);
  });

  const ask = (over: Record<string, unknown> = {}) =>
    admin.rpc("portal_request_groom", {
      _token: t.token,
      _dog_id: t.dogId,
      _service_id: t.serviceId,
      _addons: [{ addon_service_id: t.addonId, quantity: 1 }],
      _on: day,
      _from: "08:00",
      _until: "12:00",
      _message: "Short cut",
      _quoted_cents: 9500,
      _quoted_minutes: 115,
      ...over,
    });

  // Mobile grooming is not a line a customer may request, so the function
  // refuses every request from a business that runs it, before it reads a pet
  // or writes a row. The shape checks behind that refusal come back into
  // reach when customer requests open (a change to the function and to
  // customerCanRequestService together).
  it("refuses every request while grooming is booked by the office, and writes nothing", async () => {
    const refusal = async (over: Record<string, unknown>) => (await ask(over)).error?.message;
    expect(await refusal({})).toContain("groom_requests_off");
    expect(await refusal({ _dog_id: other.dogId })).toContain("groom_requests_off");
    expect(await refusal({ _on: addDays(day, 200) })).toContain("groom_requests_off");
    expect(await refusal({ _token: crypto.randomUUID() })).toContain("invalid_token");
    for (const table of ["qc_tickets", "visits"]) {
      const { count } = await admin
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", t.orgId);
      expect(count, table).toBe(0);
    }
  });

  it("refuses a business that does not run mobile grooming", async () => {
    await admin
      .from("organizations")
      .update({ service_lines: ["pet_waste"] })
      .eq("id", other.orgId);
    const res = await admin.rpc("portal_request_groom", {
      _token: other.token,
      _dog_id: other.dogId,
      _service_id: other.serviceId,
      _addons: [],
      _on: day,
      _from: null,
      _until: null,
      _message: "",
      _quoted_cents: null,
      _quoted_minutes: null,
    });
    expect(res.error?.message).toContain("grooming_not_offered");
  });

  it.skipIf(!ANON)("cannot be called with the publishable key", async () => {
    const anon = createClient(URL!, ANON!, { auth: { persistSession: false } });
    const res = await anon.rpc("portal_request_groom", {
      _token: t.token,
      _dog_id: t.dogId,
      _service_id: t.serviceId,
      _addons: [],
      _on: addDays(day, 2),
      _from: null,
      _until: null,
      _message: "",
      _quoted_cents: null,
      _quoted_minutes: null,
    });
    expect(res.error).not.toBeNull();
  });

  it("rejects a portal upload only with a reason and never while verified", async () => {
    const base = {
      organization_id: t.orgId,
      dog_id: t.dogId,
      vaccine: "rabies",
      expires_on: addDays(day, 300),
    };
    const portalId = await insert("pet_vaccinations", { ...base, source: "portal" });
    const officeId = await insert("pet_vaccinations", { ...base, source: "office" });
    const update = (id: string, patch: Record<string, unknown>) =>
      admin.from("pet_vaccinations").update(patch).eq("id", id);

    expect(
      (await update(portalId, { rejected_at: new Date().toISOString() })).error?.message,
    ).toContain("pet_vaccinations_review_shape");
    expect(
      (
        await update(officeId, {
          rejected_at: new Date().toISOString(),
          rejection_reason: "Blurry",
        })
      ).error?.message,
    ).toContain("pet_vaccinations_review_shape");
    expect(
      (
        await update(portalId, {
          rejected_at: new Date().toISOString(),
          rejection_reason: "Blurry",
        })
      ).error,
    ).toBeNull();

    const { data: pending } = await admin
      .from("pet_vaccinations")
      .select(
        "id, dog:dogs!pet_vaccinations_dog_id_fkey(name, property:properties(client_id, client:clients(display_name)))",
      )
      .eq("organization_id", t.orgId)
      .eq("source", "portal")
      .is("verified_at", null)
      .is("rejected_at", null);
    expect(pending).toEqual([]);

    // verified_by and verified_at go together (20261023120500), so the
    // verifier is a real user, as it is when the office approves.
    const { data: user, error: userError } = await admin.auth.admin.createUser({
      email: `groom-review-${runId}@example.test`,
      password: `pw-${runId}-${runId}`,
      email_confirm: true,
    });
    if (userError) throw userError;
    users.push(user.user.id);
    const verify = { verified_at: new Date().toISOString(), verified_by: user.user.id };
    // A record cannot be verified and rejected at once.
    expect((await update(portalId, verify)).error?.message).toContain(
      "pet_vaccinations_review_shape",
    );
    // Approving clears the rejection in the same write, as verifyVaccination does.
    expect(
      (await update(portalId, { ...verify, rejected_at: null, rejection_reason: null })).error,
    ).toBeNull();
    const { data: after } = await admin
      .from("pet_vaccinations")
      .select("verified_at, rejected_at, rejected_by, rejection_reason")
      .eq("id", portalId)
      .single();
    expect(after).toMatchObject({ rejected_at: null, rejected_by: null, rejection_reason: null });
    expect(after!.verified_at).not.toBeNull();
  });

  afterAll(async () => {
    if (!admin) return;
    for (const orgId of orgs) {
      await admin.from("qc_tickets").delete().eq("organization_id", orgId);
      await admin.from("pet_vaccinations").delete().eq("organization_id", orgId);
      await admin.from("organizations").delete().eq("id", orgId);
    }
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });
});
