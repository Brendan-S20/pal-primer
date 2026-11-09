import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  PET_INCIDENT_KINDS,
  PET_SAFETY_BODY_MAX,
  PET_SAFETY_BUCKET,
  PET_SAFETY_MAX_BYTES,
  VACCINE_START_RULES,
  isPetSafetyMime,
  petSafetyPhotoPath,
  type VaccineStartRule,
} from "@/lib/pet-safety";

// Per-pet safety notes and incidents, and the owner's vaccine Start rule
// (#729). Every read and write here goes through the CALLER's client, so the
// policies in 20261108152900 / 20261108153100 decide who sees and writes
// what: the pet's visibility (may_read_property) for the log, the owner for
// the rule. The checks below are for a readable error, not the safeguard.

const dogInput = z.object({ dogId: z.string().uuid() });

export const petSafetyFields = z
  .object({
    dogId: z.string().uuid(),
    entryType: z.enum(["note", "incident"]),
    incidentKind: z.enum(PET_INCIDENT_KINDS).nullable(),
    occurredAt: z.string().datetime({ offset: true }).nullable(),
    body: z.string().trim().min(1, "Say what happened.").max(PET_SAFETY_BODY_MAX),
    visitId: z.string().uuid().nullable(),
  })
  .refine((v) => (v.entryType === "incident") === !!v.incidentKind, {
    message: "An incident says what kind; a note does not.",
  });

async function petInOwnOrg(db: SupabaseClient<Database>, userId: string, dogId: string) {
  const { orgId } = await resolveCaller(db, userId);
  // RLS on dogs already hides a pet the caller may not see; the org filter
  // keeps a member of two businesses inside the one they are acting for.
  const { data: dog, error } = await db
    .from("dogs")
    .select("id")
    .eq("id", dogId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error || !dog) throw new Error("Pet not found");
  return { orgId };
}

export const listPetSafetyEntries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => dogInput.parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { orgId } = await petInOwnOrg(db, context.userId, data.dogId);
    const { data: rows, error } = await db
      .from("pet_safety_entries")
      .select(
        "id, entry_type, incident_kind, occurred_at, body, storage_path, reporter_name, reported_by, visit_id, created_at",
      )
      .eq("dog_id", data.dogId)
      .eq("organization_id", orgId)
      .order("occurred_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return Promise.all(
      (rows ?? []).map(async (row) => {
        if (!row.storage_path) return { ...row, photoUrl: null as string | null };
        // The caller's client signs, so storage RLS asks again.
        const { data: signed } = await db.storage
          .from(PET_SAFETY_BUCKET)
          .createSignedUrl(row.storage_path, 300);
        return { ...row, photoUrl: signed?.signedUrl ?? null };
      }),
    );
  });

export const addPetSafetyEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: FormData) => {
    if (!(input instanceof FormData)) throw new Error("Expected a safety log form");
    const fields = petSafetyFields.parse({
      dogId: input.get("dogId"),
      entryType: input.get("entryType"),
      incidentKind: input.get("incidentKind") || null,
      occurredAt: input.get("occurredAt") || null,
      body: input.get("body"),
      visitId: input.get("visitId") || null,
    });
    const value = input.get("photo");
    const photo = value instanceof File && value.size > 0 ? value : null;
    if (photo) {
      if (!isPetSafetyMime(photo.type)) throw new Error("Choose a JPEG, PNG, WebP or HEIC photo.");
      if (photo.size > PET_SAFETY_MAX_BYTES) throw new Error("Photos must be 10 MB or smaller.");
    }
    return { ...fields, photo };
  })
  .handler(async ({ data, context }) => {
    const db = context.supabase;
    const { orgId } = await petInOwnOrg(db, context.userId, data.dogId);
    let path: string | null = null;
    if (data.photo && isPetSafetyMime(data.photo.type)) {
      path = petSafetyPhotoPath(orgId, data.dogId, data.photo.type);
      const { error } = await db.storage
        .from(PET_SAFETY_BUCKET)
        .upload(path, data.photo, { contentType: data.photo.type, upsert: false });
      if (error) throw new Error(error.message);
    }
    const { data: row, error } = await db
      .from("pet_safety_entries")
      .insert({
        organization_id: orgId,
        dog_id: data.dogId,
        visit_id: data.visitId,
        entry_type: data.entryType,
        incident_kind: data.entryType === "incident" ? data.incidentKind : null,
        ...(data.occurredAt ? { occurred_at: data.occurredAt } : {}),
        body: data.body,
        storage_path: path,
        // The trigger stamps both from the session; these satisfy the types
        // and the policy's reported_by = auth.uid().
        reported_by: context.userId,
        reporter_name: "Staff member",
      })
      .select("id")
      .single();
    if (error || !row) {
      // A photo with no entry is an orphan nobody can see; the bucket is
      // append-only to browser keys, so the service role sweeps it. Say so.
      throw new Error(
        `${error?.message ?? "The entry was not saved"}${path ? ". The photo was uploaded but is not attached to anything." : ""}`,
      );
    }
    return { id: row.id as string };
  });

// ── the vaccine Start rule ────────────────────────────────────────────────

export const getVaccineStartRule = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase;
    const { orgId, role } = await resolveCaller(db, context.userId);
    const { data, error } = await db
      .from("organizations")
      .select("vaccine_start_rule, vaccine_start_rule_set_at")
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    // RLS lets only the office read the trail; a tech gets an empty list.
    const { data: history } = await db
      .from("org_vaccine_policy_changes")
      .select("changed_at, old_value, new_value, changed_by")
      .eq("organization_id", orgId)
      .order("changed_at", { ascending: false })
      .limit(20);
    return {
      rule: (data.vaccine_start_rule ?? "warn") as VaccineStartRule,
      setAt: data.vaccine_start_rule_set_at ?? null,
      canChange: role === "owner",
      history: history ?? [],
    };
  });

export const setVaccineStartRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ rule: z.enum(VACCINE_START_RULES) }).parse(d))
  .handler(async ({ data, context }) => {
    // manage_settings first for the usual error; the function itself is
    // owner-only and is the safeguard (set_vaccine_start_rule, 42501).
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { data: rule, error } = await context.supabase.rpc("set_vaccine_start_rule", {
      _org_id: orgId,
      _rule: data.rule,
    });
    if (error) throw new Error(error.message);
    return { rule: rule as VaccineStartRule };
  });
