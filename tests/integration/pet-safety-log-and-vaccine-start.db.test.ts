// #729 in a real database: per-pet safety notes and incidents, and the
// owner's choice of whether a missing vaccine stops a Start.
//
// supabase/migrations/20261108152900_a-pet-keeps-its-notes-and-incidents.sql
// supabase/migrations/20261108153100_the-owner-chooses-whether-a-missing-vaccine-stops-a-start.sql
//
// Runs under `npm run test:db` (tests/run-db-tests.sh) against the LOCAL
// stack only, like every *.db.test.ts, and skips when none is configured.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 9);
const bucket = "pet-safety-photos";
const users: string[] = [];
const paths: string[] = [];
// The smallest valid PNG: storage checks the declared type against the bucket.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

type Caller = { client: SupabaseClient; userId: string; staffId: string };
let admin: SupabaseClient;
let anon: SupabaseClient;
let orgId: string;
let otherOrgId: string;
let owner: Caller;
let manager: Caller;
let tech: Caller;
let otherTech: Caller;
let stranger: Caller;
let clientId: string;
let propertyId: string;
let dogId: string;
let otherDogId: string;
let serviceId: string;

async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}
async function makeUser(
  org: string,
  role: "owner" | "office_manager" | "tech",
  name: string,
): Promise<Caller> {
  const email = `safety-${role}-${users.length}-${runId}@test.local`;
  const password = "safety-test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  users.push(data.user.id);
  await insert("user_roles", { user_id: data.user.id, organization_id: org, role });
  const staffId = await insert("staff", {
    user_id: data.user.id,
    organization_id: org,
    role,
    display_name: name,
    active: true,
  });
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  return { client, staffId, userId: data.user.id };
}
async function groomVisit(staffId: string, status = "scheduled") {
  const subscriptionId = await insert("subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    service_id: serviceId,
    account_type: "residential",
    frequency: "one_time",
    price_cents: 8000,
    dog_count: 1,
    started_on: "2026-11-08",
    ends_on: "2026-11-08",
  });
  return insert("visits", {
    organization_id: orgId,
    subscription_id: subscriptionId,
    client_id: clientId,
    property_id: propertyId,
    service_id: serviceId,
    assigned_staff_id: staffId,
    scheduled_on: "2026-11-08",
    status,
  });
}
async function statusOf(visitId: string) {
  const { data } = await admin.from("visits").select("status").eq("id", visitId).single();
  return data?.status;
}
async function setRuleAsService(org: string, rule: "warn" | "block") {
  const { error } = await admin
    .from("organizations")
    .update({
      vaccine_start_rule: rule,
      vaccine_start_rule_set_at: new Date(Date.now() - 60_000).toISOString(),
    })
    .eq("id", org);
  if (error) throw error;
}

