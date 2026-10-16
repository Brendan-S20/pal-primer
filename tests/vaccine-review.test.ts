import { beforeEach, describe, expect, it, vi } from "vitest";
import { groomVaccineDecision, vaccineStatus } from "@/lib/vaccines";

// A client's portal upload is unverified until the office approves it, and a
// rejected one never counts. The office reviews against a fake database that
// records every query; nothing here reaches a real Supabase project.

describe("a rejected upload is not a record", () => {
  const today = "2026-10-16";
  const verified = {
    vaccine: "rabies",
    expires_on: "2026-12-01",
    source: "office",
    verified_at: "x",
  };
  const upload = {
    vaccine: "rabies",
    expires_on: "2028-01-01",
    source: "portal",
    verified_at: null,
  };

  it("counts an unverified upload, flagged, and warns under either rule", () => {
    const status = vaccineStatus([upload], ["rabies"], today);
    expect(status.vaccines[0]).toMatchObject({ state: "ok", unverified: true });
    expect(groomVaccineDecision("block", status)).toBe("warn");
  });

  it("skips a rejected upload, so the pet is missing the vaccine", () => {
    const status = vaccineStatus(
      [{ ...upload, rejected_at: "2026-10-16T10:00:00Z" }],
      ["rabies"],
      today,
    );
    expect(status.vaccines[0]).toMatchObject({
      state: "missing",
      expiresOn: null,
      unverified: false,
    });
    expect(groomVaccineDecision("block", status)).toBe("block");
  });

  it("falls back to the record the office already had", () => {
    const status = vaccineStatus(
      [verified, { ...upload, rejected_at: "2026-10-16T10:00:00Z" }],
      ["rabies"],
      today,
    );
    expect(status.vaccines[0]).toMatchObject({
      state: "ok",
      expiresOn: "2026-12-01",
      unverified: false,
    });
  });
});

type Q = {
  table: string;
  op: string;
  cols?: string;
  filters: Array<[string, ...unknown[]]>;
  payload?: unknown;
};
const state = vi.hoisted(() => ({
  queries: [] as Q[],
  record: {} as Record<string, unknown>,
  lines: ["mobile_grooming"] as string[],
  canWrite: true,
}));

function makeDb() {
  return {
    from(table: string) {
      const q: Q = { table, op: "select", filters: [] };
      state.queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const f of ["eq", "in", "is", "order", "limit", "not"])
        chain[f] = (...args: unknown[]) => {
          q.filters.push([f, ...args]);
          return chain;
        };
      chain.select = (cols?: string) => {
        if (q.op === "select") q.cols = cols;
        return chain;
      };
      chain.update = (payload: unknown) => {
        q.op = "update";
        q.payload = payload;
        return chain;
      };
      const settle = () => {
        if (table === "organizations")
          return Promise.resolve({
            data: {
              service_lines: state.lines,
              vaccine_rule: "warn",
              required_vaccines: ["rabies"],
              timezone: "America/Chicago",
              groom_buffer_min: 15,
            },
            error: null,
          });
        if (table === "dogs")
          return Promise.resolve({ data: { id: "dog-1", organization_id: "org-1" }, error: null });
        if (table === "pet_vaccinations" && q.op === "update")
          return Promise.resolve({ data: { id: "rec-1" }, error: null });
        if (table === "pet_vaccinations" && q.cols?.startsWith("id, dog_id"))
          return Promise.resolve({
            data: [
              {
                id: "rec-1",
                dog_id: "dog-1",
                vaccine: "rabies",
                vaccine_note: null,
                given_on: null,
                expires_on: "2027-10-01",
                file_name: "card.jpg",
                storage_path: "org/dog/file.jpg",
                created_at: "2026-10-15T12:00:00Z",
                dog: {
                  name: "Biscuit",
                  property: { client_id: "client-1", client: { display_name: "Pat" } },
                },
              },
            ],
            error: null,
          });
        return Promise.resolve({ data: state.record, error: null });
      };
      chain.single = settle;
      chain.maybeSingle = settle;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        settle().then(res, rej);
      return chain;
    },
    rpc: async () => ({ data: state.canWrite, error: null }),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }),
      }),
    },
  };
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({
            data: validate(args?.data),
            context: { supabase: makeDb(), userId: "office-user" },
          }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: "org-1" }),
  resolveCaller: async () => ({ orgId: "org-1" }),
}));
vi.mock("@/lib/org-write.server", () => ({ updateOwnOrg: async () => {} }));

import {
  listPendingVaccineUploads,
  rejectVaccination,
  verifyVaccination,
} from "@/lib/vaccines.functions";

beforeEach(() => {
  state.queries = [];
  state.lines = ["mobile_grooming"];
  state.canWrite = true;
  state.record = { dog_id: "dog-1", source: "portal", verified_at: null };
});

const ID = "11111111-1111-4111-8111-111111111111";
const updates = () => state.queries.filter((q) => q.op === "update");

describe("the office reviews a portal upload", () => {
  it("lists only portal uploads nobody has reviewed, with the pet, client and document", async () => {
    const rows = await listPendingVaccineUploads();
    expect(rows).toEqual([
      expect.objectContaining({
        id: "rec-1",
        petName: "Biscuit",
        clientName: "Pat",
        clientId: "client-1",
        signedUrl: "https://signed",
      }),
    ]);
    const q = state.queries.find((x) => x.table === "pet_vaccinations")!;
    expect(q.filters).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", "org-1"],
        ["eq", "source", "portal"],
        ["is", "verified_at", null],
        ["is", "rejected_at", null],
      ]),
    );
  });

  it("lists nothing for a business that does not groom", async () => {
    state.lines = ["pet_waste"];
    expect(await listPendingVaccineUploads()).toEqual([]);
    expect(state.queries.some((q) => q.table === "pet_vaccinations")).toBe(false);
  });

  it("approves by verifying and clearing any rejection", async () => {
    await verifyVaccination({ data: { id: ID } });
    expect(updates()[0].payload).toMatchObject({
      verified_by: "office-user",
      rejected_at: null,
      rejected_by: null,
      rejection_reason: null,
    });
  });

  it("rejects with the reason the client will read", async () => {
    await rejectVaccination({ data: { id: ID, reason: "  The photo is blurry  " } });
    const u = updates()[0];
    expect(u.payload).toMatchObject({
      rejected_by: "office-user",
      rejection_reason: "The photo is blurry",
    });
    expect(u.filters).toContainEqual(["is", "verified_at", null]);
  });

  it("refuses a rejection with no reason", async () => {
    await expect(rejectVaccination({ data: { id: ID, reason: "   " } })).rejects.toThrow();
    expect(updates()).toEqual([]);
  });

  it("refuses to reject the office's own record or one already verified", async () => {
    state.record = { dog_id: "dog-1", source: "office", verified_at: null };
    await expect(rejectVaccination({ data: { id: ID, reason: "No" } })).rejects.toThrow(
      /Only an unverified upload/,
    );
    state.record = { dog_id: "dog-1", source: "portal", verified_at: "2026-10-01T00:00:00Z" };
    await expect(rejectVaccination({ data: { id: ID, reason: "No" } })).rejects.toThrow(
      /Only an unverified upload/,
    );
    expect(updates()).toEqual([]);
  });

  it("refuses somebody who cannot write for the business", async () => {
    state.canWrite = false;
    await expect(rejectVaccination({ data: { id: ID, reason: "Blurry" } })).rejects.toThrow(
      "Not authorized",
    );
    expect(updates()).toEqual([]);
  });
});
