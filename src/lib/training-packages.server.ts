import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { newClientPackage } from "@/lib/db-insert";
import { insertManualInvoice } from "@/lib/manual-invoice.server";
import {
  CHOOSE_DOG,
  TRAINER_BUSY,
  canBook,
  holdsSession,
  lessonEnd,
  packageState,
  sessionsLeft,
  timesOverlap,
  weeklySessionDates,
  type TrainingPackage,
} from "@/lib/training-packages";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";

export type TrainingDb = SupabaseClient<Database>;
export type ServicePackage = {
  id: string;
  organization_id: string;
  service_id: string;
  name: string;
  sessions_count: number;
  price_cents: number;
  expires_after_days: number | null;
  active: boolean;
};
export type ClientPackage = TrainingPackage & {
  id: string;
  organization_id: string;
  client_id: string;
  dog_id: string | null;
  service_id: string;
  name: string;
  price_cents: number;
  purchased_on: string;
  invoice_id: string | null;
};
export type ListedClientPackage = ClientPackage & {
  held: number;
  bookedAfterToday: number;
  left: number;
  free: number;
  state: ReturnType<typeof packageState>;
  invoice: { id: string; number: number | null; status: string } | null;
};

export async function requireTrainingOffice(db: TrainingDb, userId: string) {
  const { orgId } = await resolveCaller(db, userId);
  const result = await db.rpc("can_write_org", { _user_id: userId, _org_id: orgId });
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Not authorized");
  return orgId;
}

