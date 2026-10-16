import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { VACCINE_BUCKET, VACCINE_MIME_EXT, vaccineStatus } from "@/lib/vaccines";
import { vaccineFields, vaccineMime, vaccineFileSize, vaccinePathMatches } from "@/lib/vaccines.schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { PortalSession } from "@/lib/portal-auth.server";

type Db = SupabaseClient<Database>;
const tokenInput = z.object({ token: z.string().uuid() });
const dogInput = tokenInput.extend({ dogId: z.string().uuid() });

async function portalDb() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}
async function settingsFor(db: Db, session: PortalSession) {
  const { loadVaccineSettings } = await import("@/lib/vaccines.server");
  return loadVaccineSettings(db, session.organizationId);
}
async function ownedDog(db: Db, session: PortalSession, dogId: string) {
  const { data, error } = await db.from("dogs")
    .select("id, properties!inner(client_id, organization_id)")
    .eq("id", dogId).eq("organization_id", session.organizationId).eq("active", true)
    .eq("properties.client_id", session.clientId).eq("properties.organization_id", session.organizationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Pet not found");
}
async function belowPortalCap(db: Db, dogId: string) {
  const { count, error } = await db.from("pet_vaccinations").select("id", { count: "exact", head: true })
    .eq("dog_id", dogId).eq("source", "portal");
  if (error) throw new Error(error.message);
  if (count == null || count >= 20) throw new Error("This pet has reached the 20-record upload limit. Contact the office.");
}

export const portalListVaccines = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenInput.parse(d)).handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token, { readOnly: true });
    const db = await portalDb();
    const settings = await settingsFor(db, session);
    if (!settings.enabled) return { enabled: false, pets: [] };
    const { data: dogs, error } = await db.from("dogs")
      .select("id, name, properties!inner(client_id, organization_id)")
      .eq("organization_id", session.organizationId).eq("active", true)
      .eq("properties.client_id", session.clientId).eq("properties.organization_id", session.organizationId).order("name");
    if (error) throw new Error(error.message);
    const pets = await Promise.all((dogs ?? []).map(async (dog) => {
      const { data: records, error } = await db.from("pet_vaccinations")
        .select("id, vaccine, vaccine_note, given_on, expires_on, file_name, source, verified_at, rejected_at, rejection_reason")
        .eq("dog_id", dog.id).eq("organization_id", session.organizationId).order("expires_on", { ascending: false });
      if (error) throw new Error(error.message);
      return { id: dog.id, name: dog.name, records: records ?? [], status: vaccineStatus(records ?? [], settings.required, settings.today) };
    }));
    return { enabled: true, pets };
  });

export const portalRequestVaccineUpload = createServerFn({ method: "POST" })
  .inputValidator((d) => dogInput.extend({ mime: vaccineMime, size: vaccineFileSize }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token);
    const db = await portalDb();
    await ownedDog(db, session, data.dogId);
    if (!(await settingsFor(db, session)).enabled) throw new Error("Vaccine uploads are unavailable");
    await belowPortalCap(db, data.dogId);
    const path = `${session.organizationId}/${data.dogId}/${crypto.randomUUID()}.${VACCINE_MIME_EXT[data.mime]}`;
    const { data: signed, error } = await db.storage.from(VACCINE_BUCKET).createSignedUploadUrl(path, { upsert: false });
    if (error) throw new Error(error.message);
    return { path, signedUrl: signed.signedUrl, token: signed.token };
  });

export const portalConfirmVaccineUpload = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), path: z.string().max(200), fileName: z.string().min(1).max(200), fields: vaccineFields }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token);
    const db = await portalDb();
    await ownedDog(db, session, data.fields.dogId);
    if (!(await settingsFor(db, session)).enabled) throw new Error("Vaccine uploads are unavailable");
    if (!vaccinePathMatches(data.path, session.organizationId, data.fields.dogId)) throw new Error("Invalid vaccine document path");
    await belowPortalCap(db, data.fields.dogId);
    const { data: object, error: objectError } = await db.storage.from(VACCINE_BUCKET).info(data.path);
    if (objectError || !object) throw new Error("The uploaded file was not found");
    const mime = vaccineMime.parse(object.contentType);
    vaccineFileSize.parse(object.size);
    if (!data.path.endsWith(`.${VACCINE_MIME_EXT[mime]}`)) throw new Error("The file type does not match its path");
    const { data: record, error } = await db.from("pet_vaccinations").insert({
      organization_id: session.organizationId, dog_id: data.fields.dogId, vaccine: data.fields.vaccine,
      vaccine_note: data.fields.vaccineNote, given_on: data.fields.givenOn, expires_on: data.fields.expiresOn,
      storage_path: data.path, file_name: data.fileName, source: "portal", verified_by: null, verified_at: null, created_by: null,
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { id: record.id };
  });

export const portalReadVaccineRecord = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenInput.extend({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    const session = await requirePortalSession(data.token, { readOnly: true });
    const db = await portalDb();
    const { data: record, error } = await db.from("pet_vaccinations").select("dog_id, storage_path")
      .eq("id", data.id).eq("organization_id", session.organizationId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!record?.storage_path) throw new Error("Vaccine document not found");
    await ownedDog(db, session, record.dog_id);
    const { data: signed, error: signError } = await db.storage.from(VACCINE_BUCKET).createSignedUrl(record.storage_path, 300);
    if (signError) throw new Error(signError.message);
    return { signedUrl: signed.signedUrl };
  });
