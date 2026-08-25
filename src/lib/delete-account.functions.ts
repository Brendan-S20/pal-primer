// Deleting your own account, from inside the app.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// App Review guideline 5.1.1(v) requires an in-app path to delete an account
// wherever the app supports creating one. HoundStack does: an unrecognised
// email at sign-in walks straight into /get-started, and that chunk ships in
// the binary. Until this landed, the only route was the sentence App Review
// specifically rejects — "email support@houndstack.com" — which is what
// legal.privacy.tsx said.
//
// ── THE SPLIT BETWEEN THIS FILE AND THE SQL ──────────────────────────────
//
// delete_my_account (20260825210000) does everything that is a database fact
// and does it in one transaction: the sole-owner refusal, the ownership
// transfer, the workspace close, removing membership, and clearing the
// personal columns off `staff` — including the start/end address and
// coordinates, which for a technician is their home.
//
// This file does the two things SQL cannot reach, in a deliberate order:
//
//   1. the auth identity — email, phone and metadata, anonymised
//   2. every session, revoked, so an open tab or a phone in a pocket stops
//      working rather than running on a token nobody can now log in to renew
//
// Plus cancelling the platform subscription when a workspace is closed, which
// needs Stripe and therefore cannot be a database function.
//
// ── WHY NOT auth.admin.deleteUser ────────────────────────────────────────
//
// Because it would destroy service history. `staff.user_id` is ON DELETE
// CASCADE and `visits.assigned_staff_id` is ON DELETE SET NULL, so dropping
// the auth row drops the staff row and NULLs the technician on every visit
// they ever completed. The migration's header works through this in full. The
// person gets what they actually asked for — they cannot sign in and their
// personal details are gone — without the business losing who did the work.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Who a sole owner could hand the workspace to. Empty for everybody else,
 *  which is what lets the UI show the simple confirmation rather than the
 *  transfer picker. */
export const listOwnershipTransferCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: mine } = await supabase
      .from("user_roles")
      .select("organization_id, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (!mine || mine.role !== "owner") return { soleOwner: false as const, candidates: [] };

    const { data: owners } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("organization_id", mine.organization_id)
      .eq("role", "owner");
    if ((owners?.length ?? 0) > 1) return { soleOwner: false as const, candidates: [] };

    // Anybody else in the workspace can take it. Techs included: a two-person
    // business is often an owner and one technician, and refusing to let the
    // technician inherit would leave "close the workspace" as the only option
    // for exactly the businesses this product is for.
    const { data: staff } = await supabase
      .from("staff")
      .select("user_id, display_name, role, active")
      .eq("organization_id", mine.organization_id)
      .neq("user_id", userId)
      .eq("active", true);

    return {
      soleOwner: true as const,
      candidates: (staff ?? []).map((s) => ({
        userId: s.user_id as string,
        name: (s.display_name as string) ?? "Teammate",
        role: s.role as string,
      })),
    };
  });

export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        transferTo: z.string().uuid().optional(),
        closeWorkspace: z.boolean().optional(),
      })
      // Both at once is a contradiction rather than a preference, and silently
      // picking one would decide the fate of a business on the caller's behalf.
      .refine((v) => !(v.transferTo && v.closeWorkspace), {
        message: "Choose either transferring ownership or closing the workspace, not both.",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // 1. The database half, atomically. Throws for a sole owner who has not
    //    said what should happen to the business; that message is written for
    //    the person reading it and is surfaced verbatim by the UI.
    const { data: result, error } = await (supabase as any).rpc("delete_my_account", {
      _transfer_to: data.transferTo ?? null,
      _close_workspace: data.closeWorkspace ?? false,
    });
    if (error) throw new Error(error.message);

    const orgId = (result as any)?.organization_id as string | null;
    const closed = !!(result as any)?.workspace_closed;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 2. Stop future platform billing on a closed workspace. Best effort and
    //    AFTER the database half: a Stripe outage must not leave somebody
    //    unable to delete their account, and a subscription on a suspended
    //    workspace is recoverable while an un-deletable account is not.
    if (closed && orgId) {
      try {
        const { data: org } = await supabaseAdmin
          .from("organizations")
          .select("stripe_subscription_id")
          .eq("id", orgId)
          .maybeSingle();
        const subId = (org as any)?.stripe_subscription_id as string | null;
        if (subId) {
          // Same accessor shape billing.functions.ts uses for the PLATFORM
          // account (not a tenant's connected account): the plain secret key.
          const secret = process.env.STRIPE_SECRET_KEY;
          if (secret) {
            const { makeStripe } = await import("@/lib/stripe-client.server");
            const stripe = await makeStripe(secret);
            await stripe.subscriptions.cancel(subId);
          }
        }
      } catch (e) {
        console.error("workspace close: subscription cancel failed", (e as Error).message);
      }
    }

    // 3. Anonymise the auth identity. The address has to become something that
    //    can never receive mail and can never collide with a real signup, so
    //    the account cannot be resurrected by password reset and the address is
    //    freed for genuine reuse.
    const anonymised = `deleted-${userId}@deleted.invalid`;
    try {
      await (supabaseAdmin as any).auth.admin.updateUserById(userId, {
        email: anonymised,
        phone: null,
        user_metadata: {},
        app_metadata: { deleted_at: new Date().toISOString() },
      });
    } catch (e) {
      console.error("account deletion: identity anonymisation failed", (e as Error).message);
    }

    // 4. Revoke every session, last. Doing this earlier would cut the caller's
    //    own connection mid-way through the steps above and leave the account
    //    half-deleted with no way back in to finish.
    try {
      await (supabaseAdmin as any).auth.admin.signOut(userId, "global");
    } catch (e) {
      console.error("account deletion: session revoke failed", (e as Error).message);
    }

    return {
      ok: true as const,
      workspaceClosed: closed,
      transferred: !!(result as any)?.transferred,
    };
  });
