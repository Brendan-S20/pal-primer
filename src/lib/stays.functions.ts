// A sitter's booking and the pets' care instructions, on the server (#411).
//
// A stay's visits come from sibling plans, one per drop-in window or one for
// the overnight arrival window. confirm_stay writes the plans through S1's
// generator and creates the invoice in one transaction. The
// database keeps the rest straight (migration 20261016120000): kind follows
// the service, a stay visit takes the stay's sitter, a sitter never has two
// overnights on one night, and canceling a stay cancels its future visits.
//
// Permissions are the existing ones (#460 redesigns roles): booking a stay
// writes plans, so it needs manage_pricing as every plan writer does;
// changing the sitter or canceling needs can_write_org, as walk groups do;
// reading needs the client directory, as the client's dogs do.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import {
  arrivalWindowProblem,
  firstTakenNight,
  overnightConflictSentence,
  stayDatesProblem,
  stayDays,
  stayKindFor,
  stayVisitCount,
  stayVisitPriceCents,
  stayWindowsProblem,
  DEFAULT_DEPOSIT_REFUND_DAYS,
  DEFAULT_OVERNIGHT_ARRIVAL,
  type StayKind,
} from "@/lib/stays";
import {
  cleanMeds,
  FEEDING_MAX,
  medsProblem,
  OTHER_CARE_MAX,
  readMeds,
  type PetCare,
} from "@/lib/pets";
import { normalizeClock } from "@/lib/walk-windows";

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const windowSchema = z.object({ earliestTime: clockSchema, latestTime: clockSchema });

