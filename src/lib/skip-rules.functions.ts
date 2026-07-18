import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

export const SKIP_REASON_CODES = [
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
  client_cancelled_late: "Client cancelled late",
  gate_locked: "Gate locked / no access",
  dog_outside: "Dog was outside",
  weather: "Weather",
  our_fault: "Our fault",
  access_blocked: "Access blocked (car, construction, etc.)",
  unsafe_conditions: "Unsafe conditions",
  other: "Other",
};

const DEFAULT_PCT: Record<(typeof SKIP_REASON_CODES)[number], number> = {
  client_cancelled_late: 100,
  gate_locked: 100,
  dog_outside: 100,
  weather: 0,
  our_fault: 0,
  access_blocked: 100,
  unsafe_conditions: 50,
  other: 0,
};

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
