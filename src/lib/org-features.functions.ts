import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { RECLEAN_WINDOW_DEFAULT_HOURS, RECLEAN_WINDOW_MAX_HOURS } from "@/lib/reclean";

// What KIND of business this org is, for rendering.
//
// Distinct from entitlements, and the distinction is the whole point.
// `getMyEntitlements` answers "what has this org paid for" — a paywall, where
// the client-side check is a courtesy and requireEntitlement() on the server
// is the enforcement, because there is an adversary and bypassing it costs
// revenue.
//
// This answers "what does this org want to see", chosen by the owner about
// their own screens. There is no adversary: the person who could bypass it is
// the person who set it. So this one is presentational all the way down, and
// deliberately has NO server-side counterpart that throws.
//
// That is not laziness. Enforcing it server-side would convert a decluttering
// preference into hard failures in CSV import (a Jobber export marks companies
// commercial and would start erroring), in nightly repricing, and in visit
// booking — all paths that legitimately touch commercial rows on behalf of an
// org that has simply tidied its sidebar.
//
// Membership-only, like getMyEntitlements: every role can be told what kind of
// business they work for.

export type MyOrgFeatures = {
  /** Owner's answer to "do you serve HOAs, apartment complexes, dog parks?" */
  commercialAccounts: boolean;
  /** Whether commercial rows exist. Drives the explanation on the settings
   *  switch for why turning it off is refused — see the migration header. */
  hasCommercialData: boolean;
  /** Whether a tech needs a completion photo (or a stated reason) to finish. */
  requireCompletionPhoto: boolean;
  /** Re-clean guarantee: hours after a completed visit a customer can ask for
   *  a free re-clean from the portal. 0 is off. */
  recleanWindowHours: number;
};

export const getMyOrgFeatures = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyOrgFeatures> => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const [{ data: org }, { data: hasData }] = await Promise.all([
      context.supabase
        .from("organizations")
        .select("commercial_accounts, require_completion_photo, reclean_window_hours")
        .eq("id", orgId)
        .maybeSingle(),
      context.supabase.rpc("org_has_commercial_data", { _org_id: orgId }),
    ]);
    return {
      commercialAccounts: !!(org as { commercial_accounts?: boolean } | null)?.commercial_accounts,
      hasCommercialData: !!hasData,
      requireCompletionPhoto:
        (org as { require_completion_photo?: boolean } | null)?.require_completion_photo !== false,
      recleanWindowHours: Number(
        (org as { reclean_window_hours?: number } | null)?.reclean_window_hours ??
          RECLEAN_WINDOW_DEFAULT_HOURS,
      ),
    };
  });

export const setCommercialAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    // Through the RPC, not a table update: it re-checks manage_settings and
    // refuses to switch OFF while commercial clients, properties, stations or
    // DNA enrolment exist. Doing that check here instead would leave the
    // refusal one `.update()` away from being bypassed.
    const { error } = await context.supabase.rpc("set_org_commercial_accounts", {
      _enabled: data.enabled,
    });
    if (error) throw new Error(error.message);
    return { ok: true, commercialAccounts: data.enabled };
  });

/** The business's photo rule for finishing a visit. complete_visit reads the
 *  column; a tech can still finish without a photo by saying why. */
export const setRequireCompletionPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ required: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, { require_completion_photo: data.required });
    return { ok: true, requireCompletionPhoto: data.required };
  });

/** The re-clean guarantee's window. portal_request_reclean reads the column,
 *  and the portal reads it to decide which visits offer "Request a re-clean";
 *  0 turns the offer off everywhere. The CHECK on the column is 0..168, and
 *  the validator says the same so the owner reads a sentence, not a
 *  constraint name. */
export const setRecleanWindowHours = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ hours: z.number().int().min(0).max(RECLEAN_WINDOW_MAX_HOURS) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, { reclean_window_hours: data.hours });
    return { ok: true, recleanWindowHours: data.hours };
  });
