// A dog-walking business on the local stack, for the walk DB tests (#410):
// an owner, two walkers, a walk service, and visits assigned to one walker.
// Every user signs in for real so RLS and the RPCs see who is asking.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const DB_URL = process.env.TEST_SUPABASE_URL;
export const DB_SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
export const DB_ANON = process.env.TEST_SUPABASE_ANON_KEY;
export const dbEnabled = Boolean(DB_URL && DB_SERVICE && DB_ANON);

const password = "walk-test-password-123!";

export type WalkPerson = { userId: string; staffId: string | null; client: SupabaseClient };

export type WalkOrg = {
  admin: SupabaseClient;
  anon: SupabaseClient;
  orgId: string;
  serviceId: string;
  owner: WalkPerson;
  walker: WalkPerson;
  otherWalker: WalkPerson;
  cleanup: () => Promise<void>;
};

export async function insertRow(
  admin: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

export async function makeWalkOrg(label: string): Promise<WalkOrg> {
  const runId = Math.random().toString(36).slice(2, 10);
  const admin = createClient(DB_URL!, DB_SERVICE!, { auth: { persistSession: false } });
  const anon = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
  const orgId = await insertRow(admin, "organizations", {
    name: `${label} ${runId}`,
    service_lines: ["dog_walking"],
    timezone: "UTC",
  });
  const serviceId = await insertRow(admin, "services", {
    organization_id: orgId,
    name: "Solo walk",
    service_line: "dog_walking",
    price_unit: "visit",
    base_price_cents: 2500,
    default_duration_min: 30,
  });
  const userIds: string[] = [];
  const person = async (name: string, role: "owner" | "tech"): Promise<WalkPerson> => {
    const email = `${name}-${runId}@walktest.local`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    const userId = data.user!.id;
    userIds.push(userId);
    await insertRow(admin, "user_roles", { user_id: userId, organization_id: orgId, role });
    const staffId =
      role === "tech"
        ? await insertRow(admin, "staff", {
            organization_id: orgId,
            user_id: userId,
            role: "tech",
            display_name: `Walker ${name}`,
          })
        : null;
    const client = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error(signedIn.error.message);
    return { userId, staffId, client };
  };
  const owner = await person("owner", "owner");
  const walker = await person("walker", "tech");
  const otherWalker = await person("other", "tech");
  return {
    admin,
    anon,
    orgId,
    serviceId,
    owner,
    walker,
    otherWalker,
    cleanup: async () => {
      await admin.from("organizations").delete().eq("id", orgId);
      for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
    },
  };
}

/** A home with one dog and a lock box, and a walk there today. */
export async function makeWalkVisit(
  org: WalkOrg,
  opts: { assignedStaffId?: string | null; status?: string; lockBoxCode?: string } = {},
) {
  const { admin, orgId, serviceId } = org;
  const n = Math.random().toString(36).slice(2, 8);
  const clientId = await insertRow(admin, "clients", {
    organization_id: orgId,
    display_name: `Walk client ${n}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(admin, "properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${n} Walk St`,
    city: "Austin",
    postal_code: "78701",
    lock_box_code: opts.lockBoxCode ?? null,
    access_method: opts.lockBoxCode ? "lockbox" : null,
    key_held: true,
    key_tag: "K-12",
  });
  await insertRow(admin, "dogs", {
    organization_id: orgId,
    property_id: propertyId,
    name: `Dog ${n}`,
    active: true,
  });
  const today = new Date().toISOString().slice(0, 10);
  const subscriptionId = await insertRow(admin, "subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    dog_count: 1,
    frequency: "one_time",
    price_cents: 2500,
    service_id: serviceId,
    status: "active",
    started_on: today,
  });
  const visitId = await insertRow(admin, "visits", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    subscription_id: subscriptionId,
    service_id: serviceId,
    scheduled_on: today,
    status: opts.status ?? "scheduled",
    assigned_staff_id: opts.assignedStaffId ?? null,
  });
  return { clientId, propertyId, subscriptionId, visitId };
}
