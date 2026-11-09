/**
 * DB-layer proof that a lesson's note, homework and scores can be saved.
 * training_progress_row_guard runs on all three tables, and each reads only
 * its own columns. The portal's read of notes returns the shared note and
 * never the trainer's. The nightly missed sweep records a reason on a package
 * lesson, and the lesson uses a session.
 *
 * Local stack only. Skipped without TEST_SUPABASE_* env.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);

const runId = Math.random().toString(36).slice(2, 8);
let admin: SupabaseClient;
let orgId: string;
let visitId: string;
let dogId: string;
let skillId: string;
let clientId: string;
let propertyId: string;
let serviceId: string;
let subId: string;

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as { id: string }).id;
}

describe.skipIf(!enabled)("training lesson records", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Lesson Records ${runId}`,
      service_lines: ["training"],
    });
    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: `Client ${runId}`,
      account_type: "residential",
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Test St",
      city: "Testville",
      postal_code: "48000",
    });
    dogId = await insert("dogs", { organization_id: orgId, property_id: propertyId, name: "Rex" });
    serviceId = await insert("services", {
      organization_id: orgId,
      name: `Private lesson ${runId}`,
      service_line: "training",
      price_unit: "visit",
      default_duration_min: 60,
      active: true,
    });
    subId = await insert("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      account_type: "residential",
      frequency: "one_time",
      dog_count: 1,
      price_cents: 9500,
      service_id: serviceId,
      started_on: "2026-10-20",
    });
    visitId = await insert("visits", {
      organization_id: orgId,
      subscription_id: subId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      scheduled_on: "2026-10-20",
    });
    skillId = await insert("training_skills", { organization_id: orgId, name: "Recall" });
  });

  it("saves a lesson note with a trainer-only note", async () => {
    const { error } = await admin.from("training_session_notes").insert({
      visit_id: visitId,
      organization_id: orgId,
      note: "Recall at 20 feet.",
      trainer_note: "Owner skipped practice.",
    });
    expect(error).toBeNull();
  });

  it("the portal read returns the shared note and never the trainer-only note", async () => {
    // A second lesson with only a trainer note: the portal gets no row for it.
    const trainerOnlyId = await insert("visits", {
      organization_id: orgId,
      subscription_id: subId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      scheduled_on: "2026-10-21",
    });
    const saved = await admin.from("training_session_notes").insert({
      visit_id: trainerOnlyId,
      organization_id: orgId,
      trainer_note: "Staff only.",
    });
    expect(saved.error).toBeNull();

    const { data, error } = await admin.rpc("portal_training_lesson_notes", {
      _organization_id: orgId,
      _client_id: clientId,
      _visit_ids: [visitId, trainerOnlyId],
    });
    expect(error).toBeNull();
    expect(data).toEqual([{ visit_id: visitId, dog_id: null, note: "Recall at 20 feet." }]);
    expect(JSON.stringify(data)).not.toContain("Owner skipped practice.");
    expect(JSON.stringify(data)).not.toContain("trainer_note");

    // Another business's id returns nothing for these lessons.
    const other = await admin.rpc("portal_training_lesson_notes", {
      _organization_id: "00000000-0000-4000-8000-000000000000",
      _client_id: clientId,
      _visit_ids: [visitId],
    });
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
  });

  it("the portal read returns nothing for another client's lessons in the same business", async () => {
    const otherClientId = await insert("clients", {
      organization_id: orgId,
      display_name: `Other client ${runId}`,
      account_type: "residential",
    });
    const otherPropertyId = await insert("properties", {
      organization_id: orgId,
      client_id: otherClientId,
      street: "2 Test St",
      city: "Testville",
      postal_code: "48000",
    });
    const otherSubId = await insert("subscriptions", {
      organization_id: orgId,
      client_id: otherClientId,
      property_id: otherPropertyId,
      account_type: "residential",
      frequency: "one_time",
      dog_count: 1,
      price_cents: 9500,
      service_id: serviceId,
      started_on: "2026-10-22",
    });
    const otherVisitId = await insert("visits", {
      organization_id: orgId,
      subscription_id: otherSubId,
      client_id: otherClientId,
      property_id: otherPropertyId,
      service_id: serviceId,
      scheduled_on: "2026-10-22",
    });
    const saved = await admin.from("training_session_notes").insert({
      visit_id: otherVisitId,
      organization_id: orgId,
      note: "Another family's lesson.",
    });
    expect(saved.error).toBeNull();

    // The first client asking with the other client's visit id gets nothing.
    const asked = await admin.rpc("portal_training_lesson_notes", {
      _organization_id: orgId,
      _client_id: clientId,
      _visit_ids: [otherVisitId],
    });
    expect(asked.error).toBeNull();
    expect(asked.data).toEqual([]);

    // A mixed list returns only the asking client's own note.
    const mixed = await admin.rpc("portal_training_lesson_notes", {
      _organization_id: orgId,
      _client_id: clientId,
      _visit_ids: [visitId, otherVisitId],
    });
    expect(mixed.error).toBeNull();
    expect(mixed.data).toEqual([{ visit_id: visitId, dog_id: null, note: "Recall at 20 feet." }]);

    // The other client still reads their own.
    const own = await admin.rpc("portal_training_lesson_notes", {
      _organization_id: orgId,
      _client_id: otherClientId,
      _visit_ids: [otherVisitId],
    });
    expect(own.error).toBeNull();
    expect(own.data).toEqual([
      { visit_id: otherVisitId, dog_id: null, note: "Another family's lesson." },
    ]);
  });

  it("the portal read is the service role's only", async () => {
    const ANON = process.env.TEST_SUPABASE_ANON_KEY;
    if (!ANON) throw new Error("TEST_SUPABASE_ANON_KEY is not set");
    const anon = createClient(URL!, ANON, { auth: { persistSession: false } });
    const { data, error } = await anon.rpc("portal_training_lesson_notes", {
      _organization_id: orgId,
      _client_id: clientId,
      _visit_ids: [visitId],
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("saves homework for a dog at the lesson", async () => {
    const { error } = await admin.from("homework").insert({
      visit_id: visitId,
      organization_id: orgId,
      dog_id: dogId,
      body: "Recall games in the yard.",
    });
    expect(error).toBeNull();
  });

  it("saves a score and refuses a skill from another business", async () => {
    const ok = await admin
      .from("session_progress")
      .insert({ organization_id: orgId, visit_id: visitId, skill_id: skillId, score: 3 });
    expect(ok.error).toBeNull();
    const otherOrg = await insert("organizations", {
      name: `Other ${runId}`,
      service_lines: ["training"],
    });
    const foreignSkill = await insert("training_skills", {
      organization_id: otherOrg,
      name: "Sit",
    });
    const bad = await admin
      .from("session_progress")
      .insert({ organization_id: orgId, visit_id: visitId, skill_id: foreignSkill, score: 2 });
    expect(bad.error?.message).toContain("Choose a skill from this business.");
  });

  it("keeps one record per dog at the lesson, and refuses a dog from another house (R2-26)", async () => {
    const puppyId = await insert("dogs", {
      organization_id: orgId,
      property_id: propertyId,
      name: "Tilly",
    });
    for (const dog of [dogId, puppyId]) {
      const saved = await admin
        .from("session_progress")
        .upsert(
          { organization_id: orgId, visit_id: visitId, dog_id: dog, skill_id: skillId, score: 2 },
          { onConflict: "visit_id,dog_id,skill_id" },
        );
      expect(saved.error).toBeNull();
    }
    // A second save for the same dog updates its row; the other dog's stays.
    const again = await admin
      .from("session_progress")
      .upsert(
        { organization_id: orgId, visit_id: visitId, dog_id: puppyId, skill_id: skillId, score: 5 },
        { onConflict: "visit_id,dog_id,skill_id" },
      );
    expect(again.error).toBeNull();
    const { data: rows } = await admin
      .from("session_progress")
      .select("dog_id, score")
      .eq("visit_id", visitId)
      .eq("skill_id", skillId);
    expect(rows).toEqual(
      expect.arrayContaining([
        { dog_id: dogId, score: 2 },
        { dog_id: puppyId, score: 5 },
      ]),
    );

    // Two dogs, two homework entries and two notes on one lesson.
    for (const [dog, body] of [
      [dogId, "Recall games."],
      [puppyId, "Sit before meals."],
    ] as const) {
      const hw = await admin
        .from("homework")
        .upsert(
          { organization_id: orgId, visit_id: visitId, dog_id: dog, body },
          { onConflict: "visit_id,dog_id" },
        );
      expect(hw.error).toBeNull();
      const note = await admin
        .from("training_session_notes")
        .upsert(
          { organization_id: orgId, visit_id: visitId, dog_id: dog, note: body },
          { onConflict: "visit_id,dog_id" },
        );
      expect(note.error).toBeNull();
    }
    const { data: notes } = await admin.rpc("portal_training_lesson_notes", {
      _organization_id: orgId,
      _client_id: clientId,
      _visit_ids: [visitId],
    });
    expect(notes).toEqual(
      expect.arrayContaining([
        { visit_id: visitId, dog_id: puppyId, note: "Sit before meals." },
        { visit_id: visitId, dog_id: dogId, note: "Recall games." },
      ]),
    );

    // A whole-lesson record (no dog) is still one row: NULLS NOT DISTINCT.
    const first = await admin
      .from("homework")
      .upsert(
        { organization_id: orgId, visit_id: visitId, dog_id: null, body: "Whole lesson." },
        { onConflict: "visit_id,dog_id" },
      );
    expect(first.error).toBeNull();
    const second = await admin
      .from("homework")
      .upsert(
        { organization_id: orgId, visit_id: visitId, dog_id: null, body: "Whole lesson, again." },
        { onConflict: "visit_id,dog_id" },
      );
    expect(second.error).toBeNull();
    const { count } = await admin
      .from("homework")
      .select("*", { count: "exact", head: true })
      .eq("visit_id", visitId)
      .is("dog_id", null);
    expect(count).toBe(1);

    // A dog that lives somewhere else is refused on every table.
    const elsewhere = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "9 Far St",
      city: "Testville",
      postal_code: "48000",
    });
    const strayId = await insert("dogs", {
      organization_id: orgId,
      property_id: elsewhere,
      name: "Stray",
    });
    const bad = await admin
      .from("session_progress")
      .insert({
        organization_id: orgId,
        visit_id: visitId,
        dog_id: strayId,
        skill_id: skillId,
        score: 1,
      });
    expect(bad.error?.message).toContain("Choose a dog at this lesson.");
    const badNote = await admin
      .from("training_session_notes")
      .insert({ organization_id: orgId, visit_id: visitId, dog_id: strayId, note: "x" });
    expect(badNote.error?.message).toContain("Choose a dog at this lesson.");
  });

  it("the nightly sweep marks a past package lesson missed with reason other, and it uses a session", async () => {
    const servicePackageId = await insert("service_packages", {
      organization_id: orgId,
      service_id: serviceId,
      name: `Five lessons ${runId}`,
      sessions_count: 5,
      price_cents: 40000,
    });
    const packageId = await insert("client_packages", {
      organization_id: orgId,
      client_id: clientId,
      service_package_id: servicePackageId,
      service_id: serviceId,
      name: "Five lessons",
      sessions_count: 5,
      price_cents: 40000,
      purchased_on: "2026-01-01",
    });
    const lessonId = await insert("visits", {
      organization_id: orgId,
      subscription_id: subId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      client_package_id: packageId,
      scheduled_on: "2020-01-06",
    });
    // A past visit that is not a lesson keeps no reason.
    const plainId = await insert("visits", {
      organization_id: orgId,
      subscription_id: subId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      scheduled_on: "2020-01-07",
    });

    const { error } = await admin.rpc("admin_transition_missed_visits", { _org_id: orgId });
    expect(error).toBeNull();

    const { data: rows, error: readError } = await admin
      .from("visits")
      .select("id, status, skip_reason_code, skip_billable")
      .in("id", [lessonId, plainId]);
    expect(readError).toBeNull();
    expect(rows!.find((r) => r.id === lessonId)).toMatchObject({
      status: "missed",
      skip_reason_code: "other",
      skip_billable: true,
    });
    expect(rows!.find((r) => r.id === plainId)).toMatchObject({
      status: "missed",
      skip_reason_code: null,
    });

    const { data: pkg } = await admin
      .from("client_packages")
      .select("sessions_used")
      .eq("id", packageId)
      .single();
    expect(pkg!.sessions_used).toBe(1);
  });
});