export async function trainingPackage(
  db: TrainingDb,
  id: string,
  orgId: string,
): Promise<ClientPackage> {
  const { data, error } = await db
    .from("client_packages")
    .select("*")
    .eq("id", id)
    .eq("organization_id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return data as ClientPackage;
}

async function packageLessons(db: TrainingDb, packageId: string) {
  const { data, error } = await db
    .from("visits")
    .select("status, skip_billable, scheduled_on")
    .eq("client_package_id", packageId);
  if (error) throw new Error(error.message);
  return (data ?? []) as { status: string; skip_billable: boolean; scheduled_on?: string }[];
}

export async function holdingCount(db: TrainingDb, packageId: string) {
  return (await packageLessons(db, packageId)).filter(holdsSession).length;
}

/** Held sessions, and the scheduled lessons after today that canceling the
 * package could cancel with it. */
export async function lessonCounts(db: TrainingDb, packageId: string, today: string) {
  const lessons = await packageLessons(db, packageId);
  return {
    held: lessons.filter(holdsSession).length,
    bookedAfterToday: lessons.filter(
      (v) => v.status === "scheduled" && !!v.scheduled_on && v.scheduled_on > today,
    ).length,
  };
}

type Busy = { date: string; start: string; end: string };

/** Lessons and stops the trainer already has that overlap the new lesson on
 * any of the given days. A stop with no start time cannot clash. */
export async function trainerConflicts(
  db: TrainingDb,
  orgId: string,
  staffId: string,
  dates: string[],
  slot: { start: string; end: string },
): Promise<Busy[]> {
  const { data, error } = await db
    .from("visits")
    .select(
      "scheduled_on, subscriptions(earliest_time, latest_time), services(default_duration_min)",
    )
    .eq("organization_id", orgId)
    .eq("assigned_staff_id", staffId)
    .in("scheduled_on", dates)
    .in("status", ["scheduled", "in_progress"]);
  if (error) throw new Error(error.message);
  const out: Busy[] = [];
  for (const row of (data ?? []) as {
    scheduled_on: string;
    subscriptions: { earliest_time: string | null; latest_time: string | null } | null;
    services: { default_duration_min: number | null } | null;
  }[]) {
    const start = row.subscriptions?.earliest_time?.slice(0, 5);
    if (!start) continue;
    const end =
      row.subscriptions?.latest_time?.slice(0, 5) ??
      lessonEnd(start, row.services?.default_duration_min ?? 60) ??
      "23:59";
    if (timesOverlap(slot, { start, end })) out.push({ date: row.scheduled_on, start, end });
  }
  return out.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

export type PackageSale = {
  clientId: string;
  servicePackageId: string;
  dogId?: string;
  requestId: string;
};

export async function sellTrainingPackage(db: TrainingDb, userId: string, input: PackageSale) {
  const { orgId } = await requirePermission(db, userId, "manage_client_billing");
  return createPackageSale(db, { ...input, orgId, userId });
}

/** The sale itself: the package, its invoice, and the cleanup if the
 * package insert fails. The office calls it after the billing permission;
 * the portal calls it as the service role after the client's session check,
 * with no user. Both go through the same checks and the same invoice path. */
export async function createPackageSale(
  db: TrainingDb,
  input: PackageSale & { orgId: string; userId: string | null },
) {
  const { orgId, userId } = input;
  const { data: client, error: clientError } = await db
    .from("clients")
    .select("id")
    .eq("id", input.clientId)
    .eq("organization_id", orgId)
    .single();
  if (clientError || !client) throw new Error(clientError?.message ?? "That client was not found.");
  if (!input.dogId) {
    // Progress and homework are kept per dog, so a household with two dogs
    // has to say which one the package is for.
    const { count, error: dogsError } = await db
      .from("dogs")
      .select("id, properties!inner(client_id)", { count: "exact", head: true })
      .eq("properties.client_id", input.clientId)
      .eq("organization_id", orgId)
      .eq("active", true);
    if (dogsError) throw new Error(dogsError.message);
    if ((count ?? 0) > 1) throw new Error(CHOOSE_DOG);
  }
  const { data: previous, error: requestError } = await db
    .from("client_packages")
    .select("id")
    .eq("client_id", input.clientId)
    .eq("request_id", input.requestId)
    .maybeSingle();
  if (requestError) throw new Error(requestError.message);
  if (previous) throw new Error("This package sale was already submitted. Refresh the packages.");
  const { data: pack, error: packError } = await db
    .from("service_packages")
    .select("*, services(name)")
    .eq("id", input.servicePackageId)
    .eq("organization_id", orgId)
    .single();
  if (packError) throw new Error(packError.message);
  if (!pack.active) throw new Error("This package is not available for sale.");
  if (pack.price_cents <= 0) throw new Error("Set a price on this package before selling it.");
  const service = Array.isArray(pack.services) ? pack.services[0] : pack.services;
  const invoice = await insertManualInvoice(db, {
    orgId,
    userId,
    clientId: input.clientId,
    items: [{ description: `${pack.name}: ${service.name}`, amountCents: pack.price_cents }],
    activityLabel: "training package invoice",
  });
  const { data: row, error } = await db
    .from("client_packages")
    .insert(
      newClientPackage({
        organization_id: orgId,
        client_id: input.clientId,
        service_package_id: input.servicePackageId,
        dog_id: input.dogId ?? null,
        invoice_id: invoice.invoiceId,
        request_id: input.requestId,
        created_by: userId,
      }),
    )
    .select("*")
    .single();
  if (error) {
    const cleanup = await db
      .from("invoices")
      .delete()
      .eq("id", invoice.invoiceId)
      .eq("organization_id", orgId);
    if (cleanup.error)
      throw new Error(`${error.message} Invoice cleanup failed: ${cleanup.error.message}`);
    if (error.code === "23505")
      throw new Error("This package sale was already submitted. Refresh the packages.");
    throw new Error(error.message);
  }
  const { data: invoiceRow, error: invoiceError } = await db
    .from("invoices")
    .select("number")
    .eq("id", invoice.invoiceId)
    .single();
  if (invoiceError) throw new Error(invoiceError.message);
  return {
    package: row as ClientPackage,
    invoiceId: invoice.invoiceId,
    invoiceNumber: invoiceRow.number as number,
  };
}

export type SessionBooking = {
  clientPackageId: string;
  propertyId: string;
  startOn: string;
  weekday: number;
  /** "HH:MM". A lesson with a start time occupies start to start + minutes. */
  startTime?: string | null;
  minutes?: number;
  staffId?: string;
  count?: number;
  /** The office saw the trainer's clash and booked anyway. */
  allowOverlap?: boolean;
};

/** Package plans use the existing subscription generator, limited to this plan. */
export async function bookTrainingSessions(
  db: TrainingDb,
  userId: string,
  input: SessionBooking,
  oneTime = false,
) {
  await requirePermission(db, userId, "manage_pricing");
  const orgId = await requireTrainingOffice(db, userId);
  const pack = await trainingPackage(db, input.clientPackageId, orgId);
  const held = await holdingCount(db, pack.id);
  const { data: org, error: orgError } = await db
    .from("organizations")
    .select("timezone")
    .eq("id", orgId)
    .single();
  if (orgError) throw new Error(orgError.message);
  const problem =
    canBook(pack, held, orgToday(org.timezone || DEFAULT_ORG_TIMEZONE)) ??
    canBook(pack, held, input.startOn);
  if (problem) throw new Error(problem);
  const free = pack.sessions_count - held;
  const dates = oneTime
    ? [input.startOn]
    : weeklySessionDates(
        input.startOn,
        input.weekday,
        Math.min(input.count ?? free, free),
        pack.expires_on,
      );
  if (!dates.length) throw new Error(`This package expired on ${pack.expires_on}.`);
  const { data: property, error: propertyError } = await db
    .from("properties")
    .select("id, zone_id, clients(account_type)")
    .eq("id", input.propertyId)
    .eq("client_id", pack.client_id)
    .eq("organization_id", orgId)
    .single();
  if (propertyError) throw new Error(propertyError.message);
  const { count: dogs, error: dogsError } = await db
    .from("dogs")
    .select("id", { count: "exact", head: true })
    .eq("property_id", input.propertyId)
    .eq("active", true);
  if (dogsError) throw new Error(dogsError.message);
  if (input.staffId) {
    const { data: staff, error } = await db
      .from("staff")
      .select("id")
      .eq("id", input.staffId)
      .eq("organization_id", orgId)
      .eq("active", true)
      .eq("is_field_tech", true)
      .single();
    if (error || !staff) throw new Error("Choose a trainer from this business.");
  }
  let slot: { start: string; end: string } | null = null;
  if (input.startTime) {
    let minutes = input.minutes;
    if (!minutes) {
      const { data: service, error: serviceError } = await db
        .from("services")
        .select("default_duration_min")
        .eq("id", pack.service_id)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (serviceError) throw new Error(serviceError.message);
      minutes = service?.default_duration_min ?? 60;
    }
    const end = lessonEnd(input.startTime, minutes);
    if (!end) throw new Error("This lesson would run past midnight. Choose an earlier start.");
    slot = { start: input.startTime, end };
    if (input.staffId && !input.allowOverlap) {
      const busy = await trainerConflicts(db, orgId, input.staffId, dates, slot);
      if (busy.length)
        throw new Error(
          `${TRAINER_BUSY}: ${busy
            .slice(0, 3)
            .map((b) => `${b.date}, ${b.start} to ${b.end}`)
            .join("; ")}${busy.length > 3 ? ` and ${busy.length - 3} more` : ""}.`,
        );
    }
  }
  const account = (Array.isArray(property.clients) ? property.clients[0] : property.clients) as {
    account_type: "residential" | "commercial";
  };
  const commercial = account.account_type === "commercial";
  const { data: plan, error } = await db
    .from("subscriptions")
    .insert({
      organization_id: orgId,
      client_id: pack.client_id,
      property_id: input.propertyId,
      service_id: pack.service_id,
      client_package_id: pack.id,
      account_type: account.account_type,
      preferred_time_of_day: "any",
      dog_count: commercial ? null : Math.max(1, dogs ?? 1),
      unit_count: commercial ? 1 : null,
      frequency: oneTime ? "one_time" : "weekly",
      weekdays: oneTime ? null : [input.weekday],
      price_cents: 0,
      billing_cadence: "postpaid",
      started_on: input.startOn,
      ends_on: dates[dates.length - 1],
      zone_id: property.zone_id,
      priced_from_zone_id: null,
      // The lesson's own time slot. The late-cancel rule reads its start.
      earliest_time: slot?.start ?? null,
      latest_time: slot?.end ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const generated = await db.rpc("generate_visits_for_subscription", {
    _org_id: orgId,
    _subscription_id: plan.id,
    _through: dates[dates.length - 1],
  });
  if (generated.error) throw new Error(generated.error.message);
  if (input.staffId) {
    const assigned = await db
      .from("visits")
      .update({ assigned_staff_id: input.staffId })
      .eq("subscription_id", plan.id)
      .eq("status", "scheduled");
    if (assigned.error) throw new Error(assigned.error.message);
  }
  // No yard estimate: a lesson's length is the slot booked above, and the
  // property's routine minutes come from its own service, not a package.
  return { subscriptionId: plan.id as string, visitCount: (generated.data as number) ?? 0 };
}
