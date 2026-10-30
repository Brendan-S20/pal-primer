import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { orgToday, DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { holdsSession, packageState, runningLow, sessionsLeft } from "@/lib/training-packages";
import {
  bookTrainingSessions,
  lessonCounts,
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

export const ensureTrainingCatalog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as TrainingDb;
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(db, context.userId, "manage_pricing");
    const { ensureTrainingDefaults } = await import("@/lib/training-package-seed.server");
    await ensureTrainingDefaults(db, orgId);
    return { ok: true as const };
  });

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
        const { held, bookedAfterToday } = await lessonCounts(db, pack.id, today);
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
          bookedAfterToday,
          left: sessionsLeft(pack),
          free: Math.max(0, pack.sessions_count - held),
          state: packageState(pack, today),
          invoice: invoice.data as ListedClientPackage["invoice"],
        };
      }),
    );
    return { packages };
  });

export type PackageOverviewRow = {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  dogName: string | null;
  sessionsCount: number;
  /** Sessions used, as the package counts them (completed, and missed or
   *  late-canceled ones the rule charged). */
  used: number;
  /** Lessons on the schedule. */
  booked: number;
  /** Sessions free to book: neither used nor on the schedule. */
  toBook: number;
  expiresOn: string | null;
  runningLow: boolean;
  unpaid: boolean;
};

/** Every running package in the business, for the office's Training
 *  packages page: who holds it, how many sessions are used, booked and still
 *  to book, when it expires, and whether it is running low or unpaid. The
 *  ones running low come first. Read through RLS, like a client's own list. */
export const listTrainingPackagesOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as TrainingDb;
    const { orgId } = await resolveCaller(db, context.userId);
    const [packs, org] = await Promise.all([
      db
        .from("client_packages")
        .select(
          "id, name, client_id, dog_id, sessions_count, sessions_used, expires_on, status, invoice_id, clients(display_name), dogs(name)",
        )
        .eq("organization_id", orgId)
        .eq("status", "active")
        .order("expires_on", { ascending: true, nullsFirst: false }),
      db.from("organizations").select("timezone").eq("id", orgId).single(),
    ]);
    if (packs.error) throw new Error(packs.error.message);
    if (org.error) throw new Error(org.error.message);
    const today = orgToday(org.data.timezone || DEFAULT_ORG_TIMEZONE);
    type Row = ClientPackage & {
      client_id: string;
      clients: { display_name: string | null } | null;
      dogs: { name: string | null } | null;
    };
    const rows = ((packs.data ?? []) as unknown as Row[]).filter(
      (p) => packageState(p, today) === "active",
    );
    const ids = rows.map((p) => p.id);
    const invoiceIds = rows.map((p) => p.invoice_id).filter((v): v is string => !!v);
    const [lessons, invoices] = await Promise.all([
      ids.length
        ? db
            .from("visits")
            .select("client_package_id, status, skip_billable")
            .in("client_package_id", ids)
        : { data: [], error: null },
      invoiceIds.length
        ? db.from("invoices").select("id, status").in("id", invoiceIds)
        : { data: [], error: null },
    ]);
    if (lessons.error) throw new Error(lessons.error.message);
    if (invoices.error) throw new Error(invoices.error.message);
    // Per package: lessons on the schedule, and every lesson that holds a
    // session (on the schedule, or used). The rest are free to book, as on
    // the client's own tab (free = sessions - held).
    const booked = new Map<string, number>();
    const held = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const v of (lessons.data ?? []) as {
      client_package_id: string;
      status: string;
      skip_billable: boolean;
    }[]) {
      if (holdsSession(v)) bump(held, v.client_package_id);
      if (v.status === "scheduled" || v.status === "in_progress") bump(booked, v.client_package_id);
    }
    const openInvoice = new Set(
      ((invoices.data ?? []) as { id: string; status: string }[])
        .filter((i) => i.status === "open" || i.status === "draft")
        .map((i) => i.id),
    );
    const out: PackageOverviewRow[] = rows.map((p) => {
      return {
        id: p.id,
        name: p.name,
        clientId: p.client_id,
        clientName: p.clients?.display_name ?? "Client",
        dogName: p.dogs?.name ?? null,
        sessionsCount: p.sessions_count,
        used: p.sessions_used,
        booked: booked.get(p.id) ?? 0,
        toBook: Math.max(0, p.sessions_count - (held.get(p.id) ?? 0)),
        expiresOn: p.expires_on,
        runningLow: runningLow(p, today),
        unpaid: !!p.invoice_id && openInvoice.has(p.invoice_id),
      };
    });
    out.sort((a, b) => Number(b.runningLow) - Number(a.runningLow));
    return { today, packages: out };
  });

const lessonTime = {
  startTime: time,
  minutes: z.number().int().min(15).max(480).optional(),
  allowOverlap: z.boolean().optional(),
};

const bookingSchema = z.object({
  clientPackageId: id,
  propertyId: id,
  startOn: day,
  weekday: z.number().int().min(0).max(6),
  ...lessonTime,
  staffId: id.optional(),
  count: z.number().int().min(1).max(100).optional(),
});

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
        ...lessonTime,
        staffId: id.optional(),
      })
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
        startTime: data.startTime,
        minutes: data.minutes,
        allowOverlap: data.allowOverlap,
        staffId: data.staffId,
      },
      true,
    ),
  );

/** Canceling stops new bookings. The office chooses whether lessons booked
 * after today go with it or stay so they can still be completed. Lessons on
 * or before today are never canceled here. One transaction in the database. */
export const cancelClientPackage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientPackageId: id, cancelBooked: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    await requireTrainingOffice(db, context.userId);
    const result = await db.rpc("cancel_client_package", {
      _client_package_id: data.clientPackageId,
      _cancel_booked: data.cancelBooked,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true as const, canceledLessons: (result.data as number) ?? 0 };
  });