/** The database's own predicate, as walk groups ask it. */
async function requireOffice(supabase: SupabaseClient<Database>, userId: string): Promise<string> {
  const { orgId } = await resolveCaller(supabase, userId);
  const { data, error } = await supabase.rpc("can_write_org", { _user_id: userId, _org_id: orgId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Not authorized");
  return orgId;
}

/** Nights the sitter already spends at another overnight stay, among these. */
async function takenNights(
  supabase: SupabaseClient<Database>,
  orgId: string,
  staffId: string,
  nights: readonly string[],
  exceptStayId: string | null,
): Promise<string[]> {
  if (nights.length === 0) return [];
  const { data, error } = await (supabase as any)
    .from("visits")
    .select("scheduled_on, subscriptions!inner(stay_id, stays!inner(kind))")
    .eq("organization_id", orgId)
    .eq("assigned_staff_id", staffId)
    .gte("scheduled_on", nights[0])
    .lte("scheduled_on", nights[nights.length - 1])
    .not("status", "in", "(canceled,skipped,missed)")
    .eq("subscriptions.stays.kind", "overnight");
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as Array<{ scheduled_on: string; subscriptions: { stay_id: string } | null }>
  )
    .filter((v) => v.subscriptions?.stay_id !== exceptStayId)
    .map((v) => v.scheduled_on);
}

async function refuseOvernightConflict(
  supabase: SupabaseClient<Database>,
  orgId: string,
  staffId: string,
  nights: readonly string[],
  exceptStayId: string | null,
) {
  const night = firstTakenNight(
    nights,
    await takenNights(supabase, orgId, staffId, nights, exceptStayId),
  );
  if (!night) return;
  const { data: staff } = await supabase
    .from("staff")
    .select("display_name")
    .eq("id", staffId)
    .maybeSingle();
  throw new Error(overnightConflictSentence(staff?.display_name, night));
}

/** The pets' care as it is now, for the stay's snapshot. */
async function careSnapshot(
  supabase: SupabaseClient<Database>,
  petIds: readonly string[],
): Promise<Json> {
  if (petIds.length === 0) return [];
  const [pets, care] = await Promise.all([
    supabase
      .from("dogs")
      .select("id, name, species, species_note")
      .in("id", [...petIds]),
    (supabase as any)
      .from("pet_care_instructions")
      .select("pet_id, feeding, meds, other_care")
      .in("pet_id", [...petIds]),
  ]);
  if (pets.error) throw new Error(pets.error.message);
  if (care.error) throw new Error(care.error.message);
  const byPet = new Map(
    (
      (care.data ?? []) as Array<{
        pet_id: string;
        feeding: string | null;
        meds: unknown;
        other_care: string | null;
      }>
    ).map((c) => [c.pet_id, c]),
  );
  return (pets.data ?? []).map((p: any) => {
    const c = byPet.get(p.id);
    return {
      pet_id: p.id,
      name: p.name,
      species: p.species ?? "dog",
      species_note: p.species_note ?? null,
      feeding: c?.feeding ?? null,
      meds: readMeds(c?.meds),
      other_care: c?.other_care ?? null,
    };
  }) as Json;
}

// ── Booking ──────────────────────────────────────────────────────────────

export const createStaySchema = z.object({
  clientId: z.string().uuid(),
  propertyId: z.string().uuid(),
  serviceId: z.string().uuid(),
  startsOn: daySchema,
  endsOn: daySchema,
  /** Drop-ins: one to four windows. Ignored for an overnight. */
  windows: z.array(windowSchema).max(4).default([]),
  /** Overnight: when the sitter arrives. Defaults to 7 PM to 9 PM. */
  arrival: windowSchema.nullable().optional(),
  petIds: z.array(z.string().uuid()).min(1, "Choose at least one pet.").max(30),
  sitterId: z.string().uuid().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  depositCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  /** One visit's price, when the office types one; else the service's. */
  priceCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
});

export type CreateStayInput = z.infer<typeof createStaySchema>;

export const createStay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createStaySchema.parse(d))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as SupabaseClient<Database>;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_pricing");

    const { data: service, error: sErr } = await supabase
      .from("services")
      .select(
        "id, organization_id, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active",
      )
      .eq("id", data.serviceId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!service || service.organization_id !== orgId || service.service_line !== "pet_sitting")
      throw new Error("Choose a pet sitting service.");
    if (!service.active) throw new Error("That service is no longer offered. Choose another.");
    const kind: StayKind = stayKindFor(service.price_unit);

    const dates = stayDatesProblem(kind, data.startsOn, data.endsOn);
    if (dates) throw new Error(dates);
    const arrival = data.arrival ?? DEFAULT_OVERNIGHT_ARRIVAL;
    const windowProblem =
      kind === "overnight" ? arrivalWindowProblem(arrival) : stayWindowsProblem(data.windows);
    if (windowProblem) throw new Error(windowProblem);

    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("organization_id, account_type")
      .eq("id", data.clientId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!client || client.organization_id !== orgId) throw new Error("That client was not found.");
    if (client.account_type === "commercial")
      throw new Error("Stays are booked for residential clients.");

    const petIds = [...new Set(data.petIds)];
    const { data: pets, error: pErr } = await supabase
      .from("dogs")
      .select("id")
      .eq("property_id", data.propertyId)
      .in("id", petIds);
    if (pErr) throw new Error(pErr.message);
    if ((pets ?? []).length !== petIds.length)
      throw new Error("Every pet on a stay has to live at its property.");

    const priceCents = data.priceCents ?? stayVisitPriceCents(service as any, petIds.length);
    if (priceCents == null)
      throw new Error(
        "This service has no price yet. Type a price, or set one in Settings > Services.",
      );

    const days = stayDays(kind, data.startsOn, data.endsOn);
    if (data.sitterId && kind === "overnight")
      await refuseOvernightConflict(supabase, orgId, data.sitterId, days, null);

    const { data: stay, error: stErr } = await (supabase as any)
      .from("stays")
      .insert({
        organization_id: orgId,
        client_id: data.clientId,
        property_id: data.propertyId,
        service_id: data.serviceId,
        starts_on: data.startsOn,
        ends_on: data.endsOn,
        drop_in_windows:
          kind === "drop_in"
            ? data.windows.map((w) => ({ earliest: w.earliestTime, latest: w.latestTime }))
            : null,
        overnight_arrival_earliest: kind === "overnight" ? arrival.earliestTime : null,
        overnight_arrival_latest: kind === "overnight" ? arrival.latestTime : null,
        pet_ids: petIds,
        assigned_staff_id: data.sitterId ?? null,
        status: "requested",
        deposit_cents: data.depositCents ?? null,
        care_snapshot: await careSnapshot(supabase, petIds),
        notes: data.notes?.trim() || null,
      })
      .select("id")
      .single();
    if (stErr) throw new Error(stErr.message);
    const stayId = stay.id as string;

    const { data: invoiceId, error: confirmError } = await supabase.rpc("confirm_stay", {
      _stay_id: stayId,
      _price_cents: priceCents,
    });
    if (confirmError) {
      await (supabase as any).from("stays").delete().eq("id", stayId).eq("status", "requested");
      throw new Error(confirmError.message);
    }
    const { notifyStayConfirmed } = await import("@/lib/stay-notify.server");
    await notifyStayConfirmed(stayId);
    const expected = stayVisitCount(kind, data.startsOn, data.endsOn, data.windows.length);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: data.clientId,
      propertyId: data.propertyId,
      actorUserId: context.userId,
      kind: "stay.booked",
      summary: `Booked a stay, ${data.startsOn} to ${data.endsOn}`,
      meta: { stay_id: stayId, kind, invoice_id: invoiceId },
    });

    // Warns, never refuses: the stay is booked either way.
    const { data: gaps, error: gapsError } = await supabase.rpc("stay_contact_gaps", {
      _stay_id: stayId,
    });
    if (gapsError) console.warn("stay contact check failed");
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");

    return {
      id: stayId,
      kind,
      visits: expected,
      expected,
      gaps: (gaps as string[] | null) ?? [],
      clash: await overnightClashWarning(supabase, { stayId }),
    };
  });

