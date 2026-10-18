/**
 * Deleting an account removes its push tokens and profile photo (#487).
 *
 * delete_my_account keeps the auth row on purpose, so the ON DELETE CASCADE
 * from auth.users never fires. 20261018060000 deletes the person's
 * push_subscriptions and live_activity_tokens inside the function, and
 * deleteMyAccount removes their files from the "avatars" bucket.
 *
 * Two people share one org here. The one who deletes loses their rows and
 * files. The other keeps every one of theirs.
 *
 * Local stack only. Skipped without TEST_SUPABASE_* env (see run-db-tests.sh).
 * The Storage test also needs a stack with Storage running. It probes for the
 * "avatars" bucket and skips with a warning if Storage does not answer.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DB_ANON, DB_SERVICE, DB_URL, dbEnabled, insertRow } from "../support/walk-db";

// deleteMyAccount is a server function. These mocks run its handler in the
// test, as the signed-in caller below, against the real local stack.
const caller = vi.hoisted(() => ({ supabase: null as unknown, userId: "" }));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({
            data: validate(opts.data ?? {}),
            context: { supabase: caller.supabase, userId: caller.userId },
          }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    supabaseAdmin: createClient(
      process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:1",
      process.env.TEST_SUPABASE_SERVICE_KEY ?? "unset",
      { auth: { persistSession: false } },
    ),
  };
});

const PASSWORD = "account-deletion-test-123!";
const runId = Math.random().toString(36).slice(2, 10);

let admin: SupabaseClient;
let orgId: string;
const userIds: string[] = [];

type Person = { userId: string; client: SupabaseClient };

async function person(name: string, role: "owner" | "tech"): Promise<Person> {
  const email = `${name}-${runId}@deletiontest.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  const userId = data.user!.id;
  userIds.push(userId);
  await insertRow(admin, "user_roles", { user_id: userId, organization_id: orgId, role });
  await insertRow(admin, "staff", {
    organization_id: orgId,
    user_id: userId,
    role,
    display_name: `Person ${name}`,
  });
  const client = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signedIn.error) throw new Error(signedIn.error.message);
  return { userId, client };
}

/** One web push row, one native push row and one Live Activity row. */
async function giveTokens(userId: string) {
  const tag = `${runId}-${userId.slice(0, 8)}`;
  await insertRow(admin, "push_subscriptions", {
    organization_id: orgId,
    user_id: userId,
    endpoint: `https://push.example.test/${tag}`,
    p256dh: "p256dh-test",
    auth: "auth-test",
    platform: "web",
  });
  await insertRow(admin, "push_subscriptions", {
    organization_id: orgId,
    user_id: userId,
    native_token: `native-${tag}`,
    platform: "ios",
  });
  await insertRow(admin, "live_activity_tokens", {
    organization_id: orgId,
    user_id: userId,
    activity_id: `activity-${tag}`,
    push_token: "0123456789abcdef0123456789abcdef",
    route_date: "2026-10-18",
  });
}

async function countRows(table: string, userId: string): Promise<number> {
  const { count, error } = await admin
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function listAvatars(userId: string): Promise<string[]> {
  const { data, error } = await admin.storage.from("avatars").list(`${orgId}/${userId}`);
  if (error) throw new Error(`list avatars: ${error.message}`);
  return (data ?? []).map((f) => f.name);
}

async function uploadAvatar(userId: string, name: string) {
  const { error } = await admin.storage
    .from("avatars")
    .upload(`${orgId}/${userId}/${name}`, new Blob(["not really a photo"], { type: "image/png" }));
  if (error) throw new Error(`upload avatar: ${error.message}`);
}

describe.skipIf(!dbEnabled)("deleting an account removes its push tokens (#487)", () => {
  let leaving: Person;
  let staying: Person;

  beforeAll(async () => {
    admin = createClient(DB_URL!, DB_SERVICE!, { auth: { persistSession: false } });
    orgId = await insertRow(admin, "organizations", {
      name: `Account Deletion Test ${runId}`,
      timezone: "UTC",
    });
    // The one staying is the owner, so the one leaving is never a sole owner
    // and the RPC does not refuse.
    staying = await person("staying", "owner");
    leaving = await person("leaving", "tech");
    await giveTokens(staying.userId);
    await giveTokens(leaving.userId);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("organizations").delete().eq("id", orgId);
    for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
  });

  it("starts with two push rows and one Live Activity row each", async () => {
    for (const p of [leaving, staying]) {
      expect(await countRows("push_subscriptions", p.userId)).toBe(2);
      expect(await countRows("live_activity_tokens", p.userId)).toBe(1);
    }
  });

  it("delete_my_account removes the caller's push and Live Activity rows", async () => {
    const { error } = await leaving.client.rpc("delete_my_account", {});
    expect(error).toBeNull();
    expect(await countRows("push_subscriptions", leaving.userId)).toBe(0);
    expect(await countRows("live_activity_tokens", leaving.userId)).toBe(0);
  });

  it("and leaves the other person's rows untouched", async () => {
    expect(await countRows("push_subscriptions", staying.userId)).toBe(2);
    expect(await countRows("live_activity_tokens", staying.userId)).toBe(1);
  });

  it("keeps the auth row, as it always has", async () => {
    const { data, error } = await admin.auth.admin.getUserById(leaving.userId);
    expect(error).toBeNull();
    expect(data.user?.id).toBe(leaving.userId);
  });

  describe("and the profile photo files", () => {
    let storageUp = false;

    beforeAll(async () => {
      const { error } = await admin.storage.getBucket("avatars");
      storageUp = !error;
      if (!storageUp) {
        console.warn(
          `account-deletion: Storage did not answer (${error?.message}). ` +
            "The avatar test needs a local stack with Storage running, and is skipped.",
        );
      }
    });

    it("deleteMyAccount empties the caller's avatar folder and leaves another's", async (ctx) => {
      if (!storageUp) ctx.skip("needs a local stack with Storage");

      const photoTaker = await person("photo", "tech");
      await uploadAvatar(photoTaker.userId, "1700000000000.jpg");
      await uploadAvatar(photoTaker.userId, "1700000001000.png");
      await uploadAvatar(staying.userId, "1700000002000.jpg");
      expect(await listAvatars(photoTaker.userId)).toHaveLength(2);

      caller.supabase = photoTaker.client;
      caller.userId = photoTaker.userId;
      const { deleteMyAccount } = await import("@/lib/delete-account.functions");
      const r = await (deleteMyAccount as any)({ data: {} });

      expect(r.ok).toBe(true);
      expect(r.incomplete).not.toContain("avatar");
      expect(await listAvatars(photoTaker.userId)).toEqual([]);
      expect(await listAvatars(staying.userId)).toEqual(["1700000002000.jpg"]);

      await admin.storage.from("avatars").remove([`${orgId}/${staying.userId}/1700000002000.jpg`]);
    });
  });
});
