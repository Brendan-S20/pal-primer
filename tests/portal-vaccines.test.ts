import { beforeEach, describe, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({ db: null as any, preview: false, noSession: false }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  let validate = (d: any) => d;
  const b: any = { inputValidator: (v: any) => { validate = v; return b; }, handler: (h: any) => async (opts: any) => h({ data: validate(opts.data) }) };
  return b;
} }));
vi.mock("@/integrations/supabase/client.server", () => ({ get supabaseAdmin() { return fixtures.db; } }));
vi.mock("@/lib/portal-auth.server", () => ({ requirePortalSession: vi.fn(async (_token: string, opts: any = {}) => {
  if (fixtures.noSession) throw new Error("PORTAL_VERIFICATION_REQUIRED");
  if (fixtures.preview && !opts.readOnly) throw new Error("Preview is read only");
  return { clientId: "client-a", organizationId: org, preview: fixtures.preview };
}) }));
import { portalConfirmVaccineUpload, portalListVaccines, portalReadVaccineRecord, portalRequestVaccineUpload } from "@/lib/portal-vaccines.functions";
import { requirePortalSession } from "@/lib/portal-auth.server";
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const dogA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const dogB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const inactive = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const token = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const recordId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const path = (dogId: string) => `${org}/${dogId}/${recordId}.pdf`;
let rows: Record<string, any[]>;
let storage: any;
let metadata: any;
let objectExists: boolean;

function mockDb() {
  storage = { createSignedUploadUrl: vi.fn(async (p: string) => ({ data: { signedUrl: `signed:${p}`, token: "upload-token" }, error: null })),
    createSignedUrl: vi.fn(async (p: string) => ({ data: { signedUrl: `read:${p}` }, error: null })),
    info: vi.fn(async () => objectExists ? { data: metadata, error: null } : { data: null, error: { message: "Not found" } }) };
  return { storage: { from: vi.fn(() => storage) }, from: (table: string) => {
    const filters: ((r: any) => boolean)[] = [];
    let inserted: any;
    const result = (single = false) => {
      if (inserted) rows[table].push(inserted);
      const data = inserted ? [inserted] : rows[table].filter((r) => filters.every((f) => f(r)));
      return { data: single ? data[0] ?? null : data, count: data.length, error: null };
    };
    const q: any = { select: () => q, eq: (key: string, value: any) => { filters.push((r) => key.split(".").reduce((v, k) => v?.[k], r) === value); return q; },
      order: () => q, insert: (v: any) => { inserted = { id: recordId, ...v }; return q; },
      single: async () => result(true), maybeSingle: async () => result(true), then: (r: any, j: any) => Promise.resolve(result()).then(r, j) };
    return q;
  } };
}
beforeEach(() => {
  fixtures.preview = false; fixtures.noSession = false; vi.clearAllMocks(); objectExists = true;
  metadata = { size: 100, contentType: "application/pdf" };
  rows = {
    organizations: [{ id: org, service_lines: ["mobile_grooming"], vaccine_rule: "warn", required_vaccines: ["rabies"], timezone: "America/Chicago" }],
    dogs: [
      { id: dogA, organization_id: org, name: "Our pet", active: true, properties: { client_id: "client-a", organization_id: org } },
      { id: dogB, organization_id: org, name: "Other client's pet", active: true, properties: { client_id: "client-b", organization_id: org } },
      { id: inactive, organization_id: org, name: "Inactive pet", active: false, properties: { client_id: "client-a", organization_id: org } },
    ],
    pet_vaccinations: [{ id: recordId, dog_id: dogB, organization_id: org, storage_path: path(dogB), vaccine: "rabies", source: "office", expires_on: "2027-01-01", verified_at: null }],
  };
  fixtures.db = mockDb();
});
const request = (dogId: string, extra = {}) => portalRequestVaccineUpload({ data: { token, dogId, mime: "application/pdf", size: 100, ...extra } });
const confirm = (dogId: string, filePath = path(dogId)) => portalConfirmVaccineUpload({ data: { token, path: filePath, fileName: "rabies.pdf", fields: { dogId, vaccine: "rabies", expiresOn: "2027-01-01" } } });