// ── Reading ──────────────────────────────────────────────────────────────

export type StayRow = {
  id: string;
  property_id: string;
  service_id: string;
  starts_on: string;
  ends_on: string;
  kind: StayKind;
  status: "requested" | "confirmed" | "canceled" | "completed";
  drop_in_windows: Array<{ earliest: string; latest: string }> | null;
  overnight_arrival_earliest: string | null;
  overnight_arrival_latest: string | null;
  pet_ids: string[];
  assigned_staff_id: string | null;
  deposit_cents: number | null;
  invoice_id: string | null;
  deposit_invoice_id: string | null;
  notes: string | null;
  service_name: string | null;
  sitter_name: string | null;
  visit_count: number;
  /** One visit's price on the stay's plans, for the change form. */
  visit_price_cents: number | null;
  /** The stay's visits, for the change form's worked and future split. */
  visits: Array<{ scheduled_on: string; status: string }>;
};

export const listStaysForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<{ stays: StayRow[]; depositRefundDays: number }> => {
    const supabase = context.supabase as SupabaseClient<Database>;
    const { orgId } = await requirePermission(supabase, context.userId, "view_client_directory");
    const { data: org } = await supabase
      .from("organizations")
      .select("stay_deposit_refund_days")
      .eq("id", orgId)
      .maybeSingle();
    const { data: rows, error } = await (supabase as any)
      .from("stays")
      .select(
        "id, property_id, service_id, starts_on, ends_on, kind, status, drop_in_windows, overnight_arrival_earliest, overnight_arrival_latest, pet_ids, assigned_staff_id, deposit_cents, invoice_id, deposit_invoice_id, notes, services(name), staff(display_name), subscriptions(id, price_cents, visits(scheduled_on, status))",
      )
      .eq("client_id", data.clientId)
      .order("starts_on", { ascending: false });
    if (error) throw new Error(error.message);
    return {
      depositRefundDays: org?.stay_deposit_refund_days ?? DEFAULT_DEPOSIT_REFUND_DAYS,
      stays: ((rows ?? []) as any[]).map((r) => ({
        id: r.id,
        property_id: r.property_id,
        service_id: r.service_id,
        starts_on: r.starts_on,
        ends_on: r.ends_on,
        kind: r.kind,
        status: r.status,
        drop_in_windows: r.drop_in_windows ?? null,
        overnight_arrival_earliest: normalizeClock(r.overnight_arrival_earliest),
        overnight_arrival_latest: normalizeClock(r.overnight_arrival_latest),
        pet_ids: r.pet_ids ?? [],
        assigned_staff_id: r.assigned_staff_id,
        deposit_cents: r.deposit_cents,
        invoice_id: r.invoice_id,
        deposit_invoice_id: r.deposit_invoice_id,
        notes: r.notes,
        service_name: r.services?.name ?? null,
        sitter_name: r.staff?.display_name ?? null,
        visit_count: ((r.subscriptions ?? []) as any[]).reduce(
          (n, s) => n + (s.visits?.length ?? 0),
          0,
        ),
        visit_price_cents: (r.subscriptions ?? [])[0]?.price_cents ?? null,
        visits: ((r.subscriptions ?? []) as any[]).flatMap((s) =>
          ((s.visits ?? []) as any[]).map((v) => ({
            scheduled_on: v.scheduled_on as string,
            status: v.status as string,
          })),
        ),
      })),
    };
  });

