// The service catalog's server functions: Settings → Services reads and
// writes through these. The rules are in services.ts; the table, its RLS and
// its seed in migration 20261009200000_a-walk-is-not-a-cleanup.
//
// Gates, the same split as zones:
//   * listServices: any member of the business (RLS "Members read services").
//   * createService / updateService / setServiceActive: manage_pricing, which
//     owner and office manager hold. RLS asks the same question, so a client
//     that skipped these functions would be refused by the database too.
//
// There is no delete. Phase 2 points plans and visits at these rows, and a
// service that has been sold is deactivated, which is also what the API's
// grants allow (no DELETE for authenticated).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { SERVICE_LINES } from "@/lib/service-lines";
import {
  PRICE_UNITS,
  SERVICE_DURATION_MAX,
  SERVICE_DURATION_MIN,
  SERVICE_MAX_CENTS,
  SERVICE_NAME_MAX,
  serviceProblem,
  sortServices,
  type Service,
  type ServiceDraft,
} from "@/lib/services";

const SERVICE_COLUMNS =
  "id, organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active, created_at, updated_at";

const cents = z.number().int().min(0).max(SERVICE_MAX_CENTS);

export const serviceDraftSchema = z.object({
  name: z.string().trim().min(1).max(SERVICE_NAME_MAX),
  service_line: z.enum(SERVICE_LINES),
  price_unit: z.enum(PRICE_UNITS),
  base_price_cents: cents.nullable(),
  extra_pet_cents: cents.default(0),
  default_duration_min: z
    .number()
    .int()
    .min(SERVICE_DURATION_MIN)
    .max(SERVICE_DURATION_MAX)
    .nullable(),
});

/** Schema first (shape), then the sentence-level rules (night is for
 *  sitting, a walk needs a duration). Exported for the tests. */
export function parseServiceDraft(d: unknown): ServiceDraft {
  const draft = serviceDraftSchema.parse(d) as ServiceDraft;
  const problem = serviceProblem(draft);
  if (problem) throw new Error(problem);
  return draft;
}

/** A database error, as something an owner can act on. */
export function serviceWriteError(error: { code?: string; message: string }): Error {
  if (error.code === "23505") return new Error("You already have a service with that name.");
  if (error.code === "42501") return new Error("Not authorized");
  return new Error(error.message);
}

export const listServices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ includeInactive: z.boolean().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    let q = context.supabase
      .from("services")
      .select(SERVICE_COLUMNS)
      .eq("organization_id", orgId)
      .order("name");
    if (!data.includeInactive) q = q.eq("active", true);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { services: sortServices((rows ?? []) as Service[]) };
  });

export const createService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => parseServiceDraft(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { data: row, error } = await context.supabase
      .from("services")
      .insert({ ...data, name: data.name.trim(), organization_id: orgId, active: true })
      .select("id")
      .single();
    if (error) throw serviceWriteError(error);
    return { id: row!.id as string };
  });

export const updateService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => {
    const { id, ...rest } = z.object({ id: z.string().uuid() }).passthrough().parse(d) as {
      id: string;
    } & Record<string, unknown>;
    return { id, ...parseServiceDraft(rest) };
  })
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { id, ...draft } = data;
    const { data: rows, error } = await context.supabase
      .from("services")
      .update({ ...draft, name: draft.name.trim() })
      .eq("id", id)
      .eq("organization_id", orgId)
      .select("id");
    if (error) throw serviceWriteError(error);
    if (!rows || rows.length === 0) throw new Error("That service was not found.");
    return { id };
  });

/** Deactivate (or bring back) a service. Deactivating hides it from anything
 *  that books a new one; nothing that already points at it changes. */
export const setServiceActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { data: rows, error } = await context.supabase
      .from("services")
      .update({ active: data.active })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .select("id");
    if (error) throw serviceWriteError(error);
    if (!rows || rows.length === 0) throw new Error("That service was not found.");
    return { id: data.id, active: data.active };
  });
