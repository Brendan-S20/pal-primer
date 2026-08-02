import { describe, expect, it } from "vitest";
import { updateOwnOrg } from "@/lib/org-write.server";

// The bug this exists to prevent is not a wrong value — it is a RIGHT-LOOKING
// success. PostgREST reports an UPDATE that matched zero rows as a success, so
// an RLS policy that disagrees with the permission matrix produces a green
// toast over a setting that never changed, with nothing logged anywhere.
//
// A fake client rather than a live one: what is being pinned is how this reacts
// to each of PostgREST's three answers, and two of them (zero rows, error) are
// awkward to provoke against a real database on demand.

function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Array<{ table: string; patch: unknown; id: string; selected: string }> = [];
  const client = {
    calls,
    from(table: string) {
      let patch: unknown;
      let id = "";
      const chain = {
        update(p: unknown) {
          patch = p;
          return chain;
        },
        eq(_col: string, v: string) {
          id = v;
          return chain;
        },
        select(sel: string) {
          calls.push({ table, patch, id, selected: sel });
          return Promise.resolve(result);
        },
      };
      return chain;
    },
  };
  return client;
}

describe("updateOwnOrg", () => {
  it("passes when a row comes back", async () => {
    const c = fakeClient({ data: [{ id: "org-1" }], error: null });
    await expect(updateOwnOrg(c, "org-1", { timezone: "America/Chicago" })).resolves.toBeUndefined();
    expect(c.calls).toEqual([
      { table: "organizations", patch: { timezone: "America/Chicago" }, id: "org-1", selected: "id" },
    ]);
  });

  it("throws when the update matched nothing", async () => {
    // The whole point. This is what an office_manager hit against the
    // owner-only policy, and what the handler used to report as { ok: true }.
    const c = fakeClient({ data: [], error: null });
    await expect(updateOwnOrg(c, "org-1", { contact_email: "hi@x.com" })).rejects.toThrow(
      /wasn't saved/i,
    );
  });

  it("blames us rather than the user when it fires", async () => {
    // Whoever reads this has already passed a permission check, so a failure
    // here means two layers disagree — that is our bug, and saying "permission
    // denied" would send them to argue with their own admin about it.
    const c = fakeClient({ data: [], error: null });
    await expect(updateOwnOrg(c, "org-1", {})).rejects.toThrow(/bug on our side/i);
  });

  it("surfaces a real database error unchanged", async () => {
    const c = fakeClient({ data: null, error: { message: "column does not exist" } });
    await expect(updateOwnOrg(c, "org-1", { nope: 1 })).rejects.toThrow("column does not exist");
  });

  it("treats a null payload as no rows", async () => {
    const c = fakeClient({ data: null, error: null });
    await expect(updateOwnOrg(c, "org-1", {})).rejects.toThrow(/wasn't saved/i);
  });
});