// ── Changing a stay ──────────────────────────────────────────────────────

export const cancelStay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ stayId: z.string().uuid(), refundDeposit: z.boolean().default(false) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as SupabaseClient<Database>;
    const orgId = await requireOffice(supabase, context.userId);
    const { data: row, error: sErr } = await (supabase as any)
      .from("stays")
      .select("id, client_id, property_id, starts_on, ends_on, invoice_id, deposit_invoice_id, status")
      .eq("id", data.stayId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!row || row.status === "canceled")
      throw new Error("That stay was not found, or is already canceled.");
    // cancel_stay cancels the future scheduled visits, ends the plans and
    // applies the deposit rule (tg_stays_follow).
    const { data: result, error } = await supabase.rpc("cancel_stay", {
      _stay_id: data.stayId,
      _refund_deposit: data.refundDeposit,
    });
    if (error) throw new Error(error.message);
    const r = (result ?? {}) as { deposit?: string; fee_invoice_id?: string | null };
    const { syncInvoicePaymentIntentAmount } = await import("@/lib/invoice-reconcile.server");
    for (const id of [row.invoice_id, row.deposit_invoice_id]) {
      if (id) await syncInvoicePaymentIntentAmount(id);
    }
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: row.client_id,
      propertyId: row.property_id,
      actorUserId: context.userId,
      kind: "stay.canceled",
      summary:
        r.deposit === "kept"
          ? `Canceled the stay, ${row.starts_on} to ${row.ends_on}. Kept the deposit as a cancellation fee.`
          : `Canceled the stay, ${row.starts_on} to ${row.ends_on}`,
      meta: {
        stay_id: row.id,
        deposit: r.deposit ?? null,
        refund_override: data.refundDeposit,
        fee_invoice_id: r.fee_invoice_id ?? null,
      },
    });
    return { ok: true, deposit: r.deposit ?? "none", feeInvoiceId: r.fee_invoice_id ?? null };
  });

/** Moves a confirmed stay's dates or changes its pets. change_stay does the
 *  work in one transaction: visits canceled or added, completed visits left
 *  alone, the stay invoice restated or, once paid, a new invoice for added
 *  nights and account credit for removed ones. */
export const changeStay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        stayId: z.string().uuid(),
        startsOn: daySchema,
        endsOn: daySchema,
        petIds: z.array(z.string().uuid()).min(1, "Choose at least one pet.").max(30),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as SupabaseClient<Database>;
    const orgId = await requireOffice(supabase, context.userId);
    const { data: stay, error: sErr } = await (supabase as any)
      .from("stays")
      .select("id, client_id, property_id, starts_on, ends_on, pet_ids, invoice_id")
      .eq("id", data.stayId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!stay) throw new Error("That stay was not found.");
    const { data: result, error } = await supabase.rpc("change_stay", {
      _stay_id: data.stayId,
      _ends_on: data.endsOn,
      _starts_on: data.startsOn,
      _pet_ids: [...new Set(data.petIds)],
    });
    if (error) throw new Error(error.message);
    const r = (result ?? {}) as {
      visits_added?: number;
      visits_canceled?: number;
      invoice_id?: string | null;
    };
    const { syncInvoicePaymentIntentAmount } = await import("@/lib/invoice-reconcile.server");
    for (const id of [stay.invoice_id, r.invoice_id]) {
      if (id) await syncInvoicePaymentIntentAmount(id);
    }
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: stay.client_id,
      propertyId: stay.property_id,
      actorUserId: context.userId,
      kind: "stay.changed",
      summary: `Changed the stay to ${data.startsOn} to ${data.endsOn}`,
      meta: {
        stay_id: stay.id,
        from: { starts_on: stay.starts_on, ends_on: stay.ends_on, pet_ids: stay.pet_ids },
        to: { starts_on: data.startsOn, ends_on: data.endsOn, pet_ids: data.petIds },
        invoice_id: r.invoice_id ?? null,
      },
    });
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    return {
      added: r.visits_added ?? 0,
      canceled: r.visits_canceled ?? 0,
      invoiceId: r.invoice_id ?? null,
      clash: await overnightClashWarning(supabase, { stayId: stay.id }),
    };
  });

