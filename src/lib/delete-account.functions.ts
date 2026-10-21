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
// coordinates, which for a technician is their home. Since 20261018060000 it
// also deletes the person's push subscriptions and Live Activity tokens.
//
// This file does the things SQL cannot reach, in a deliberate order:
//
//   1. the profile photo files in the "avatars" bucket, removed
//   2. the auth identity: email, phone and metadata, anonymised
//   3. every session, revoked, so an open tab or a phone in a pocket stops
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
/**
 * A step of account deletion that runs AFTER the database half has committed.
 *
 * Each is best effort by design, so each can fail without failing the
 * deletion. Naming them is what lets the screen say which one, and lets a
 * `switch` over them fail to compile when a fourth is added.
 */
export type DeletionStep = "billing" | "avatar" | "identity" | "sessions";

/** Profile photos live at avatars/{org_id}/{user_id}/{timestamp}.{ext}. */
const AVATAR_BUCKET = "avatars";
/** One page of a Storage listing. Removed files drop out of the next page. */
const AVATAR_PAGE = 100;
/** A stop for a folder that never empties, so the loop cannot spin. */
const AVATAR_MAX_PAGES = 50;
/** What a user or org id has to look like before it goes into a folder path. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Removes every file in each of the person's avatar folders.
 *
 * Throws on the first Storage error, so the caller can record the step as
 * incomplete. Exported for the DB test.
 */
export async function removeAvatarFolders(
  admin: any,
  orgIds: string[] | null,
  userId: string,
): Promise<void> {
  // Null means the lookup failed. Not knowing the folders is a failed step.
  if (!orgIds) throw new Error("the person's organizations could not be read");
  // The folder is `${orgId}/${userId}`. An empty or odd id would widen the
  // listing to a whole org's photos (or the bucket root), so every id must be
  // a UUID before anything is listed.
  if (!UUID.test(userId)) throw new Error("refusing avatar removal: userId is not a UUID");
  for (const orgId of orgIds) {
    if (!UUID.test(orgId)) throw new Error("refusing avatar removal: an orgId is not a UUID");
  }
  for (const orgId of orgIds) {
    const folder = `${orgId}/${userId}`;
    for (let page = 0; page < AVATAR_MAX_PAGES; page++) {
      const { data, error } = await admin.storage
        .from(AVATAR_BUCKET)
        .list(folder, { limit: AVATAR_PAGE });
      if (error) throw new Error(error.message);
      const paths = ((data ?? []) as Array<{ name: string }>).map((f) => `${folder}/${f.name}`);
      if (paths.length === 0) break;
      const { error: removeError } = await admin.storage.from(AVATAR_BUCKET).remove(paths);
      if (removeError) throw new Error(removeError.message);
    }
  }
}

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

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 0. Which orgs hold this person's avatar folders. Read now, because the
    //    RPC deletes user_roles. The staff row stays, but read it too: a
    //    person can have a staff row in an org with no membership left. A
    //    failed read only costs the avatar step, so it does not throw.
    let avatarOrgIds: string[] | null = null;
    try {
      const [roles, staff] = await Promise.all([
        supabaseAdmin.from("user_roles").select("organization_id").eq("user_id", userId),
        supabaseAdmin.from("staff").select("organization_id").eq("user_id", userId),
      ]);
      if (roles.error) throw new Error(roles.error.message);
      if (staff.error) throw new Error(staff.error.message);
      const ids = [...(roles.data ?? []), ...(staff.data ?? [])]
        .map((r: any) => r.organization_id as string | null)
        .filter((id): id is string => !!id);
      avatarOrgIds = [...new Set(ids)];
    } catch (e) {
      console.error("account deletion: avatar org lookup failed", (e as Error).message);
    }

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

    // ── WHAT DID NOT HAPPEN, RATHER THAN A BARE ok ──────────────────────
    //
    // The steps below are best effort ON PURPOSE and that does not
    // change: the database half has already committed, and a Stripe outage or
    // a GoTrue hiccup must not leave somebody unable to delete their account.
    // Each reason is argued at its own step.
    //
    // What was wrong is that all three swallowed their failure and the
    // function returned `ok: true` regardless, so the screen said "Your
    // account is deleted" whether or not it was. The three are not equally
    // serious and none of them is cosmetic:
    //
    //   billing   a closed workspace keeps its subscription, so we go on
    //             taking money from somebody who closed their account.
    //   identity  the address is still on the account. It can still receive
    //             a password reset, and it still collides with a genuine
    //             re-signup. This is the one where "deleted" is furthest from
    //             true, and the person is the only one who can chase it.
    //   sessions  every already-signed-in device stays signed in. A deletion
    //             done because a laptop was lost does not achieve the thing it
    //             was done for.
    //   avatar    the profile photo files are still in Storage. Nobody can
    //             reach them without the service role, but the privacy
    //             policy says deletion removes them.
    //
    // So they are named and returned. The caller decides what to say; what it
    // must not do any more is claim a clean deletion it cannot vouch for.
    const incomplete: DeletionStep[] = [];

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
        incomplete.push("billing");
        console.error("workspace close: subscription cancel failed", (e as Error).message);
      }
    }

    // 3. Remove the profile photo files. The RPC cleared staff.avatar_url,
    //    but the files stay in Storage, and older uploads can sit beside the
    //    current one. SQL cannot delete a Storage object, so it happens here,
    //    with the service role, for every org folder read in step 0.
    try {
      await removeAvatarFolders(supabaseAdmin, avatarOrgIds, userId);
    } catch (e) {
      incomplete.push("avatar");
      console.error("account deletion: avatar removal failed", (e as Error).message);
    }

    // 4. Anonymise the auth identity. The address has to become something that
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
      incomplete.push("identity");
      console.error("account deletion: identity anonymisation failed", (e as Error).message);
    }

    // 5. Revoke every session, last. Doing this earlier would cut the caller's
    //    own connection mid-way through the steps above and leave the account
    //    half-deleted with no way back in to finish.
    try {
      await (supabaseAdmin as any).auth.admin.signOut(userId, "global");
    } catch (e) {
      incomplete.push("sessions");
      console.error("account deletion: session revoke failed", (e as Error).message);
    }

    return {
      // Still `ok`, and deliberately: the records ARE gone, because the RPC
      // throws rather than returning on failure and we never reach here if it
      // did. Turning a failed session revoke into an error would tell somebody
      // their deletion failed when the irreversible part of it succeeded, and
      // would invite them to press the button again.
      ok: true as const,
      workspaceClosed: closed,
      transferred: !!(result as any)?.transferred,
      incomplete,
    };
  });
