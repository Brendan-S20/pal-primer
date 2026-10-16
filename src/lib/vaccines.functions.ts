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
  const { data: dog, error } = await db
    .from("dogs")
    .select("id, organization_id")
    .eq("id", dogId)
    .eq("organization_id", orgId)
    .single();
  if (error || !dog) throw new Error("Pet not found");
  return { orgId };
}

export const getVaccineSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    return loadVaccineSettings(context.supabase, orgId);
  });

export const setVaccineSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        rule: z.enum(["off", "warn", "block"]),
        required: z.array(z.enum(REQUIRED_VACCINES)).max(5),
        bufferMin: z.number().int().min(0).max(240).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    await updateOwnOrg(context.supabase, orgId, {
      vaccine_rule: data.rule,
      required_vaccines: [...new Set(data.required)],
      ...(data.bufferMin === undefined ? {} : { groom_buffer_min: data.bufferMin }),
    });
    return { ok: true };
  });

export const getDogVaccineStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => dogInput.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await officeDog(context.supabase, context.userId, data.dogId);
    const settings = await loadVaccineSettings(context.supabase, orgId);
    if (!settings.enabled) return null;
    const { data: rows, error } = await context.supabase
      .from("pet_vaccinations")
      .select("vaccine, expires_on, source, verified_at, rejected_at")
      .eq("dog_id", data.dogId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return vaccineStatus(rows ?? [], settings.required, settings.today);
  });

export const listDogVaccinations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => dogInput.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await officeDog(context.supabase, context.userId, data.dogId);
    const { data: rows, error } = await context.supabase
      .from("pet_vaccinations")
      .select("*")
      .eq("dog_id", data.dogId)
      .eq("organization_id", orgId)
      .order("expires_on", { ascending: false });
    if (error) throw new Error(error.message);
    return Promise.all(
      (rows ?? []).map(async (record) => {
        if (!record.storage_path) return { ...record, signedUrl: null };
        // The request client signs, so storage RLS checks the caller again.
        const { data: signed, error: signError } = await context.supabase.storage
          .from(VACCINE_BUCKET)
          .createSignedUrl(record.storage_path, 300);
        if (signError) throw new Error(signError.message);
        return { ...record, signedUrl: signed.signedUrl };
      }),
    );
  });

export const addVaccination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: FormData) => {
    if (!(input instanceof FormData)) throw new Error("Expected a vaccine form");
    const fields = vaccineFields.parse({
      dogId: input.get("dogId"),
      vaccine: input.get("vaccine"),
      vaccineNote: input.get("vaccineNote") || null,
      givenOn: input.get("givenOn") || null,
      expiresOn: input.get("expiresOn"),
    });
    const value = input.get("file");
    const file = value instanceof File && value.size > 0 ? value : null;
    if (file) {
      vaccineMime.parse(file.type);
      vaccineFileSize.parse(file.size);
    }
    return { ...fields, file };
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { orgId } = await officeDog(db, context.userId, data.dogId, true);
    let path: string | null = null;
    if (data.file) {
      const mime = vaccineMime.parse(data.file.type);
      path = `${orgId}/${data.dogId}/${crypto.randomUUID()}.${VACCINE_MIME_EXT[mime]}`;
      const { error } = await db.storage
        .from(VACCINE_BUCKET)
        .upload(path, data.file, { contentType: mime, upsert: false });
      if (error) throw new Error(error.message);
    }
    const { error } = await db.from("pet_vaccinations").insert({
      organization_id: orgId,
      dog_id: data.dogId,
      vaccine: data.vaccine,
      vaccine_note: data.vaccineNote,
      given_on: data.givenOn,
      expires_on: data.expiresOn,
      storage_path: path,
      file_name: data.file?.name.slice(0, 200) ?? null,
      source: "office",
      created_by: context.userId,
    });
    if (error) {
      if (path) {
        const { error: cleanupError } = await db.storage.from(VACCINE_BUCKET).remove([path]);
        if (cleanupError)
          throw new Error(
            `${error.message}. The uploaded file could not be removed: ${cleanupError.message}`,
          );
      }
      throw new Error(error.message);
    }
    return { ok: true };
  });

