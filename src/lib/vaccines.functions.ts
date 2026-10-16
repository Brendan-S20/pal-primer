import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { updateOwnOrg } from "@/lib/org-write.server";
import { REQUIRED_VACCINES, VACCINE_BUCKET, VACCINE_MIME_EXT, vaccineStatus } from "@/lib/vaccines";
import { vaccineFields, vaccineMime, vaccineFileSize } from "@/lib/vaccines.schema";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

import { loadVaccineSettings } from "@/lib/vaccines.server";

type Db = SupabaseClient<Database>;
const dogInput = z.object({ dogId: z.string().uuid() });
const recordInput = z.object({ id: z.string().uuid() });


async function officeDog(db: Db, userId: string, dogId: string, write = false) {
  const { orgId } = await resolveCaller(db, userId);
  if (write) {
    const { data, error } = await db.rpc("can_write_org", { _user_id: userId, _org_id: orgId });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Not authorized");
  }
  const { data: dog, error } = await db.from("dogs").select("id, organization_id")
    .eq("id", dogId).eq("organization_id", orgId).single();
  if (error || !dog) throw new Error("Pet not found");
  return { orgId };
}

export const getVaccineSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth]).handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    return loadVaccineSettings(context.supabase, orgId);
  });

export const setVaccineSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ rule: z.enum(["off", "warn", "block"]), required: z.array(z.enum(REQUIRED_VACCINES)).max(5) }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    await updateOwnOrg(context.supabase, orgId, { vaccine_rule: data.rule, required_vaccines: [...new Set(data.required)] });
    return { ok: true };
  });

export const getDogVaccineStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth]).inputValidator((d) => dogInput.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await officeDog(context.supabase, context.userId, data.dogId);
    const settings = await loadVaccineSettings(context.supabase, orgId);
    if (!settings.enabled) return null;
    const { data: rows, error } = await context.supabase.from("pet_vaccinations")
      .select("vaccine, expires_on, source, verified_at").eq("dog_id", data.dogId).eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return vaccineStatus(rows ?? [], settings.required, settings.today);
  });

export const listDogVaccinations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth]).inputValidator((d) => dogInput.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await officeDog(context.supabase, context.userId, data.dogId);
    const { data: rows, error } = await context.supabase.from("pet_vaccinations").select("*")
      .eq("dog_id", data.dogId).eq("organization_id", orgId).order("expires_on", { ascending: false });
    if (error) throw new Error(error.message);
    return Promise.all((rows ?? []).map(async (record) => {
      if (!record.storage_path) return { ...record, signedUrl: null };
      // The request client signs, so storage RLS checks the caller again.
      const { data: signed, error: signError } = await context.supabase.storage.from(VACCINE_BUCKET).createSignedUrl(record.storage_path, 300);
      if (signError) throw new Error(signError.message);
      return { ...record, signedUrl: signed.signedUrl };
    }));
  });

export const addVaccination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: FormData) => {
    if (!(input instanceof FormData)) throw new Error("Expected a vaccine form");
    const fields = vaccineFields.parse({ dogId: input.get("dogId"), vaccine: input.get("vaccine"),
      vaccineNote: input.get("vaccineNote") || null, givenOn: input.get("givenOn") || null, expiresOn: input.get("expiresOn") });
    const value = input.get("file");
    const file = value instanceof File && value.size > 0 ? value : null;
    if (file) { vaccineMime.parse(file.type); vaccineFileSize.parse(file.size); }
    return { ...fields, file };
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { orgId } = await officeDog(db, context.userId, data.dogId, true);
    let path: string | null = null;
    if (data.file) {
      const mime = vaccineMime.parse(data.file.type);
      path = `${orgId}/${data.dogId}/${crypto.randomUUID()}.${VACCINE_MIME_EXT[mime]}`;
      const { error } = await db.storage.from(VACCINE_BUCKET).upload(path, data.file, { contentType: mime, upsert: false });
      if (error) throw new Error(error.message);
    }
    const { error } = await db.from("pet_vaccinations").insert({ organization_id: orgId, dog_id: data.dogId,
      vaccine: data.vaccine, vaccine_note: data.vaccineNote, given_on: data.givenOn, expires_on: data.expiresOn,
      storage_path: path, file_name: data.file?.name.slice(0, 200) ?? null, source: "office", created_by: context.userId });
    if (error) {
      if (path) {
        const { error: cleanupError } = await db.storage.from(VACCINE_BUCKET).remove([path]);
        if (cleanupError) throw new Error(`${error.message}. The uploaded file could not be removed: ${cleanupError.message}`);
      }
      throw new Error(error.message);
    }
    return { ok: true };
  });

export const verifyVaccination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator((d) => recordInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: record, error: readError } = await context.supabase.from("pet_vaccinations").select("dog_id").eq("id", data.id).single();
    if (readError || !record) throw new Error("Vaccine record not found");
    const { orgId } = await officeDog(context.supabase, context.userId, record.dog_id, true);
    const { data: saved, error } = await context.supabase.from("pet_vaccinations")
      .update({ verified_by: context.userId, verified_at: new Date().toISOString() }).eq("id", data.id).eq("organization_id", orgId).select("id").single();
    if (error || !saved) throw new Error(error?.message ?? "Vaccine record not found");
    return { ok: true };
  });

export const deleteVaccination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth]).inputValidator((d) => recordInput.parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { data: record, error: readError } = await db.from("pet_vaccinations").select("dog_id, storage_path").eq("id", data.id).single();
    if (readError || !record) throw new Error("Vaccine record not found");
    const { orgId } = await officeDog(db, context.userId, record.dog_id, true);
    // Keep the row if storage refuses deletion, so the office can retry it.
    if (record.storage_path) {
      const { error } = await db.storage.from(VACCINE_BUCKET).remove([record.storage_path]);
      if (error) throw new Error(error.message);
    }
    const { data: deleted, error } = await db.from("pet_vaccinations").delete().eq("id", data.id).eq("organization_id", orgId).select("id").single();
    if (error || !deleted) throw new Error(error?.message ?? "Vaccine record not found");
    return { ok: true };
  });
