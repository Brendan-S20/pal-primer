/**
 * DB-layer proof for 20261017004000: an owner's REST write cannot turn on a
 * service line that is still Coming soon, keeps the lines the org already
 * runs, and the service role is not gated. Since 20261023120000 (#530) dog
 * walking is bookable and may be added; sitting, grooming and training may not.
 *
 * Local stack only. Skipped without TEST_SUPABASE_* env.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);

const PASSWORD = "test-password-123!";
const runId = Math.random().toString(36).slice(2, 8);

let admin: SupabaseClient;
let owner: SupabaseClient;
let orgId: string;

/** Sets the org's lines as the service role, the way admin tooling would. A
 *  user owns one org, so every case starts from here on the same org. */
async function resetLines(lines: string[]): Promise<void> {
  const { error } = await admin
    .from("organizations")
    .update({ service_lines: lines })
    .eq("id", orgId);
  if (error) throw new Error(`reset service_lines: ${error.message}`);
}

async function linesOf(): Promise<string[]> {
  const { data, error } = await admin
    .from("organizations")
    .select("service_lines")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return (data as any).service_lines;
}

describe.skipIf(!enabled)("a service line is turned on only when bookable", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    const email = `owner-${runId}@bookable.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser: ${error.message}`);

    const org = await admin
      .from("organizations")
      .insert({ name: `Bookable ${runId}` })
      .select("id")
      .single();
    if (org.error) throw new Error(`insert organizations: ${org.error.message}`);
    orgId = (org.data as any).id;
    const role = await admin
      .from("user_roles")
      .insert({ user_id: data.user!.id, organization_id: orgId, role: "owner" });
    if (role.error) throw new Error(`insert user_roles: ${role.error.message}`);

    owner = createClient(URL!, ANON!, { auth: { persistSession: false } });
    const signIn = await owner.auth.signInWithPassword({ email, password: PASSWORD });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
  });

  it("lets an owner add dog_walking to an org that only runs pet_waste", async () => {
    await resetLines(["pet_waste"]);
    const { data, error } = await owner
      .from("organizations")
      .update({ service_lines: ["pet_waste", "dog_walking"] })
      .eq("id", orgId)
      .select("id");
    expect(error).toBeNull();
    // An RLS-filtered update returns no error and no rows; prove it landed.
    expect(data).toHaveLength(1);
    expect(await linesOf()).toEqual(["pet_waste", "dog_walking"]);
  });

  it.each(["pet_sitting", "mobile_grooming", "training"])(
    "refuses an owner adding %s",
    async (line) => {
      await resetLines(["pet_waste"]);
      const { error } = await owner
        .from("organizations")
        .update({ service_lines: ["pet_waste", line] })
        .eq("id", orgId);
      expect(error?.message).toMatch(new RegExp(`${line} service is coming soon`));
      expect(error?.hint).toBe("service_line_not_bookable");
      expect(await linesOf()).toEqual(["pet_waste"]);
    },
  );

  it("lets an owner drop a line the org already runs and keep another, but not re-add it", async () => {
    await resetLines(["pet_waste", "dog_walking", "pet_sitting"]);

    const drop = await owner
      .from("organizations")
      .update({ service_lines: ["pet_waste", "dog_walking"] })
      .eq("id", orgId)
      .select("id");
    expect(drop.error).toBeNull();
    expect(drop.data).toHaveLength(1);
    expect(await linesOf()).toEqual(["pet_waste", "dog_walking"]);

    const readd = await owner
      .from("organizations")
      .update({ service_lines: ["pet_waste", "dog_walking", "pet_sitting"] })
      .eq("id", orgId);
    expect(readd.error?.message).toMatch(/pet_sitting service is coming soon/);
    expect(await linesOf()).toEqual(["pet_waste", "dog_walking"]);
  });

  it("lets the service role set any valid line", async () => {
    await resetLines(["pet_waste"]);
    const all = ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training", "other"];
    await resetLines(all);
    expect(await linesOf()).toEqual(all);
  });
});