export const verifyVaccination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => recordInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: record, error: readError } = await context.supabase
      .from("pet_vaccinations")
      .select("dog_id")
      .eq("id", data.id)
      .single();
    if (readError || !record) throw new Error("Vaccine record not found");
    const { orgId } = await officeDog(context.supabase, context.userId, record.dog_id, true);
    // Approving clears a rejection, so the office can change its mind.
    const { data: saved, error } = await context.supabase
      .from("pet_vaccinations")
      .update({
        verified_by: context.userId,
        verified_at: new Date().toISOString(),
        rejected_at: null,
        rejected_by: null,
        rejection_reason: null,
      })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .select("id")
      .single();
    if (error || !saved) throw new Error(error?.message ?? "Vaccine record not found");
    return { ok: true };
  });

/** Reject a client's portal upload with the reason the client will read. It
 *  stays on file, unverified, and never counts as current. */
export const rejectVaccination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    recordInput.extend({ reason: z.string().trim().min(1).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: record, error: readError } = await context.supabase
      .from("pet_vaccinations")
      .select("dog_id, source, verified_at")
      .eq("id", data.id)
      .single();
    if (readError || !record) throw new Error("Vaccine record not found");
    const { orgId } = await officeDog(context.supabase, context.userId, record.dog_id, true);
    if (record.source !== "portal" || record.verified_at)
      throw new Error("Only an unverified upload from the client can be rejected.");
    const { data: saved, error } = await context.supabase
      .from("pet_vaccinations")
      .update({
        rejected_at: new Date().toISOString(),
        rejected_by: context.userId,
        rejection_reason: data.reason,
      })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .is("verified_at", null)
      .select("id")
      .single();
    if (error || !saved) throw new Error(error?.message ?? "Vaccine record not found");
    return { ok: true };
  });

/** Client uploads nobody has approved or rejected yet, oldest first, with a
 *  link to each document. Empty for a business that does not run grooming. */
export const listPendingVaccineUploads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const settings = await loadVaccineSettings(context.supabase, orgId);
    if (!settings.enabled) return [];
    const { data: rows, error } = await context.supabase
      .from("pet_vaccinations")
      .select(
        "id, dog_id, vaccine, vaccine_note, given_on, expires_on, file_name, storage_path, created_at, dog:dogs!pet_vaccinations_dog_id_fkey(name, property:properties(client_id, client:clients(display_name)))",
      )
      .eq("organization_id", orgId)
      .eq("source", "portal")
      .is("verified_at", null)
      .is("rejected_at", null)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);
    return Promise.all(
      (rows ?? []).map(async (r) => {
        const dog = (Array.isArray(r.dog) ? r.dog[0] : r.dog) as {
          name: string;
          property: unknown;
        } | null;
        const property = (Array.isArray(dog?.property) ? dog?.property[0] : dog?.property) as {
          client_id: string;
          client: unknown;
        } | null;
        const client = (Array.isArray(property?.client) ? property?.client[0] : property?.client) as {
          display_name: string;
        } | null;
        let signedUrl: string | null = null;
        if (r.storage_path) {
          // The request client signs, so storage RLS checks the caller again.
          const { data: signed } = await context.supabase.storage
            .from(VACCINE_BUCKET)
            .createSignedUrl(r.storage_path, 300);
          signedUrl = signed?.signedUrl ?? null;
        }
        return {
          id: r.id,
          dogId: r.dog_id,
          petName: dog?.name ?? null,
          clientId: property?.client_id ?? null,
          clientName: client?.display_name ?? null,
          vaccine: r.vaccine,
          vaccineNote: r.vaccine_note,
          givenOn: r.given_on,
          expiresOn: r.expires_on,
          fileName: r.file_name,
          uploadedAt: r.created_at,
          signedUrl,
        };
      }),
    );
  });

export const deleteVaccination = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => recordInput.parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { data: record, error: readError } = await db
      .from("pet_vaccinations")
      .select("dog_id, storage_path")
      .eq("id", data.id)
      .single();
    if (readError || !record) throw new Error("Vaccine record not found");
    const { orgId } = await officeDog(db, context.userId, record.dog_id, true);
    // Keep the row if storage refuses deletion, so the office can retry it.
    if (record.storage_path) {
      const { error } = await db.storage.from(VACCINE_BUCKET).remove([record.storage_path]);
      if (error) throw new Error(error.message);
    }
    const { data: deleted, error } = await db
      .from("pet_vaccinations")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .select("id")
      .single();
    if (error || !deleted) throw new Error(error?.message ?? "Vaccine record not found");
    return { ok: true };
  });