export const getTrainingSessionRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const db = context.supabase as TrainingDb;
    const { orgId } = await resolveCaller(db, context.userId);
    const { data, error } = await db
      .from("organizations")
      .select("training_late_cancel_hours, training_missed_uses_session, training_share_progress")
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    return {
      lateCancelHours: data.training_late_cancel_hours as number,
      missedUsesSession: data.training_missed_uses_session as boolean,
      /** Whether the client portal shows lesson notes and homework. */
      shareProgress: data.training_share_progress !== false,
    };
  });

export const saveTrainingSessionRules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        lateCancelHours: z.number().int().min(0).max(168),
        missedUsesSession: z.boolean(),
        shareProgress: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(db, context.userId, "manage_settings");
    const result = await db.rpc("set_training_session_rules", {
      _org_id: orgId,
      _late_cancel_hours: data.lateCancelHours,
      _missed_uses_session: data.missedUsesSession,
    });
    if (result.error) throw new Error(result.error.message);
    if (data.shareProgress !== undefined) {
      const shared = await db.rpc("set_training_share_progress", {
        _org_id: orgId,
        _share: data.shareProgress,
      });
      if (shared.error) throw new Error(shared.error.message);
    }
    return { ok: true as const };
  });

/**
 * Book the lesson a client asked for in the portal, on the day and at the
 * time they asked, from the package they asked from, and resolve the request
 * so the portal shows it booked. The booking is bookOneSession's
 * (bookTrainingSessions), so every package rule applies; no trainer is
 * assigned here, and the office assigns one on the schedule.
 */
export const bookLessonRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ticketId: id }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const { data: ticket, error } = await db
      .from("qc_tickets")
      .select(
        "id, category, client_package_id, property_id, requested_on, requested_time, booked_visit_id, status",
      )
      .eq("id", data.ticketId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!ticket || ticket.category !== "training_lesson_request")
      throw new Error("That lesson request isn't in your organization.");
    if (ticket.booked_visit_id) throw new Error("This request already has a lesson booked for it.");
    if (ticket.status === "resolved") throw new Error("This request was already answered.");
    if (!ticket.client_package_id || !ticket.property_id || !ticket.requested_on)
      throw new Error("This request no longer names a package and an address. Book it by hand.");
    const startTime = ticket.requested_time?.slice(0, 5) ?? null;
    const booked = await bookTrainingSessions(
      db,
      context.userId,
      {
        clientPackageId: ticket.client_package_id,
        propertyId: ticket.property_id,
        startOn: ticket.requested_on,
        weekday: new Date(`${ticket.requested_on}T00:00:00Z`).getUTCDay(),
        startTime,
      },
      true,
    );
    const { data: visit, error: visitError } = await db
      .from("visits")
      .select("id")
      .eq("subscription_id", booked.subscriptionId)
      .eq("organization_id", orgId)
      .limit(1)
      .maybeSingle();
    if (visitError) throw new Error(visitError.message);
    if (!visit) throw new Error("The lesson was not added to the schedule. Check the package.");
    const { formatDay } = await import("@/lib/format");
    const when = `${formatDay(ticket.requested_on)}${startTime ? ` at ${startTime}` : ""}`;
    const { data: linked, error: linkError } = await db
      .from("qc_tickets")
      .update({
        booked_visit_id: visit.id,
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: context.userId,
        resolution_note: `Booked for ${when}.`,
      })
      .eq("id", ticket.id)
      .eq("organization_id", orgId)
      .select("id");
    if (linkError) throw new Error(linkError.message);
    if (!linked || linked.length === 0)
      throw new Error("The lesson was booked, but it couldn't be linked to the request.");
    return { ok: true as const, visitId: visit.id as string, scheduledOn: ticket.requested_on };
  });

/** The office override on a missed or skipped package lesson. The database
 * refuses it from a trainer. */
export const setLessonSessionUse = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: id, usesSession: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const db = context.supabase as TrainingDb;
    const orgId = await requireTrainingOffice(db, context.userId);
    const result = await db
      .from("visits")
      .update({ skip_billable: data.usesSession })
      .eq("id", data.visitId)
      .eq("organization_id", orgId)
      .not("client_package_id", "is", null)
      .in("status", ["skipped", "missed"])
      .select("id")
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) throw new Error("Only a missed or skipped package lesson can change this.");
    const { afterLessonSessionChange } = await import("@/lib/training-portal.server");
    await afterLessonSessionChange(data.visitId);
    return { ok: true as const };
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
    const [properties, dogs, staff, packages, services] = await Promise.all([
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
        .select("*, services!service_packages_service_id_fkey(name)")
        .eq("organization_id", orgId)
        .eq("active", true)
        .order("name"),
      db
        .from("services")
        .select("id, default_duration_min")
        .eq("organization_id", orgId)
        .eq("service_line", "training"),
    ]);
    for (const result of [properties, dogs, staff, packages, services])
      if (result.error) throw new Error(result.error.message);
    return {
      properties: (properties.data ?? []) as { id: string; street: string }[],
      dogs: (dogs.data ?? []) as { id: string; name: string; property_id: string }[],
      staff: (staff.data ?? []) as { id: string; display_name: string }[],
      packages: (packages.data ?? []) as (ServicePackage & {
        services: { name: string };
      })[],
      /** Lesson length by training service, the default when booking. */
      lessonMinutes: Object.fromEntries(
        ((services.data ?? []) as { id: string; default_duration_min: number | null }[]).map(
          (s) => [s.id, s.default_duration_min ?? 60],
        ),
      ) as Record<string, number>,
    };
  });