describe("portal vaccine ownership", () => {
  it("lists only the session client's active pets and their records", async () => {
    const data = await portalListVaccines({ data: { token } });
    expect(data.pets.map((p) => p.id)).toEqual([dogA]);
    expect(data.pets[0].records).toEqual([]);
    expect(data.pets[0].status.overall).toBe("missing");
    expect(requirePortalSession).toHaveBeenCalledWith(token, { readOnly: true });
  });
  it.each([dogB, inactive])("cannot request or confirm an upload for %s", async (dogId) => {
    await expect(request(dogId)).rejects.toThrow("Pet not found");
    await expect(confirm(dogId)).rejects.toThrow("Pet not found");
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(storage.info).not.toHaveBeenCalled();
    expect(rows.pet_vaccinations).toHaveLength(1);
  });
  it("cannot sign another client's document in the same business", async () => {
    await expect(portalReadVaccineRecord({ data: { token, id: recordId } })).rejects.toThrow("Pet not found");
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("cannot sign a record from another business", async () => {
    rows.pet_vaccinations[0].organization_id = dogB;
    await expect(portalReadVaccineRecord({ data: { token, id: recordId } })).rejects.toThrow("Vaccine document not found");
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("requires a verified portal session for every endpoint", async () => {
    fixtures.noSession = true;
    for (const call of [() => portalListVaccines({ data: { token } }), () => request(dogA), () => confirm(dogA), () => portalReadVaccineRecord({ data: { token, id: recordId } })]) {
      await expect(call()).rejects.toThrow("PORTAL_VERIFICATION_REQUIRED");
    }
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });
  it("lets a staff preview read but refuses both upload steps", async () => {
    fixtures.preview = true;
    await expect(portalListVaccines({ data: { token } })).resolves.toMatchObject({ enabled: true });
    await expect(request(dogA)).rejects.toThrow("Preview is read only");
    await expect(confirm(dogA)).rejects.toThrow("Preview is read only");
  });
});

describe("portal vaccine upload checks", () => {
  it("generates an exact server-owned path from the MIME type", async () => {
    const data = await request(dogA);
    expect(data.path).toMatch(new RegExp(`^${org}/${dogA}/[0-9a-f-]{36}\\.pdf$`));
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(data.path, { upsert: false });
  });
  it("confirms the exact stored file and writes an unverified portal record", async () => {
    await confirm(dogA);
    expect(storage.info).toHaveBeenCalledWith(path(dogA));
    expect(rows.pet_vaccinations.at(-1)).toMatchObject({ organization_id: org, dog_id: dogA, storage_path: path(dogA), source: "portal", verified_at: null, verified_by: null, created_by: null });
  });
  it("rejects a foreign path before checking storage", async () => {
    await expect(confirm(dogA, path(dogB))).rejects.toThrow("Invalid vaccine document path");
    expect(storage.info).not.toHaveBeenCalled();
  });
  it("requires the object to exist and validates stored size and MIME", async () => {
    objectExists = false;
    await expect(confirm(dogA)).rejects.toThrow("uploaded file was not found");
    objectExists = true; metadata.size = 10485761;
    await expect(confirm(dogA)).rejects.toThrow();
    metadata = { size: 100, contentType: "text/html" };
    await expect(confirm(dogA)).rejects.toThrow();
    metadata.contentType = "image/png";
    await expect(confirm(dogA)).rejects.toThrow("file type does not match");
    expect(rows.pet_vaccinations).toHaveLength(1);
  });
  it("rejects unsupported MIME types and oversized requests before signing", async () => {
    await expect(request(dogA, { mime: "text/html" })).rejects.toThrow();
    await expect(request(dogA, { size: 10485761 })).rejects.toThrow();
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });
  it("refuses more requests and confirmations when the pet has 20 portal records", async () => {
    rows.pet_vaccinations = Array.from({ length: 20 }, () => ({ dog_id: dogA, source: "portal" }));
    await expect(request(dogA)).rejects.toThrow("20-record upload limit");
    await expect(confirm(dogA)).rejects.toThrow("20-record upload limit");
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(storage.info).not.toHaveBeenCalled();
  });
  it("gates uploads and the list on the grooming service line", async () => {
    rows.organizations[0].service_lines = ["pet_waste"];
    await expect(portalListVaccines({ data: { token } })).resolves.toEqual({ enabled: false, pets: [] });
    await expect(request(dogA)).rejects.toThrow("unavailable");
    await expect(confirm(dogA)).rejects.toThrow("unavailable");
  });
  it("signs an owned file for 300 seconds", async () => {
    rows.pet_vaccinations[0].dog_id = dogA; rows.pet_vaccinations[0].storage_path = path(dogA);
    await portalReadVaccineRecord({ data: { token, id: recordId } });
    expect(storage.createSignedUrl).toHaveBeenCalledWith(path(dogA), 300);
  });
});
