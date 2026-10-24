import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import i18n from "@/lib/i18n";
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
  "pet_hiding",
  "client_home",
] as const;

export const SKIP_REASON_LABELS: Record<(typeof SKIP_REASON_CODES)[number], string> = {
  customer_requested: "Customer skipped via portal",
  client_cancelled_late: "Client canceled late",
  gate_locked: "Gate locked / no access",
  dog_outside: "Dog was outside",
  weather: "Weather",
  our_fault: "Our fault",
  access_blocked: "Access blocked (car, construction, etc.)",
  unsafe_conditions: "Unsafe conditions",
  other: "Other",
  key_failed: "Key or code did not work",
  no_one_home: "No one home",
  dog_unwell: "Dog unwell",
  pet_hiding: "Pet hiding",
  client_home: "Client home",
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
  client_cancelled_late: "Canceled after our cut-off",
  gate_locked: "The gate was locked, so we could not get in",
  dog_outside: "Your dog was out in the yard",
  weather: "Called off for weather",
  our_fault: "Our mistake, so there is no charge",
  access_blocked: "We could not get to the yard",
  unsafe_conditions: "It was not safe to work",
  other: "Skipped",
  key_failed: "The key or the code did not work",
  no_one_home: "No one was home",
  dog_unwell: "The dog was not well enough to walk",
  pet_hiding: "Your pet was hiding",
  client_home: "You were home",
};

/** Translate known office reasons and format older, unknown codes as words. */
export function officeSkipReason(code: string | null | undefined): string {
  if (!code) return "";
  const label = SKIP_REASON_LABELS[code as (typeof SKIP_REASON_CODES)[number]];
  if (label) return i18n.t(`skipReason.${code}`, { defaultValue: label });
  // A code this build does not know, or a free-text reason from before codes
  // existed: readable, never a raw snake_case identifier.
  const spaced = code.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The customer-facing sentence for a code, with a fallback for unknown codes. */
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
  // Same numbers as default_skip_billable_pct. A key that did not work or an
  // empty house bills half: the walker made the trip but no walk happened,
  // and a failed key can be either side's fault. A dog that cannot walk bills
  // nothing. Owners change these in skip rules.
  key_failed: 50,
  no_one_home: 50,
  dog_unwell: 0,
  pet_hiding: 0,
  client_home: 0,
};

/** Reasons that exist for a walk and would be the wrong list on a yard. */
const WALK_ONLY_SKIP_REASON_CODES = ["key_failed", "no_one_home", "dog_unwell"] as const;
type WalkOnlySkip = (typeof WALK_ONLY_SKIP_REASON_CODES)[number];

/**
 * The reasons a TECH may pick on a yard visit.
 *
 * `customer_requested` is written only by `portal_skip_visit` when a client
 * skips their own visit. A tech choosing it would be recording the customer's
 * decision as though the customer had made it, on the one code whose billing
 * the customer's own action drives, so the picker gets this list and the
 * settings screen gets the full one. The three walk-only codes are not on a
 * yard card.
 */
export const TECH_SKIP_REASON_CODES = SKIP_REASON_CODES.filter(
  (c) =>
    c !== "customer_requested" &&
    !WALK_ONLY_SKIP_REASON_CODES.includes(c as WalkOnlySkip) &&
    c !== "pet_hiding" &&
    c !== "client_home",
) as ReadonlyArray<(typeof SKIP_REASON_CODES)[number]>;

/** What a walker picks. Yard reasons stay off this list. */
export const WALK_SKIP_REASON_CODES = [
  "access_blocked",
  "key_failed",
  "no_one_home",
  "dog_unwell",
  "weather",
  "other",
] as const satisfies readonly (typeof SKIP_REASON_CODES)[number][];

/** Short labels for the walker's picker. The office labels stay on a yard. */
export const WALK_SKIP_REASON_LABELS: Record<(typeof WALK_SKIP_REASON_CODES)[number], string> = {
  access_blocked: "Could not get in",
  key_failed: "Key or code did not work",
  no_one_home: "No one home",
  dog_unwell: "Dog unwell",
  weather: "Weather",
  other: "Other",
};

export const SIT_SKIP_REASON_LABELS = {
  pet_hiding: "Pet hiding",
  key_failed: "Key or code did not work",
  client_home: "Client home",
  access_blocked: "Could not get in",
  other: "Other",
} as const;

export function techSkipReasonCodes(walk: boolean, sitting = false): readonly string[] {
  if (sitting) return Object.keys(SIT_SKIP_REASON_LABELS);
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
    const { error } = await supabase.from("skip_billing_rules").upsert(
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
