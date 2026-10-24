import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 9);
const bucket = "pet-vaccine-records";
let admin: SupabaseClient;
let owner: SupabaseClient;
let stranger: SupabaseClient;
let tech: SupabaseClient;
let anon: SupabaseClient;
let orgId: string;
let otherOrgId: string;
let dogId: string;
let capDogId: string;
let propertyId: string;
let clientId: string;
let techStaffId: string;
let recordId: string;
let documentPath: string;
const users: string[] = [];
const paths: string[] = [];
const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");

async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}
async function makeUser(org: string, role: "owner" | "tech") {
  const email = `vaccine-${role}-${users.length}-${runId}@test.local`;
  const password = "vaccine-test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  await insert("user_roles", { user_id: data.user.id, organization_id: org, role });
  const staffId = await insert("staff", { user_id: data.user.id, organization_id: org, role, display_name: `Vaccine ${role}`, active: true });
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  return { client, staffId, userId: data.user.id };
}
const record = (dog = dogId, extra = {}) => ({ dog_id: dog, vaccine: "rabies", expires_on: "2027-10-16", source: "office", ...extra });

describe.skipIf(!enabled)("private pet vaccinations in the database", () => {
  beforeAll(async () => {
    // This suite writes fixtures and must only run against the CI local stack.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new globalThis.URL(URL!).hostname)) throw new Error("Local Supabase only");
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    anon = createClient(URL!, ANON!, { auth: { persistSession: false } });
    orgId = await insert("organizations", { name: `Vaccine test ${runId}`, service_lines: ["mobile_grooming"] });
    otherOrgId = await insert("organizations", { name: `Other vaccine org ${runId}` });
    owner = (await makeUser(orgId, "owner")).client;
    stranger = (await makeUser(otherOrgId, "owner")).client;
    const t = await makeUser(orgId, "tech"); tech = t.client; techStaffId = t.staffId;
    clientId = await insert("clients", { organization_id: orgId, display_name: "Vaccine client", account_type: "residential", active: true });
    propertyId = await insert("properties", { organization_id: orgId, client_id: clientId, street: "123 Vaccine St", city: "Austin", postal_code: "78701" });
    dogId = await insert("dogs", { organization_id: orgId, property_id: propertyId, name: "Vaccine pet", active: true });
    capDogId = await insert("dogs", { organization_id: orgId, property_id: propertyId, name: "Portal cap pet", active: true });
    documentPath = `${orgId}/${dogId}/${crypto.randomUUID()}.pdf`; paths.push(documentPath);
    const uploaded = await admin.storage.from(bucket).upload(documentPath, pdf, { contentType: "application/pdf" });
    if (uploaded.error) throw uploaded.error;
    recordId = await insert("pet_vaccinations", record(dogId, { organization_id: otherOrgId, storage_path: documentPath }));
  });
  afterAll(async () => {
    if (!admin) return;
    if (paths.length) await admin.storage.from(bucket).remove(paths);
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
    if (otherOrgId) await admin.from("organizations").delete().eq("id", otherOrgId);
    for (const user of users) await admin.auth.admin.deleteUser(user);
  });

  it("defaults rules and derives the record organization from its dog", async () => {
    const org = await admin.from("organizations").select("vaccine_rule, required_vaccines").eq("id", orgId).single();
    expect(org.error).toBeNull();
    expect(org.data).toEqual({ vaccine_rule: "warn", required_vaccines: ["rabies"] });
    const row = await admin.from("pet_vaccinations").select("organization_id").eq("id", recordId).single();
    expect(row.data?.organization_id).toBe(orgId);
  });
  it("lets the office read its row and document", async () => {
    const read = await owner.from("pet_vaccinations").select("id").eq("id", recordId);
    expect(read.error).toBeNull(); expect(read.data).toEqual([{ id: recordId }]);
    const signed = await owner.storage.from(bucket).createSignedUrl(documentPath, 300);
    expect(signed.error).toBeNull(); expect(signed.data?.signedUrl).toBeTruthy();
    expect((await owner.storage.from(bucket).download(documentPath)).error).toBeNull();
  });
  it("refuses another org, an unassigned tech and anon for both row and storage reads", async () => {
    for (const caller of [stranger, tech, anon]) {
      const read = await caller.from("pet_vaccinations").select("id").eq("id", recordId);
      expect(read.data ?? []).toEqual([]);
      expect((await caller.storage.from(bucket).createSignedUrl(documentPath, 300)).error).not.toBeNull();
      expect((await caller.storage.from(bucket).download(documentPath)).error).not.toBeNull();
    }
    const publicRead = await fetch(`${URL}/storage/v1/object/public/${bucket}/${documentPath}`);
    expect(publicRead.ok).toBe(false);
  });
  it("rejects cross-org writes, unassigned tech uploads and anonymous uploads", async () => {
    for (const caller of [stranger, tech, anon]) {
      const p = `${orgId}/${dogId}/${crypto.randomUUID()}.pdf`; paths.push(p);
      expect((await caller.storage.from(bucket).upload(p, pdf, { contentType: "application/pdf" })).error).not.toBeNull();
      expect((await caller.from("pet_vaccinations").insert(record(dogId, { organization_id: orgId }))).error).not.toBeNull();
    }
  });
  it("lets an assigned tech read the same pet, but keeps office writes closed", async () => {
    // Match a real one-time groom: visits always belong to a subscription.
    // Keep the production NOT NULL constraint intact, including pet waste.
    const serviceId = await insert("services", {
      organization_id: orgId,
      name: "Vaccine access test groom",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: 8000,
      default_duration_min: 60,
      active: true,
    });
    const subscriptionId = await insert("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      account_type: "residential",
      frequency: "one_time",
      price_cents: 8000,
      dog_count: 1,
      started_on: "2026-10-16",
      ends_on: "2026-10-16",
    });
    await insert("visits", {
      organization_id: orgId,
      subscription_id: subscriptionId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      assigned_staff_id: techStaffId,
      scheduled_on: "2026-10-16",
      status: "scheduled",
    });
    const read = await tech.from("pet_vaccinations").select("id").eq("id", recordId);
    expect(read.error).toBeNull(); expect(read.data).toEqual([{ id: recordId }]);
    expect((await tech.storage.from(bucket).createSignedUrl(documentPath, 300)).error).toBeNull();
    const writePath = `${orgId}/${dogId}/${crypto.randomUUID()}.pdf`; paths.push(writePath);
    expect((await tech.storage.from(bucket).upload(writePath, pdf, { contentType: "application/pdf" })).error).not.toBeNull();
    expect((await tech.from("pet_vaccinations").update({ expires_on: "2028-01-01" }).eq("id", recordId).select("id")).data ?? []).toEqual([]);
    expect((await tech.from("pet_vaccinations").delete().eq("id", recordId).select("id")).data ?? []).toEqual([]);
  });
  it("allows office upload, update and delete, and forbids moves to a foreign folder", async () => {
    const p = `${orgId}/${dogId}/${crypto.randomUUID()}.pdf`; paths.push(p);
    expect((await owner.storage.from(bucket).upload(p, pdf, { contentType: "application/pdf" })).error).toBeNull();
    expect((await owner.storage.from(bucket).update(p, pdf, { contentType: "application/pdf" })).error).toBeNull();
    expect((await owner.storage.from(bucket).move(p, `${otherOrgId}/${dogId}/${crypto.randomUUID()}.pdf`)).error).not.toBeNull();
    expect((await owner.storage.from(bucket).remove([p])).error).toBeNull();
    const left = await admin.storage.from(bucket).info(p); expect(left.error).not.toBeNull();
  });
  it("enforces the bucket MIME and size limits on real uploads", async () => {
    for (const [body, contentType, extension] of [
      [new TextEncoder().encode("<script>bad</script>"), "text/html", "html"],
      [new Uint8Array(10485761), "application/pdf", "pdf"],
    ] as const) {
      const p = `${orgId}/${dogId}/${crypto.randomUUID()}.${extension}`;
      paths.push(p);
      expect((await owner.storage.from(bucket).upload(p, body, { contentType })).error).not.toBeNull();
    }
  });
  it("rejects invalid paths and malformed UUID folders without raising a cast error", async () => {
    for (const p of ["bad/path/file.pdf", `${orgId}/${dogId}/../record.pdf`, `${otherOrgId}/${dogId}/${crypto.randomUUID()}.pdf`]) {
      const helper = await owner.rpc("can_use_vaccine_record", { name: p, write: false });
      expect(helper.error).toBeNull(); expect(helper.data).toBe(false);
    }
    const invalid = await admin.from("pet_vaccinations").insert(record(dogId, { storage_path: `${otherOrgId}/${dogId}/${crypto.randomUUID()}.pdf` }));
    expect(invalid.error).not.toBeNull();
    expect((await anon.rpc("can_use_vaccine_record", { name: documentPath, write: false })).error).not.toBeNull();
  });
  it("rejects invalid rules, dates, notes and half-verified records", async () => {
    for (const patch of [{ vaccine_rule: "ignore" }, { required_vaccines: ["other"] }, { required_vaccines: [null] }]) {
      expect((await admin.from("organizations").update(patch).eq("id", orgId)).error).not.toBeNull();
    }
    for (const patch of [{ given_on: "2028-01-01" }, { vaccine: "other" }, { file_name: "x".repeat(201) }, { verified_at: new Date().toISOString() }]) {
      expect((await admin.from("pet_vaccinations").insert(record(dogId, patch))).error).not.toBeNull();
    }
  });
  it("enforces the portal cap through concurrent inserts and updates", async () => {
    const seed = await admin.from("pet_vaccinations").insert(Array.from({ length: 19 }, () => record(capDogId, { source: "portal" })));
    expect(seed.error).toBeNull();
    const attempts = await Promise.all([0, 1].map(() => admin.from("pet_vaccinations").insert(record(capDogId, { source: "portal" }))));
    expect(attempts.filter((r) => !r.error)).toHaveLength(1);
    expect(attempts.filter((r) => r.error)).toHaveLength(1);
    const officeId = await insert("pet_vaccinations", record(capDogId));
    expect((await admin.from("pet_vaccinations").update({ source: "portal" }).eq("id", officeId)).error).not.toBeNull();
  });
  it("clears verification when the verifier's auth account is deleted", async () => {
    const verifier = await makeUser(orgId, "tech");
    const id = await insert("pet_vaccinations", record(dogId, { verified_by: verifier.userId, verified_at: new Date().toISOString() }));
    expect((await admin.auth.admin.deleteUser(verifier.userId)).error).toBeNull();
    users.splice(users.indexOf(verifier.userId), 1);
    const row = await admin.from("pet_vaccinations").select("verified_by, verified_at").eq("id", id).single();
    expect(row.error).toBeNull(); expect(row.data).toEqual({ verified_by: null, verified_at: null });
  });
});
