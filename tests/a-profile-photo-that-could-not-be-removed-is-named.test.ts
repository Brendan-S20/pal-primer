// A profile photo that could not be removed is named (#487).
//
// deleteMyAccount removes the person's files from the "avatars" bucket after
// the RPC commits. Like the other steps after the RPC, it is best effort: a
// Storage outage must not make an account un-deletable. But it must not be
// silent either. The screen has to say the photo is still there.
//
// These run deleteMyAccount for real, with the framework and both Supabase
// clients faked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-0000000000a1";
const ORG = "0f000000-0000-4000-8000-0000000000a1";

type Calls = { list: string[]; remove: string[][]; signOut: number; updateUser: number };
let calls: Calls;
let storageFails: "list" | "remove" | null;
let lookupFails: boolean;
let files: string[];

/** The rows the avatar step reads before the RPC. */
function chain(table: string) {
  const api: any = {
    select: () => api,
    eq: () => api,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (res: any, rej: any) =>
      Promise.resolve(
        lookupFails
          ? { data: null, error: { message: "lookup down" } }
          : table === "user_roles" || table === "staff"
            ? { data: [{ organization_id: ORG }], error: null }
            : { data: [], error: null },
      ).then(res, rej),
  };
  return api;
}

const admin = {
  from: (t: string) => chain(t),
  storage: {
    from: (bucket: string) => {
      expect(bucket).toBe("avatars");
      return {
        list: async (folder: string) => {
          calls.list.push(folder);
          if (storageFails === "list") return { data: null, error: { message: "storage down" } };
          return { data: files.map((name) => ({ name })), error: null };
        },
        remove: async (paths: string[]) => {
          calls.remove.push(paths);
          if (storageFails === "remove") return { data: null, error: { message: "storage down" } };
          files = [];
          return { data: [], error: null };
        },
      };
    },
  },
  auth: {
    admin: {
      updateUserById: async () => {
        calls.updateUser++;
        return { data: {}, error: null };
      },
      signOut: async () => {
        calls.signOut++;
        return { error: null };
      },
    },
  },
};

const userClient = {
  rpc: async () => ({
    data: { ok: true, organization_id: ORG, transferred: false, workspace_closed: false },
    error: null,
  }),
};

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data ?? {}), context: { supabase: userClient, userId: USER } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: admin }));

async function run() {
  const { deleteMyAccount } = await import("@/lib/delete-account.functions");
  return (deleteMyAccount as any)({ data: {} });
}

beforeEach(() => {
  calls = { list: [], remove: [], signOut: 0, updateUser: 0 };
  storageFails = null;
  lookupFails = false;
  files = ["1700000000000.jpg", "1700000001000.png"];
});

describe("removing the profile photo on account deletion", () => {
  it("removes every file in the person's folder for each org", async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.incomplete).toEqual([]);
    expect(calls.list[0]).toBe(`${ORG}/${USER}`);
    expect(calls.remove[0]).toEqual([
      `${ORG}/${USER}/1700000000000.jpg`,
      `${ORG}/${USER}/1700000001000.png`,
    ]);
  });

  it("a Storage failure on remove is named, and the deletion is still ok", async () => {
    storageFails = "remove";
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.incomplete).toEqual(["avatar"]);
  });

  it("a Storage failure on list is named, and the deletion is still ok", async () => {
    storageFails = "list";
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.incomplete).toEqual(["avatar"]);
  });

  it("not knowing which orgs to look in is named too", async () => {
    // Treating a failed lookup as "no folders" would report a clean deletion
    // with the photo still in the bucket.
    lookupFails = true;
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.incomplete).toEqual(["avatar"]);
    expect(calls.list).toEqual([]);
  });

  it("a Storage failure does not skip the identity or session steps", async () => {
    storageFails = "remove";
    await run();
    expect(calls.updateUser).toBe(1);
    expect(calls.signOut).toBe(1);
  });
});

describe("removeAvatarFolders refuses an id that is not a UUID", () => {
  // The folder is `${orgId}/${userId}`. With an empty userId it becomes
  // `${orgId}/`, which lists a whole org's photos and then removes them.
  function spyAdmin() {
    const list = vi.fn(async () => ({ data: [{ name: "a.jpg" }], error: null }));
    const remove = vi.fn(async () => ({ data: [], error: null }));
    return { admin: { storage: { from: vi.fn(() => ({ list, remove })) } }, list, remove };
  }

  it("an empty userId throws before anything is listed or removed", async () => {
    const { removeAvatarFolders } = await import("@/lib/delete-account.functions");
    const { admin, list, remove } = spyAdmin();
    await expect(removeAvatarFolders(admin, [ORG], "")).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('an orgId of "x" throws before anything is listed or removed', async () => {
    const { removeAvatarFolders } = await import("@/lib/delete-account.functions");
    const { admin, list, remove } = spyAdmin();
    await expect(removeAvatarFolders(admin, ["x"], USER)).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("one bad orgId among good ones still lists nothing", async () => {
    const { removeAvatarFolders } = await import("@/lib/delete-account.functions");
    const { admin, list, remove } = spyAdmin();
    await expect(removeAvatarFolders(admin, [ORG, "x"], USER)).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
