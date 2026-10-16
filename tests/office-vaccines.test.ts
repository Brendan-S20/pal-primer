import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ db: null as any, allowed: true, insertFails: false, cleanupFails: false, deleteFails: false, calls: [] as any[] }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  let validate = (d: any) => d;
  const b: any = { middleware: () => b, inputValidator: (v: any) => { validate = v; return b; }, handler: (h: any) => async (opts: any = {}) => h({ data: validate(opts.data), context: { supabase: state.db, userId: "user" } }) };
  return b;
} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({ resolveCaller: async () => ({ orgId: org }), requirePermission: vi.fn(async () => {
  if (!state.allowed) throw new Error("Not authorized");
  return { orgId: org };
}) }));
import { addVaccination, deleteVaccination, listDogVaccinations, setVaccineSettings, verifyVaccination } from "@/lib/vaccines.functions";
import { requirePermission } from "@/lib/authz.server";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dog = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const path = `${org}/${dog}/${id}.pdf`;
let storage: any;
let record: any;
function form() {
  const data = new FormData();
  data.set("dogId", dog); data.set("vaccine", "rabies"); data.set("expiresOn", "2027-01-01");
  data.set("file", new File(["%PDF"], "rabies.pdf", { type: "application/pdf" }));
  return data;
}
beforeEach(() => {
  vi.clearAllMocks(); state.allowed = true; state.insertFails = false; state.cleanupFails = false; state.deleteFails = false; state.calls = [];
  record = { id, dog_id: dog, storage_path: path };
  storage = { upload: vi.fn(async () => ({ error: null })), remove: vi.fn(async () => ({ error: state.cleanupFails ? { message: "Storage unavailable" } : null })), createSignedUrl: vi.fn(async () => ({ data: { signedUrl: "signed" }, error: null })) };
  state.db = { storage: { from: vi.fn(() => storage) }, rpc: async () => ({ data: state.allowed, error: null }), from: (table: string) => {
    let op = "select";
    const result = (single = false) => {
      const data = table === "dogs" ? [{ id: dog, organization_id: org }] : table === "pet_vaccinations" ? [record] : [{ id: org }];
      const error = op === "insert" && state.insertFails || op === "delete" && state.deleteFails ? { message: "Write failed" } : null;
      return { data: single ? data[0] : data, error };
    };
    const q: any = { select: () => q, eq: () => q, order: () => q,
      insert: (data: any) => { op = "insert"; state.calls.push({ table, op, data }); return q; },
      update: (data: any) => { op = "update"; state.calls.push({ table, op, data }); return q; },
      delete: () => { op = "delete"; state.calls.push({ table, op }); return q; },
      single: async () => result(true), then: (r: any, j: any) => Promise.resolve(result()).then(r, j) };
    return q;
  } };
});
describe("office vaccine files use the caller", () => {
  it("signs listed documents for 300 seconds on the caller's client", async () => {
    await listDogVaccinations({ data: { dogId: dog } });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(path, 300);
  });
  it("uploads a private file and inserts an office record without trusting an org input", async () => {
    await addVaccination({ data: form() });
    expect(storage.upload.mock.calls[0][0]).toMatch(new RegExp(`^${org}/${dog}/[0-9a-f-]{36}\\.pdf$`));
    expect(state.calls[0].data).toMatchObject({ dog_id: dog, organization_id: org, source: "office", created_by: "user" });
    expect(storage.remove).not.toHaveBeenCalled();
  });
  it("removes the uploaded file when inserting the record fails", async () => {
    state.insertFails = true;
    await expect(addVaccination({ data: form() })).rejects.toThrow("Write failed");
    expect(storage.remove).toHaveBeenCalledWith([storage.upload.mock.calls[0][0]]);
  });
  it("reports failed cleanup and keeps a record when storage deletion fails", async () => {
    state.insertFails = true; state.cleanupFails = true;
    await expect(addVaccination({ data: form() })).rejects.toThrow("uploaded file could not be removed");
    state.calls = [];
    await expect(deleteVaccination({ data: { id } })).rejects.toThrow("Storage unavailable");
    expect(state.calls).toEqual([]);
  });
  it("deletes both the document and row", async () => {
    await deleteVaccination({ data: { id } });
    expect(storage.remove).toHaveBeenCalledWith([path]);
    expect(state.calls).toEqual([{ table: "pet_vaccinations", op: "delete" }]);
  });
  it("records the caller and time when verified", async () => {
    await verifyVaccination({ data: { id } });
    expect(state.calls[0].data.verified_by).toBe("user");
    expect(Number.isNaN(Date.parse(state.calls[0].data.verified_at))).toBe(false);
  });
  it("refuses office writes when can_write_org refuses them", async () => {
    state.allowed = false;
    await expect(addVaccination({ data: form() })).rejects.toThrow("Not authorized");
    await expect(verifyVaccination({ data: { id } })).rejects.toThrow("Not authorized");
    await expect(deleteVaccination({ data: { id } })).rejects.toThrow("Not authorized");
    expect(storage.upload).not.toHaveBeenCalled();
    expect(state.calls).toEqual([]);
  });
  it("checks manage_settings and saves both business rules", async () => {
    await setVaccineSettings({ data: { rule: "block", required: ["rabies", "dhpp"] } });
    expect(requirePermission).toHaveBeenCalledWith(state.db, "user", "manage_settings");
    expect(state.calls[0].data).toEqual({ vaccine_rule: "block", required_vaccines: ["rabies", "dhpp"] });
    state.allowed = false;
    await expect(setVaccineSettings({ data: { rule: "off", required: [] } })).rejects.toThrow("Not authorized");
  });
});
