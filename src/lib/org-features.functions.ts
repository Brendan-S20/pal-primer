import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuthedContext } from "@/lib/server-fn-context";
import { resolveCaller } from "@/lib/authz.server";
import { RECLEAN_WINDOW_DEFAULT_HOURS, RECLEAN_WINDOW_MAX_HOURS } from "@/lib/reclean";
import {
  MAX_CHECKLIST_ID,
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_LABEL,
  checklistProblem,
  parseChecklist,
  type ChecklistItem,
} from "@/lib/visit-checklist";
import {
  SERVICE_LINES,
  serviceLinesAdditionProblem,
  serviceLinesOrDefault,
  serviceLinesProblem,
  type ServiceLine,
} from "@/lib/service-lines";
import { defaultServiceSeedsFor } from "@/lib/services";
import { seedTrainingPackage, seedTrainingSkills } from "@/lib/training-package-seed.server";

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
  /** What a tech confirms on every visit. Empty until the owner writes one. */
  visitChecklist: ChecklistItem[];
  /** Whether the completion email lists the items the tech checked. */
  emailVisitChecklist: boolean;
  /** What the business runs (organizations.service_lines), raw. NULL when it
   *  could not be read -- callers go through serviceLinesOrDefault, which
   *  fails open to {pet_waste}. */
  serviceLines: string[] | null;
};

export const getMyOrgFeatures = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadMyOrgFeatures(context));

/** getMyOrgFeatures's answer, also asked by getShellContext. */
export const loadMyOrgFeatures = createServerOnlyFn(
  async (context: AuthedContext): Promise<MyOrgFeatures> => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const [{ data: org }, { data: hasData }, { data: lines }] = await Promise.all([
      context.supabase
        .from("organizations")
        .select(
          "commercial_accounts, require_completion_photo, reclean_window_hours, visit_checklist, email_visit_checklist",
        )
        .eq("id", orgId)
        .maybeSingle(),
      context.supabase.rpc("org_has_commercial_data", { _org_id: orgId }),
      // Its own query, not a sixth column on the one above. If this build
      // reaches a database the migration has not reached yet, the missing
      // column fails THIS read alone -- service lines fall open to pet waste
      // -- instead of nulling the whole row and taking commercial accounts,
      // the photo rule and the checklist down with it.
      context.supabase.from("organizations").select("service_lines").eq("id", orgId).maybeSingle(),
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
      visitChecklist: parseChecklist(
        (org as { visit_checklist?: unknown } | null)?.visit_checklist,
      ),
      emailVisitChecklist: !!(org as { email_visit_checklist?: boolean } | null)
        ?.email_visit_checklist,
      serviceLines: Array.isArray(lines?.service_lines) ? lines.service_lines : null,
    };
  },
);

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

/** The visit checklist. complete_visit reads the column and refuses while a
 *  required item is unchecked; the CHECK on the column
 *  (visit_checklist_is_valid) holds the same limits as the validator here, so
 *  the owner reads a sentence rather than a constraint name. Labels are
 *  trimmed before they are stored, because the database copies them onto
 *  every visit completed against them. */
export const setVisitChecklist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        items: z
          .array(
            z.object({
              id: z.string().min(1).max(MAX_CHECKLIST_ID),
              label: z.string().trim().min(1).max(MAX_CHECKLIST_LABEL),
              required: z.boolean(),
            }),
          )
          .max(MAX_CHECKLIST_ITEMS),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const problem = checklistProblem(data.items);
    if (problem) throw new Error(problem);
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, { visit_checklist: data.items });
    return { ok: true, visitChecklist: data.items };
  });

/** Whether the completion email tells the customer what was checked. */
export const setEmailVisitChecklist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, { email_visit_checklist: data.enabled });
    return { ok: true, emailVisitChecklist: data.enabled };
  });

async function ensureDefaultServicesForLines(
  supabase: any,
  orgId: string,
  lines: readonly ServiceLine[],
): Promise<void> {
  const seeds = defaultServiceSeedsFor(lines);
  if (seeds.length === 0) return;

  const { data: existing, error: readError } = await supabase
    .from("services")
    .select("name")
    .eq("organization_id", orgId);
  if (readError) throw new Error(readError.message);

  const have = new Set(
    ((existing ?? []) as { name?: string | null }[])
      .map((s) => s.name?.trim().toLowerCase())
      .filter(Boolean) as string[],
  );

  for (const seed of seeds) {
    const key = seed.name.trim().toLowerCase();
    if (have.has(key)) continue;
    const { error } = await supabase.from("services").insert({
      ...seed,
      name: seed.name.trim(),
      organization_id: orgId,
    });
    if (error) {
      if (error.code === "23505") {
        have.add(key);
        continue;
      }
      throw new Error(error.message);
    }
    have.add(key);
  }
}

/** What the business runs. Written the way the photo rule and the checklist
 *  are -- manage_settings, then a plain update through updateOwnOrg under the
 *  "Settings managers update own org" policy -- so nothing is widened; the
 *  CHECK on the column (service_lines_are_valid) holds the same rule as the
 *  validator here, which exists so the owner reads a sentence rather than a
 *  constraint name.
 *
 *  It never refuses a set because of the org's data. Unlike commercial
 *  accounts, nothing hidden by dropping pet waste is billing anybody (the
 *  modules that could -- a configured first cleanup, area pricing on a zone,
 *  a seasonal campaign -- stay visible while they are configured), and the
 *  rows themselves are untouched.
 *
 *  The one refusal is a launch gate: a line that is not bookable on the
 *  platform switch (read at runtime, #531) cannot be added. A line the org already has is kept, so saving an
 *  unrelated change never fails for a business that runs one. */
export const setServiceLines = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        lines: z
          .array(z.enum(SERVICE_LINES as unknown as [ServiceLine, ...ServiceLine[]]))
          .min(1)
          .max(SERVICE_LINES.length),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const problem = serviceLinesProblem(data.lines);
    if (problem) throw new Error(problem);
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    // A line that is Coming soon can be kept or dropped, never added.
    // Read, not assumed: a failed read must not pass as {pet_waste} and
    // refuse a line the org already runs.
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("service_lines")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const { loadServiceLineAvailability } = await import("@/lib/service-line-availability.server");
    const adding = serviceLinesAdditionProblem(
      serviceLinesOrDefault(org?.service_lines),
      data.lines,
      await loadServiceLineAvailability(),
    );
    if (adding) throw new Error(adding);
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, { service_lines: data.lines });
    await ensureDefaultServicesForLines(context.supabase, orgId, data.lines);
    if (data.lines.includes("training")) {
      await seedTrainingPackage(context.supabase, orgId);
      await seedTrainingSkills(context.supabase, orgId);
    }
    return { ok: true, serviceLines: data.lines };
  });