export const setStaySitter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ stayId: z.string().uuid(), sitterId: z.string().uuid().nullable() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as SupabaseClient<Database>;
    const orgId = await requireOffice(supabase, context.userId);
    const { data: stay, error: sErr } = await (supabase as any)
      .from("stays")
      .select("id, kind, status, starts_on, ends_on, client_id, property_id")
      .eq("id", data.stayId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!stay) throw new Error("That stay was not found.");
    if (stay.status === "canceled") throw new Error("That stay is canceled.");
    if (data.sitterId && stay.kind === "overnight")
      await refuseOvernightConflict(
        supabase,
        orgId,
        data.sitterId,
        stayDays(stay.kind, stay.starts_on, stay.ends_on),
        stay.id,
      );
    // tg_stays_follow moves the future scheduled visits; the database refuses
    // a second overnight on one night even if this check raced another.
    const { error } = await (supabase as any)
      .from("stays")
      .update({ assigned_staff_id: data.sitterId })
      .eq("id", data.stayId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: stay.client_id,
      propertyId: stay.property_id,
      actorUserId: context.userId,
      kind: "stay.sitter_changed",
      summary: data.sitterId ? "Changed the stay's sitter" : "Took the sitter off the stay",
      meta: { stay_id: stay.id, sitter_id: data.sitterId },
    });
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    return { ok: true, clash: await overnightClashWarning(supabase, { stayId: stay.id }) };
  });

// ── Care instructions ────────────────────────────────────────────────────

export const getPetCare = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ petIds: z.array(z.string().uuid()).max(100) }).parse(d))
  .handler(async ({ data, context }): Promise<{ care: Record<string, PetCare> }> => {
    if (data.petIds.length === 0) return { care: {} };
    const supabase = context.supabase as SupabaseClient<Database>;
    await resolveCaller(supabase, context.userId);
    // RLS decides who may read (pet_care_instructions: a member who may see
    // the pet's property).
    const { data: rows, error } = await (supabase as any)
      .from("pet_care_instructions")
      .select("pet_id, feeding, meds, other_care")
      .in("pet_id", data.petIds);
    if (error) throw new Error(error.message);
    const care: Record<string, PetCare> = {};
    for (const r of (rows ?? []) as any[])
      care[r.pet_id] = { feeding: r.feeding, meds: readMeds(r.meds), other_care: r.other_care };
    return { care };
  });

const medSchema = z.object({
  name: z.string().max(80),
  dose: z.string().max(80).nullable(),
  times: z.array(z.string()).max(6),
  notes: z.string().max(200).nullable(),
});

export const setPetCare = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        petId: z.string().uuid(),
        feeding: z.string().max(FEEDING_MAX).nullable(),
        meds: z.array(medSchema).max(20),
        otherCare: z.string().max(OTHER_CARE_MAX).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as SupabaseClient<Database>;
    const orgId = await requireOffice(supabase, context.userId);
    const meds = cleanMeds(data.meds);
    const problem = medsProblem(meds);
    if (problem) throw new Error(problem);
    const { data: pet, error: pErr } = await supabase
      .from("dogs")
      .select("id, organization_id")
      .eq("id", data.petId)
      .maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!pet || pet.organization_id !== orgId) throw new Error("That pet was not found.");
    const { error } = await (supabase as any).from("pet_care_instructions").upsert(
      {
        pet_id: data.petId,
        organization_id: orgId,
        feeding: data.feeding?.trim() || null,
        meds,
        other_care: data.otherCare?.trim() || null,
      },
      { onConflict: "pet_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
