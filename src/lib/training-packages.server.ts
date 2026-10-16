import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { insertManualInvoice } from "@/lib/manual-invoice.server";
import {
  canBook,
  holdsSession,
  packageState,
  sessionsLeft,
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

export async function holdingCount(db: TrainingDb, packageId: string) {
  const { data, error } = await db
    .from("visits")
    .select("status, skip_billable")
    .eq("client_package_id", packageId);
  if (error) throw new Error(error.message);
  return (data ?? []).filter(holdsSession).length;
}

export async function sellTrainingPackage(
  db: TrainingDb,
  userId: string,
  input: {
    clientId: string;
    servicePackageId: string;
    dogId?: string;
    requestId: string;
  },
) {
  const { orgId } = await requirePermission(db, userId, "manage_client_billing");
  const { data: client, error: clientError } = await db
    .from("clients")
    .select("id")
    .eq("id", input.clientId)
    .eq("organization_id", orgId)
    .single();
  if (clientError || !client) throw new Error(clientError?.message ?? "That client was not found.");
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
    .insert({
      organization_id: orgId,
      client_id: input.clientId,
      service_package_id: input.servicePackageId,
      dog_id: input.dogId ?? null,
      invoice_id: invoice.invoiceId,
      request_id: input.requestId,
      created_by: userId,
    })
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
  earliestTime?: string | null;
  latestTime?: string | null;
  staffId?: string;
  count?: number;
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
  const account = (
    Array.isArray(property.clients) ? property.clients[0] : property.clients
  ) as { account_type: "residential" | "commercial" };
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
      earliest_time: input.earliestTime ?? null,
      latest_time: input.latestTime ?? null,
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
  const { recomputePropertyEstimate } = await import("@/lib/estimate.server");
  await recomputePropertyEstimate(db, input.propertyId);
  return { subscriptionId: plan.id as string, visitCount: (generated.data as number) ?? 0 };
}
