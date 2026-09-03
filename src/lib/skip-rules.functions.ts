import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

/** Every skip reason the SCHEDULE can carry, including the one only the portal
 *  writes. See TECH_SKIP_REASON_CODES for the subset a tech may choose. */
export const SKIP_REASON_CODES = [
  "customer_requested",
  "client_cancelled_late",
  "gate_locked",
  "dog_outside",
  "weather",
  "our_fault",
  "access_blocked",
  "unsafe_conditions",
  "other",
] as const;

export const SKIP_REASON_LABELS: Record<(typeof SKIP_REASON_CODES)[number], string> = {
  customer_requested: "Customer skipped via portal",
  client_cancelled_late: "Client cancelled late",
  gate_locked: "Gate locked / no access",
  dog_outside: "Dog was outside",
  weather: "Weather",
  our_fault: "Our fault",
  access_blocked: "Access blocked (car, construction, etc.)",
  unsafe_conditions: "Unsafe conditions",
  other: "Other",
};

/**
 * The same reasons, phrased for the person whose yard it is.
 *
 * SKIP_REASON_LABELS above is written for the office: "Our fault", "Client
 * cancelled late", "Access blocked (car, construction, etc.)". Those are
 * internal framings and two of them are about the customer rather than to
 * them. A customer opening the portal wants one thing from a skipped visit --
 * why did nobody come -- and they should get it in a sentence somebody would
 * actually say to them.
 *
 * Separate map rather than a rename, because the office list is used in
 * reporting and settings where the terse internal wording is right.
 */
export const CUSTOMER_SKIP_REASON_LABELS: Record<(typeof SKIP_REASON_CODES)[number], string> = {
  customer_requested: "You asked us to skip this one",
  client_cancelled_late: "Cancelled after our cut-off",
  gate_locked: "The gate was locked, so we could not get in",
  dog_outside: "Your dog was out in the yard",
  weather: "Called off for weather",
  our_fault: "Our mistake, so there is no charge",
  access_blocked: "We could not get to the yard",
  unsafe_conditions: "It was not safe to work",
  other: "Skipped",
};

/** The customer-facing sentence for a code, or a plain fallback for a code
 *  this build does not know — a value added to the enum in the database and
 *  not yet here must not render as a raw identifier on a customer's screen. */
export function customerSkipReason(code: string | null | undefined): string {
  if (!code) return "Skipped";
  return CUSTOMER_SKIP_REASON_LABELS[code as (typeof SKIP_REASON_CODES)[number]] ?? "Skipped";
}

const DEFAULT_PCT: Record<(typeof SKIP_REASON_CODES)[number], number> = {
  // 0 to MATCH the SQL, which is the whole point of adding this row rather than
  // picking a nicer number: `portal_skip_visit` ends with
  // `IF _pct IS NULL THEN _pct := 0`, so this has always been free. Making it
  // configurable must not also, silently, start charging people.
  customer_requested: 0,
  client_cancelled_late: 100,
  gate_locked: 100,
  dog_outside: 100,
  weather: 0,
  our_fault: 0,
  access_blocked: 100,
  unsafe_conditions: 50,
  other: 0,
};

/**
 * The reasons a TECH may pick in the field.
 *
 * `customer_requested` is written only by `portal_skip_visit` when a client
 * skips their own visit. A tech choosing it would be recording the customer's
 * decision as though the customer had made it, on the one code whose billing
 * the customer's own action drives — so the picker gets this list and the
 * settings screen gets the full one.
 */
export const TECH_SKIP_REASON_CODES = SKIP_REASON_CODES.filter(
  (c) => c !== "customer_requested",
) as ReadonlyArray<(typeof SKIP_REASON_CODES)[number]>;

async function getOrgId(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

export const listSkipRules = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await getOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("skip_billing_rules")
      .select("reason_code, billable_pct")
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    const overrides = new Map<string, number>();
    for (const r of data ?? []) overrides.set(r.reason_code, r.billable_pct);
    const rules = SKIP_REASON_CODES.map((code) => ({
      code,
      label: SKIP_REASON_LABELS[code],
      billable_pct: overrides.get(code) ?? DEFAULT_PCT[code],
      is_override: overrides.has(code),
    }));
    return { rules };
  });

export const upsertSkipRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        code: z.enum(SKIP_REASON_CODES),
        billablePct: z.number().int().min(0).max(100),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Skip-billing rules set how much a skipped visit still bills — a billing
    // settings action (owner/office_manager), not dispatcher-reachable (I7).
    const orgId = (await requirePermission(supabase, userId, "manage_settings")).orgId;
    const { error } = await supabase
      .from("skip_billing_rules")
      .upsert(
        {
          organization_id: orgId,
          reason_code: data.code,
          billable_pct: data.billablePct,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "organization_id,reason_code" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
