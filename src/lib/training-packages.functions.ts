import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { orgToday, DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { packageState, sessionsLeft } from "@/lib/training-packages";
import {
  bookTrainingSessions,
  holdingCount,
  requireTrainingOffice,
  sellTrainingPackage,
  type ClientPackage,
  type ListedClientPackage,
  type ServicePackage,
  type TrainingDb,
} from "@/lib/training-packages.server";

const id = z.string().uuid();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, "Choose a valid date.");
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable()
  .optional();

export const listServicePackages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const { data, error } = await db
      .from("service_packages")
      .select("*")
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    return { packages: (data ?? []) as ServicePackage[] };
  });

export const servicePackageSchema = z.object({
  id: id.optional(),
  serviceId: id,
  name: z.string().trim().min(1).max(80),
  sessionsCount: z.number().int().min(1).max(100),
  priceCents: z.number().int().min(0).max(2147483647),
  expiresAfterDays: z.number().int().min(1).max(730).nullable(),
});

export const saveServicePackage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => servicePackageSchema.parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const values = {
      name: data.name,
      service_id: data.serviceId,
      sessions_count: data.sessionsCount,
      price_cents: data.priceCents,
      expires_after_days: data.expiresAfterDays,
    };
    const result = data.id
      ? await db
          .from("service_packages")
          .update(values)
          .eq("id", data.id)
          .eq("organization_id", orgId)
          .select("id")
          .single()
      : await db
          .from("service_packages")
          .insert({ ...values, organization_id: orgId, active: false })
          .select("id")
          .single();
    if (result.error) throw new Error(result.error.message);
    return { id: result.data.id as string };
  });

export const setServicePackageActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id, active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const result = await db
      .from("service_packages")
      .update({ active: data.active })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const sellPackage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: id, servicePackageId: id, dogId: id.optional(), requestId: id }).parse(d),
  )
  .handler(async ({ data, context }) =>
    sellTrainingPackage(context.supabase as TrainingDb, context.userId, data),
  );

export const listClientPackages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: id }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const { orgId } = await resolveCaller(db, context.userId);
    const [packs, org] = await Promise.all([
      db
        .from("client_packages")
        .select("*")
        .eq("client_id", data.clientId)
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false }),
      db.from("organizations").select("timezone").eq("id", orgId).single(),
    ]);
    if (packs.error) throw new Error(packs.error.message);
    if (org.error) throw new Error(org.error.message);
    const today = orgToday(org.data.timezone || DEFAULT_ORG_TIMEZONE);
    const packages: ListedClientPackage[] = await Promise.all(
      ((packs.data ?? []) as ClientPackage[]).map(async (pack) => {
        const held = await holdingCount(db, pack.id);
        const invoice = pack.invoice_id
          ? await db
              .from("invoices")
              .select("id, number, status")
              .eq("id", pack.invoice_id)
              .maybeSingle()
          : { data: null, error: null };
        if (invoice.error) throw new Error(invoice.error.message);
        return {
          ...pack,
          held,
          left: sessionsLeft(pack),
          free: Math.max(0, pack.sessions_count - held),
          state: packageState(pack, today),
          invoice: invoice.data as ListedClientPackage["invoice"],
        };
      }),
    );
    return { packages };
  });

const bookingSchema = z
  .object({
    clientPackageId: id,
    propertyId: id,
    startOn: day,
    weekday: z.number().int().min(0).max(6),
    earliestTime: time,
    latestTime: time,
    staffId: id.optional(),
    count: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (v) =>
      (!v.earliestTime && !v.latestTime) ||
      (!!v.earliestTime && !!v.latestTime && v.earliestTime < v.latestTime),
    "Set an earliest arrival before the latest arrival.",
  );

export const bookPackageSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => bookingSchema.parse(d))
  .handler(async ({ data, context }) =>
    bookTrainingSessions(context.supabase as TrainingDb, context.userId, data),
  );

export const bookOneSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientPackageId: id,
        propertyId: id,
        date: day,
        window: z.object({ earliestTime: time, latestTime: time }).optional(),
        staffId: id.optional(),
      })
      .refine(
        (v) =>
          !v.window ||
          (!v.window.earliestTime && !v.window.latestTime) ||
          (!!v.window.earliestTime &&
            !!v.window.latestTime &&
            v.window.earliestTime < v.window.latestTime),
        "Set an earliest arrival before the latest arrival.",
      )
      .parse(d),
  )
  .handler(async ({ data, context }) =>
    bookTrainingSessions(
      context.supabase as TrainingDb,
      context.userId,
      {
        clientPackageId: data.clientPackageId,
        propertyId: data.propertyId,
        startOn: data.date,
        weekday: new Date(`${data.date}T00:00:00Z`).getUTCDay(),
        ...data.window,
        staffId: data.staffId,
      },
      true,
    ),
  );

export const cancelClientPackage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientPackageId: id }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const result = await db
      .from("client_packages")
      .update({ status: "canceled" })
      .eq("id", data.clientPackageId)
      .eq("organization_id", orgId)
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

export const extendClientPackage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientPackageId: id, expiresOn: day.nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const { data: pack, error } = await db
      .from("client_packages")
      .select("expires_on")
      .eq("id", data.clientPackageId)
      .eq("organization_id", orgId)
      .single();
    if (error) throw new Error(error.message);
    if (!pack.expires_on || (data.expiresOn && data.expiresOn < pack.expires_on))
      throw new Error("Choose a later expiry date, or no expiry.");
    const result = await db
      .from("client_packages")
      .update({ expires_on: data.expiresOn })
      .eq("id", data.clientPackageId)
      .eq("organization_id", orgId)
      .select("id")
      .single();
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  });

/** RLS checks the target visit. The SQL helper returns its position in the package. */
export const getTrainingSession = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: id }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const result = await db
      .from("visits")
      .select("client_packages(sessions_count)")
      .eq("id", data.visitId)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data?.client_packages) return null;
    const number = await db.rpc("client_package_session_number", { _visit_id: data.visitId });
    if (number.error) throw new Error(number.error.message);
    return number.data == null
      ? null
      : { n: number.data as number, total: result.data.client_packages.sessions_count as number };
  });

export const listTrainingBookingOptions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: id }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const [properties, dogs, staff, packages] = await Promise.all([
      db
        .from("properties")
        .select("id, street")
        .eq("client_id", data.clientId)
        .eq("organization_id", orgId)
        .is("archived_at", null),
      db
        .from("dogs")
        .select("id, name, property_id, properties!inner(client_id)")
        .eq("properties.client_id", data.clientId)
        .eq("organization_id", orgId)
        .eq("active", true),
      db
        .from("staff")
        .select("id, display_name")
        .eq("organization_id", orgId)
        .eq("active", true)
        .eq("is_field_tech", true),
      db
        .from("service_packages")
        .select("*, services(name)")
        .eq("organization_id", orgId)
        .eq("active", true)
        .order("name"),
    ]);
    for (const result of [properties, dogs, staff, packages])
      if (result.error) throw new Error(result.error.message);
    return {
      properties: (properties.data ?? []) as { id: string; street: string }[],
      dogs: (dogs.data ?? []) as { id: string; name: string; property_id: string }[],
      staff: (staff.data ?? []) as { id: string; display_name: string }[],
      packages: (packages.data ?? []) as (ServicePackage & { services: { name: string } })[],
    };
  });
