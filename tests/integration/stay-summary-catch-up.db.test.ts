// #747 in a real database: the nightly stay-summary catch-up is an owner's or
// office manager's choice, and the moment the catch went live for a business
// is stamped when it starts pet sitting.
//
// supabase/migrations/20261109170000_a-stay-summary-catch-up-is-the-owners-choice.sql
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
const password = "catch-up-test-password-123!";
const users: string[] = [];

type Role = "owner" | "office_manager" | "dispatcher" | "tech";
let admin: SupabaseClient;
let anon: SupabaseClient;
let orgId: string;
let otherOrgId: string;
const callers = {} as Record<Role | "stranger", SupabaseClient>;

async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}

async function person(org: string, role: Role, name: string): Promise<SupabaseClient> {
  const email = `catchup-${name}-${runId}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  users.push(data.user.id);
  await insert("user_roles", { user_id: data.user.id, organization_id: org, role });
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  return client;
}

async function readOrg(id: string) {
  const { data, error } = await admin
    .from("organizations")
    .select("stay_summary_catch_up, stay_summaries_live_at, service_lines")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data as {
    stay_summary_catch_up: boolean;
    stay_summaries_live_at: string;
    service_lines: string[];
  };
}

const setCatchUp = (who: SupabaseClient, on: boolean, org = orgId) =>
  who.rpc("set_stay_summary_catch_up", { _org_id: org, _on: on });

describe.skipIf(!enabled)("#747 the stay summary catch-up", () => {
  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new globalThis.URL(URL!).hostname))
      throw new Error("Local Supabase only");
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    anon = createClient(URL!, ANON!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Catch-up test ${runId}`,
      service_lines: ["pet_waste", "pet_sitting"],
    });
    otherOrgId = await insert("organizations", {
      name: `Other catch-up org ${runId}`,
      service_lines: ["pet_sitting"],
    });
    callers.owner = await person(orgId, "owner", "owner");
    callers.office_manager = await person(orgId, "office_manager", "manager");
    callers.dispatcher = await person(orgId, "dispatcher", "dispatcher");
    callers.tech = await person(orgId, "tech", "tech");
    callers.stranger = await person(otherOrgId, "owner", "stranger");
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
    if (otherOrgId) await admin.from("organizations").delete().eq("id", otherOrgId);
    for (const user of users) await admin.auth.admin.deleteUser(user);
  });

  it("is off for a business that never chose", async () => {
    expect((await readOrg(orgId)).stay_summary_catch_up).toBe(false);
  });

  it("refuses a tech and a dispatcher, and leaves the setting as it was", async () => {
    for (const role of ["tech", "dispatcher"] as const) {
      const r = await setCatchUp(callers[role], true);
      expect(r.error?.message ?? "").toMatch(/Only an owner or office manager/);
      expect(r.error?.code).toBe("42501");
    }
    expect((await readOrg(orgId)).stay_summary_catch_up).toBe(false);
  });

  it("lets an owner and an office manager turn it on and off", async () => {
    const on = await setCatchUp(callers.owner, true);
    expect(on.error).toBeNull();
    expect(on.data).toBe(true);
    expect((await readOrg(orgId)).stay_summary_catch_up).toBe(true);

    const off = await setCatchUp(callers.office_manager, false);
    expect(off.error).toBeNull();
    expect((await readOrg(orgId)).stay_summary_catch_up).toBe(false);
  });

  it("refuses another business's owner and a caller who is not signed in", async () => {
    const stranger = await setCatchUp(callers.stranger, true);
    expect(stranger.error?.message ?? "").toMatch(/Only an owner or office manager/);
    const nobody = await setCatchUp(anon, true);
    expect(nobody.error).not.toBeNull();
    expect((await readOrg(orgId)).stay_summary_catch_up).toBe(false);
  });

  it("cannot be moved by a direct write, even by an owner", async () => {
    const before = await readOrg(orgId);
    const direct = await callers.owner
      .from("organizations")
      .update({ stay_summary_catch_up: true })
      .eq("id", orgId)
      .select("id");
    expect(direct.error?.message ?? "").toMatch(/Only an owner or office manager/);
    const live = await callers.owner
      .from("organizations")
      .update({ stay_summaries_live_at: "2020-01-01T00:00:00Z" })
      .eq("id", orgId)
      .select("id");
    expect(live.error?.message ?? "").toMatch(/Only an owner or office manager/);
    const after = await readOrg(orgId);
    expect(after.stay_summary_catch_up).toBe(before.stay_summary_catch_up);
    expect(after.stay_summaries_live_at).toBe(before.stay_summaries_live_at);
  });

  it("stamps the go-live moment when a business starts pet sitting, and not before", async () => {
    const id = await insert("organizations", {
      name: `Starts sitting later ${runId}`,
      service_lines: ["pet_waste"],
    });
    try {
      const created = await readOrg(id);
      await new Promise((r) => setTimeout(r, 50));
      const { error: noop } = await admin
        .from("organizations")
        .update({ name: `Renamed ${runId}` })
        .eq("id", id);
      expect(noop).toBeNull();
      expect((await readOrg(id)).stay_summaries_live_at).toBe(created.stay_summaries_live_at);

      const startedAt = Date.now();
      const { error } = await admin
        .from("organizations")
        .update({ service_lines: ["pet_waste", "pet_sitting"] })
        .eq("id", id);
      expect(error).toBeNull();
      const started = await readOrg(id);
      expect(new Date(started.stay_summaries_live_at).getTime()).toBeGreaterThan(
        new Date(created.stay_summaries_live_at).getTime(),
      );
      // The database clock and this one may differ a little; within a minute.
      expect(Math.abs(new Date(started.stay_summaries_live_at).getTime() - startedAt)).toBeLessThan(
        60_000,
      );
    } finally {
      await admin.from("organizations").delete().eq("id", id);
    }
  });
});