describe.skipIf(!enabled)("#729 pet safety log and the owner's vaccine Start rule", () => {
  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new globalThis.URL(URL!).hostname))
      throw new Error("Local Supabase only");
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    anon = createClient(URL!, ANON!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Safety test ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    otherOrgId = await insert("organizations", {
      name: `Other safety org ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    owner = await makeUser(orgId, "owner", "Olive Owner");
    manager = await makeUser(orgId, "office_manager", "Mara Manager");
    tech = await makeUser(orgId, "tech", "Theo Tech");
    otherTech = await makeUser(orgId, "tech", "Una Unassigned");
    stranger = await makeUser(otherOrgId, "owner", "Sid Stranger");
    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: "Safety client",
      account_type: "residential",
      active: true,
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Safety St",
      city: "Austin",
      postal_code: "78701",
    });
    dogId = await insert("dogs", {
      organization_id: orgId,
      property_id: propertyId,
      name: "Biscuit",
      active: true,
    });
    const otherClient = await insert("clients", {
      organization_id: otherOrgId,
      display_name: "Other client",
      account_type: "residential",
      active: true,
    });
    const otherProperty = await insert("properties", {
      organization_id: otherOrgId,
      client_id: otherClient,
      street: "9 Other St",
      city: "Austin",
      postal_code: "78701",
    });
    otherDogId = await insert("dogs", {
      organization_id: otherOrgId,
      property_id: otherProperty,
      name: "Other dog",
      active: true,
    });
    serviceId = await insert("services", {
      organization_id: orgId,
      name: "Safety test groom",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: 8000,
      default_duration_min: 60,
      active: true,
    });
  }, 120_000);
  afterAll(async () => {
    if (!admin) return;
    if (paths.length) await admin.storage.from(bucket).remove(paths);
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
    if (otherOrgId) await admin.from("organizations").delete().eq("id", otherOrgId);
    for (const user of users) await admin.auth.admin.deleteUser(user);
  });

  // ── the vaccine Start rule ──────────────────────────────────────────────

  it("defaults every business to warn, so no existing tenant changes behaviour", async () => {
    const { data, error } = await admin
      .from("organizations")
      .select("vaccine_start_rule, vaccine_start_rule_set_at")
      .eq("id", orgId)
      .single();
    expect(error).toBeNull();
    expect(data).toEqual({ vaccine_start_rule: "warn", vaccine_start_rule_set_at: null });
  });

  it("WARN: the Start goes ahead and the tech can read which pet is missing what", async () => {
    await setRuleAsService(orgId, "warn");
    const visitId = await groomVisit(tech.staffId);
    const started = await tech.client.rpc("start_visit", { _visit_id: visitId });
    expect(started.error).toBeNull();
    expect(await statusOf(visitId)).toBe("in_progress");
    const missing = await tech.client.rpc("visit_missing_vaccines", { _visit_id: visitId });
    expect(missing.error).toBeNull();
    expect(missing.data).toEqual([{ dog_id: dogId, dog_name: "Biscuit", vaccine: "rabies" }]);
  });

  it("BLOCK: the Start is refused while a required vaccine is missing, and allowed once it is current", async () => {
    await setRuleAsService(orgId, "block");
    const visitId = await groomVisit(tech.staffId);
    const refused = await tech.client.rpc("start_visit", { _visit_id: visitId });
    expect(refused.error?.message).toMatch(/^VACCINE_START_BLOCKED: .*Biscuit \(rabies\)/);
    expect(await statusOf(visitId)).toBe("scheduled");
    // An expired record is still missing.
    const expired = await admin
      .from("pet_vaccinations")
      .insert({ dog_id: dogId, vaccine: "rabies", expires_on: "2020-01-01", source: "office" })
      .select("id")
      .single();
    expect(expired.error).toBeNull();
    expect((await tech.client.rpc("start_visit", { _visit_id: visitId })).error?.message).toMatch(
      /VACCINE_START_BLOCKED/,
    );
    const current = await admin
      .from("pet_vaccinations")
      .insert({ dog_id: dogId, vaccine: "rabies", expires_on: "2099-01-01", source: "office" })
      .select("id")
      .single();
    expect(current.error).toBeNull();
    expect((await tech.client.rpc("start_visit", { _visit_id: visitId })).error).toBeNull();
    expect(await statusOf(visitId)).toBe("in_progress");
    await admin.from("pet_vaccinations").delete().in("id", [expired.data!.id, current.data!.id]);
  });

  it("BLOCK is not retroactive: a visit already in progress, or a replayed start from before the rule, goes through", async () => {
    await setRuleAsService(orgId, "warn");
    const live = await groomVisit(tech.staffId, "in_progress");
    const replay = await groomVisit(tech.staffId);
    const startedBefore = new Date(Date.now() - 10 * 60_000).toISOString();
    await setRuleAsService(orgId, "block"); // set_at = one minute ago
    expect((await tech.client.rpc("start_visit", { _visit_id: live })).error).toBeNull();
    expect(await statusOf(live)).toBe("in_progress");
    expect(
      (await tech.client.rpc("start_visit", { _visit_id: replay, _started_at: startedBefore }))
        .error,
    ).toBeNull();
    expect(await statusOf(replay)).toBe("in_progress");
  });

  it("BLOCK holds against a tech writing the visit row directly, not only through start_visit", async () => {
    // Acceptance audit of #729 at a2d7e9d: the rule lived only inside
    // start_visit_as, and the visits UPDATE policy lets the assigned tech
    // write their own row, so PATCH /rest/v1/visits {status:'in_progress'}
    // started a blocked visit with no RPC involved.
    await setRuleAsService(orgId, "block");
    const visitId = await groomVisit(tech.staffId);
    const direct = await tech.client
      .from("visits")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", visitId)
      .select("id");
    expect(direct.error?.message).toMatch(/^VACCINE_START_BLOCKED: .*Biscuit \(rabies\)/);
    expect(await statusOf(visitId)).toBe("scheduled");
    // The RPC still refuses with the same words, and still lets a replay from
    // before the rule through: the guard trusts start_visit's own decision.
    expect((await tech.client.rpc("start_visit", { _visit_id: visitId })).error?.message).toMatch(
      /^VACCINE_START_BLOCKED/,
    );
    const replay = await groomVisit(tech.staffId);
    const before = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(
      (await tech.client.rpc("start_visit", { _visit_id: replay, _started_at: before })).error,
    ).toBeNull();
    expect(await statusOf(replay)).toBe("in_progress");
    // Under WARN the direct write is not this guard's business.
    await setRuleAsService(orgId, "warn");
    const warned = await groomVisit(tech.staffId);
    const ok = await tech.client.from("visits").update({ status: "in_progress" }).eq("id", warned);
    expect(ok.error).toBeNull();
    expect(await statusOf(warned)).toBe("in_progress");
  });

  it("BLOCK holds against a two-step write: away from scheduled first, then into in_progress", async () => {
    // Review of #851 at 9149527: the guard first fired only on scheduled ->
    // in_progress, so a tech could PATCH scheduled -> missed (or skipped, or
    // canceled), which the guard ignores, and then missed -> in_progress,
    // which it also ignored because OLD was no longer scheduled.
    await setRuleAsService(orgId, "block");
    for (const detour of ["missed", "skipped", "canceled"]) {
      const visitId = await groomVisit(tech.staffId);
      const away = await tech.client.from("visits").update({ status: detour }).eq("id", visitId);
      // Whether the detour itself is allowed is not this rule's business;
      // what matters is that the next step cannot reach in_progress.
      const from = away.error ? "scheduled" : detour;
      const into = await tech.client
        .from("visits")
        .update({ status: "in_progress" })
        .eq("id", visitId)
        .select("id");
      expect(into.error?.message, `${detour} -> in_progress`).toMatch(/^VACCINE_START_BLOCKED/);
      expect(await statusOf(visitId), detour).toBe(from);
    }
  });

  it("BLOCK leaves other lines alone, and a business whose grooming vaccine rule is off", async () => {
    await setRuleAsService(orgId, "block");
    const walkService = await insert("services", {
      organization_id: orgId,
      name: "Safety test walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2500,
      default_duration_min: 30,
      active: true,
    });
    const sub = await insert("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      service_id: walkService,
      account_type: "residential",
      frequency: "one_time",
      price_cents: 2500,
      dog_count: 1,
      started_on: "2026-11-08",
      ends_on: "2026-11-08",
    });
    const walk = await insert("visits", {
      organization_id: orgId,
      subscription_id: sub,
      client_id: clientId,
      property_id: propertyId,
      service_id: walkService,
      assigned_staff_id: tech.staffId,
      scheduled_on: "2026-11-08",
      status: "scheduled",
    });
    expect((await tech.client.rpc("start_visit", { _visit_id: walk })).error).toBeNull();
    await admin.from("organizations").update({ vaccine_rule: "off" }).eq("id", orgId);
    const groom = await groomVisit(tech.staffId);
    expect((await tech.client.rpc("start_visit", { _visit_id: groom })).error).toBeNull();
    await admin.from("organizations").update({ vaccine_rule: "warn" }).eq("id", orgId);
  });

  it("only the owner can change the rule, and every change is written down", async () => {
    await setRuleAsService(orgId, "warn");
    for (const caller of [manager, tech]) {
      const r = await caller.client.rpc("set_vaccine_start_rule", {
        _org_id: orgId,
        _rule: "block",
      });
      expect(r.error?.message).toMatch(/Only the owner/);
      // The table's own update policy does not open the column either.
      const direct = await caller.client
        .from("organizations")
        .update({ vaccine_start_rule: "block" })
        .eq("id", orgId)
        .select("id");
      expect(direct.data ?? []).toEqual([]);
    }
    const ownerDirect = await owner.client
      .from("organizations")
      .update({ vaccine_start_rule: "block" })
      .eq("id", orgId)
      .select("id");
    expect(ownerDirect.error?.message ?? "").toMatch(
      /Only the owner can change the vaccine Start rule/,
    );
    const set = await owner.client.rpc("set_vaccine_start_rule", {
      _org_id: orgId,
      _rule: "block",
    });
    expect(set.error).toBeNull();
    expect(set.data).toBe("block");
    const again = await owner.client.rpc("set_vaccine_start_rule", {
      _org_id: orgId,
      _rule: "block",
    });
    expect(again.error).toBeNull();
    const back = await owner.client.rpc("set_vaccine_start_rule", {
      _org_id: orgId,
      _rule: "warn",
    });
    expect(back.error).toBeNull();
    const audit = await manager.client
      .from("org_vaccine_policy_changes")
      .select("changed_by, old_value, new_value")
      .eq("organization_id", orgId)
      .order("changed_at");
    expect(audit.error).toBeNull();
    // A no-op save writes nothing.
    expect(audit.data).toEqual([
      { changed_by: owner.userId, old_value: "warn", new_value: "block" },
      { changed_by: owner.userId, old_value: "block", new_value: "warn" },
    ]);
    // The trail is read-only to everyone signed in, the owner included.
    expect(
      (
        await owner.client
          .from("org_vaccine_policy_changes")
          .insert({ organization_id: orgId, setting: "vaccine_start_rule", new_value: "block" })
      ).error,
    ).not.toBeNull();
    expect(
      (
        await owner.client
          .from("org_vaccine_policy_changes")
          .delete()
          .eq("organization_id", orgId)
          .select("id")
      ).data ?? [],
    ).toEqual([]);
    expect(
      (
        await tech.client
          .from("org_vaccine_policy_changes")
          .select("id")
          .eq("organization_id", orgId)
      ).data ?? [],
    ).toEqual([]);
  });

  it("another business's owner can neither change the rule nor read its trail or its pets' gaps", async () => {
    const r = await stranger.client.rpc("set_vaccine_start_rule", {
      _org_id: orgId,
      _rule: "block",
    });
    expect(r.error?.message).toMatch(/Only the owner/);
    expect(
      (
        await stranger.client
          .from("org_vaccine_policy_changes")
          .select("id")
          .eq("organization_id", orgId)
      ).data ?? [],
    ).toEqual([]);
    const visitId = await groomVisit(tech.staffId);
    expect(
      (await stranger.client.rpc("visit_missing_vaccines", { _visit_id: visitId })).error?.message,
    ).toMatch(/Not authorized/);
    expect(
      (await stranger.client.rpc("start_visit", { _visit_id: visitId })).error?.message,
    ).toMatch(/Not authorized/);
    expect(
      (await anon.rpc("set_vaccine_start_rule", { _org_id: orgId, _rule: "block" })).error,
    ).not.toBeNull();
    const rule = await admin
      .from("organizations")
      .select("vaccine_start_rule")
      .eq("id", orgId)
      .single();
    expect(rule.data?.vaccine_start_rule).toBe("warn");
  });

  // ── the safety log ──────────────────────────────────────────────────────

  it("an assigned tech reports an incident with a photo, as themselves, and the office reads it", async () => {
    await groomVisit(tech.staffId);
    const photo = `${orgId}/${dogId}/${crypto.randomUUID()}.png`;
    paths.push(photo);
    expect(
      (await tech.client.storage.from(bucket).upload(photo, png, { contentType: "image/png" }))
        .error,
    ).toBeNull();
    const occurredAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const row = await tech.client
      .from("pet_safety_entries")
      .insert({
        organization_id: otherOrgId, // ignored: the dog decides
        dog_id: dogId,
        entry_type: "incident",
        incident_kind: "bite",
        occurred_at: occurredAt,
        body: "Nipped at the dryer",
        storage_path: photo,
        reported_by: tech.userId,
        reporter_name: "Someone else",
      })
      .select("organization_id, reported_by, reporter_name, occurred_at")
      .single();
    expect(row.error).toBeNull();
    expect(row.data).toMatchObject({
      organization_id: orgId,
      reported_by: tech.userId,
      reporter_name: "Theo Tech",
    });
    expect(new Date(row.data!.occurred_at).toISOString()).toBe(occurredAt);
    const read = await owner.client
      .from("pet_safety_entries")
      .select("body, incident_kind")
      .eq("dog_id", dogId);
    expect(read.data).toEqual([{ body: "Nipped at the dryer", incident_kind: "bite" }]);
    expect((await owner.client.storage.from(bucket).createSignedUrl(photo, 300)).error).toBeNull();
  });

  it("a note needs no kind, an incident needs one, nobody reports as someone else, and nothing is in the future", async () => {
    expect(
      (
        await manager.client.from("pet_safety_entries").insert({
          dog_id: dogId,
          entry_type: "note",
          body: "Muzzle for nails",
          reported_by: manager.userId,
          reporter_name: "x",
        })
      ).error,
    ).toBeNull();
    expect(
      (
        await manager.client.from("pet_safety_entries").insert({
          dog_id: dogId,
          entry_type: "incident",
          body: "No kind",
          reported_by: manager.userId,
          reporter_name: "x",
        })
      ).error,
    ).not.toBeNull();
    expect(
      (
        await manager.client.from("pet_safety_entries").insert({
          dog_id: dogId,
          entry_type: "note",
          incident_kind: "bite",
          body: "Kind on a note",
          reported_by: manager.userId,
          reporter_name: "x",
        })
      ).error,
    ).not.toBeNull();
    expect(
      (
        await manager.client.from("pet_safety_entries").insert({
          dog_id: dogId,
          entry_type: "note",
          body: "Future",
          occurred_at: new Date(Date.now() + 3_600_000).toISOString(),
          reported_by: manager.userId,
          reporter_name: "x",
        })
      ).error,
    ).not.toBeNull();
    // The trigger stamps the caller; the policy then refuses a mismatch it never sees.
    const as = await manager.client
      .from("pet_safety_entries")
      .insert({
        dog_id: dogId,
        entry_type: "note",
        body: "Pretend",
        reported_by: owner.userId,
        reporter_name: "x",
      })
      .select("reported_by")
      .single();
    expect(as.data?.reported_by).toBe(manager.userId);
  });

  it("is append-only: nobody signed in can change or delete an entry, and the service role cannot rewrite one", async () => {
    const { data: rows } = await admin
      .from("pet_safety_entries")
      .select("id")
      .eq("dog_id", dogId)
      .limit(1);
    const id = rows![0].id;
    for (const caller of [owner, manager, tech]) {
      expect(
        (
          await caller.client
            .from("pet_safety_entries")
            .update({ body: "edited" })
            .eq("id", id)
            .select("id")
        ).data ?? [],
      ).toEqual([]);
      expect(
        (await caller.client.from("pet_safety_entries").delete().eq("id", id).select("id")).data ??
          [],
      ).toEqual([]);
    }
    expect(
      (await admin.from("pet_safety_entries").update({ body: "edited" }).eq("id", id)).error
        ?.message,
    ).toMatch(/cannot be changed/);
    const photo = (
      await admin
        .from("pet_safety_entries")
        .select("storage_path")
        .not("storage_path", "is", null)
        .eq("dog_id", dogId)
        .single()
    ).data!.storage_path as string;
    expect((await owner.client.storage.from(bucket).remove([photo])).data ?? []).toEqual([]);
    expect((await admin.storage.from(bucket).info(photo)).error).toBeNull();
  });

  it("keeps who reported it after their account is deleted", async () => {
    const leaver = await makeUser(orgId, "office_manager", "Lee Leaver");
    const made = await leaver.client
      .from("pet_safety_entries")
      .insert({
        dog_id: dogId,
        entry_type: "note",
        body: "Leaver's note",
        reported_by: leaver.userId,
        reporter_name: "x",
      })
      .select("id")
      .single();
    expect(made.error).toBeNull();
    expect((await admin.auth.admin.deleteUser(leaver.userId)).error).toBeNull();
    users.splice(users.indexOf(leaver.userId), 1);
    const row = await admin
      .from("pet_safety_entries")
      .select("reported_by, reporter_name")
      .eq("id", made.data!.id)
      .single();
    expect(row.data).toEqual({ reported_by: null, reporter_name: "Lee Leaver" });
  });

  it("keeps the log inside its business and off an unassigned tech", async () => {
    for (const caller of [stranger, otherTech]) {
      expect(
        (await caller.client.from("pet_safety_entries").select("id").eq("dog_id", dogId)).data ??
          [],
      ).toEqual([]);
      expect(
        (
          await caller.client.from("pet_safety_entries").insert({
            dog_id: dogId,
            entry_type: "note",
            body: "Sneak",
            reported_by: caller.userId,
            reporter_name: "x",
          })
        ).error,
      ).not.toBeNull();
      const p = `${orgId}/${dogId}/${crypto.randomUUID()}.png`;
      paths.push(p);
      expect(
        (await caller.client.storage.from(bucket).upload(p, png, { contentType: "image/png" }))
          .error,
      ).not.toBeNull();
    }
    expect(
      (await anon.from("pet_safety_entries").select("id").eq("dog_id", dogId)).data ?? [],
    ).toEqual([]);
    // Into another org's pet from this org's owner.
    expect(
      (
        await owner.client.from("pet_safety_entries").insert({
          dog_id: otherDogId,
          entry_type: "note",
          body: "Cross",
          reported_by: owner.userId,
          reporter_name: "x",
        })
      ).error,
    ).not.toBeNull();
    const photo = (
      await admin
        .from("pet_safety_entries")
        .select("storage_path")
        .not("storage_path", "is", null)
        .eq("dog_id", dogId)
        .single()
    ).data!.storage_path as string;
    expect(
      (await stranger.client.storage.from(bucket).createSignedUrl(photo, 300)).error,
    ).not.toBeNull();
    expect((await fetch(`${URL}/storage/v1/object/public/${bucket}/${photo}`)).ok).toBe(false);
  });

  it("refuses a photo of the wrong type, and a path in another pet's folder", async () => {
    const html = `${orgId}/${dogId}/${crypto.randomUUID()}.png`;
    paths.push(html);
    expect(
      (
        await owner.client.storage
          .from(bucket)
          .upload(html, new TextEncoder().encode("<b>x</b>"), { contentType: "text/html" })
      ).error,
    ).not.toBeNull();
    const foreign = `${otherOrgId}/${otherDogId}/${crypto.randomUUID()}.png`;
    expect(
      (
        await admin.from("pet_safety_entries").insert({
          dog_id: dogId,
          entry_type: "note",
          body: "Wrong folder",
          storage_path: foreign,
          reported_by: owner.userId,
          reporter_name: "Olive",
        })
      ).error?.message,
    ).toMatch(/must belong to the pet/);
  });
});
