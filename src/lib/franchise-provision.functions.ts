import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import {
  LOCATION_MEMBER_ROLES,
  MAX_LOCATION_MEMBERS,
  type LocationMemberRole,
} from "@/lib/provision-location";

// BUILD-6 — the franchise OPENS a location.
//
// The other two paths onto /franchise are for organizations that already exist:
// FranchiseLinkCodes recruits one that signed up independently, and
// franchise-membership.functions.ts is the child's side of accepting. This is
// the third case and the one the owner actually described — a franchise opening
// a new location, naming who works there, and the operator doing no setup at
// all.
//
// provision_franchise_location has existed and been correct since 2026-07-30.
// Nothing called it. It is the same failure this codebase keeps producing —
// franchise_rollup, the weekly digest, `trialing`, franchise_share_cents — and
// the reason IMP-11's detector exists. This file is the call site.
//
// WHY THE RPC RUNS ON THE CALLER'S CLIENT. The function is SECURITY DEFINER and
// resolves the parent from auth.uid(): who is signed in *is* the input. Handing
// it the service-role client would make auth.uid() null and the function would
// refuse — correctly, because at that point it has no way to know which
// franchise is opening a location, or whether that person is its owner.

const memberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  // From the shared module, so this list and the form's cannot drift — and so
  // "platform_admin" is absent by construction rather than by remembering.
  role: z.enum(LOCATION_MEMBER_ROLES),
});

export type ProvisionedInvite = {
  email: string;
  role: LocationMemberRole;
  /** Did the invitation email actually go out? See the note below on why a
   *  false here is a disclosure rather than a failure. */
  emailed: boolean;
};

export const provisionFranchiseLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        name: z.string().trim().min(1, "Give the location a name.").max(120),
        members: z.array(memberSchema).min(1).max(MAX_LOCATION_MEMBERS),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // manage_franchise + the Enterprise entitlement, the same funnel every
    // other franchise function runs through (franchise.functions.ts). The SQL
    // independently re-checks that the caller is an owner of the parent; this
    // layer is not the boundary, it is the first of two.
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_franchise",
    );
    const { requireEntitlement } = await import("@/lib/entitlements.server");
    await requireEntitlement(orgId, "franchise_structure");

    // Everything else the SQL validates — an owner among the members, no
    // duplicate addresses, nobody who already belongs to an organization, two
    // levels only — is left to the SQL rather than mirrored here. Re-checking
    // it in TypeScript would mean two sets of rules that can disagree, and the
    // messages it raises are already written to be shown to a person.
    const { data: newOrgId, error } = await (context.supabase as any).rpc(
      "provision_franchise_location",
      { _name: data.name, _members: data.members },
    );
    if (error) throw new Error(error.message);

    // The location exists and its invites are pending from this point on. Mail
    // is the last step and deliberately cannot fail the operation: an invite
    // that was written but not emailed is still redeemable — acceptance matches
    // on the signed-in address, not on a link — whereas rolling the location
    // back because a mail provider hiccuped would destroy something real to
    // undo something cosmetic.
    //
    // Which addresses failed is returned rather than swallowed, because the
    // franchise owner is the only person who can act on it.
    const { sendInviteEmail } = await import("@/lib/invite-email.server");
    const invited: ProvisionedInvite[] = await Promise.all(
      data.members.map(async (m) => ({
        email: m.email,
        role: m.role,
        emailed: await sendInviteEmail(data.name, m.email, m.role),
      })),
    );

    return { organizationId: newOrgId as string, name: data.name, invited };
  });
