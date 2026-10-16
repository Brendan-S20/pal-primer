import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

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
  "key_failed",
  "no_one_home",
  "dog_unwell",
] as const;

export type SkipReasonCode = (typeof SKIP_REASON_CODES)[number];

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
  key_failed: "Key or door code did not work",
  no_one_home: "No one home",
  dog_unwell: "Dog unwell",
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
  key_failed: "The key or door code did not work, so we could not get in",
  no_one_home: "Nobody was home when we arrived",
  dog_unwell: "Your dog seemed unwell, so we did not walk them",
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
  // The walker's three, matching default_skip_billable_pct
  // (20261015220000): a key that does not work and nobody home to hand the
  // dog over are lockouts, charged like a locked gate; a sick dog is nobody's
  // fault, free like weather.
  key_failed: 100,
  no_one_home: 100,
  dog_unwell: 0,
};

/** Codes only a dog walk offers. A pet-waste stop never shows them, and a
 *  business that does not walk dogs does not see them in Settings. */
export const WALK_ONLY_SKIP_REASON_CODES: ReadonlyArray<SkipReasonCode> = [
  "key_failed",
  "no_one_home",
  "dog_unwell",
];

/**
 * The reasons a TECH may pick in the field at a pet-waste stop (or any stop
 * that is not a dog walk).
 *
 * `customer_requested` is written only by `portal_skip_visit` when a client
 * skips their own visit. A tech choosing it would be recording the customer's
 * decision as though the customer had made it, on the one code whose billing
 * the customer's own action drives — so the picker gets this list and the
 * settings screen gets the full one.
 */
export const TECH_SKIP_REASON_CODES = SKIP_REASON_CODES.filter(
  (c) => c !== "customer_requested" && !WALK_ONLY_SKIP_REASON_CODES.includes(c),
) as ReadonlyArray<(typeof SKIP_REASON_CODES)[number]>;

/**
 * The reasons a walker may pick on a dog walk (#410). A walker always goes
 * in, so the yard reasons (the dog was out, the gate was locked, a car in the
 * way) do not apply. access_blocked is "Could not get in" on a walk
 * (walkSkipReason.access_blocked in lib/i18n).
 */
export const WALK_SKIP_REASON_CODES: ReadonlyArray<SkipReasonCode> = [
  "access_blocked",
  "key_failed",
  "no_one_home",
  "dog_unwell",
  "weather",
  "other",
];

/** The picker's list for a stop: the walker's on a dog walk, otherwise the
 *  list every stop has always had. */
export function techSkipReasonCodes(walk: boolean): ReadonlyArray<SkipReasonCode> {
  return walk ? WALK_SKIP_REASON_CODES : TECH_SKIP_REASON_CODES;
}

async function getOrgId(supabase: any, userId: string): Promise<string> {
  // Through the shared gate, so a person whose access is turned off is
  // refused here as everywhere else (20261009180000).
  return (await resolveCaller(supabase, userId)).orgId;
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
