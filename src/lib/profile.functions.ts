/**
 * Your own account: name, photo, phone, email, password.
 *
 * Every function here is deliberately scoped to the caller and takes no id.
 * The alternative — a `staffId` parameter and a permission check — is how an
 * "edit my profile" endpoint quietly becomes an "edit anyone's profile"
 * endpoint the first time somebody reuses it from an admin screen. Users &
 * roles already exists for managing other people; this file cannot reach
 * them, by construction.
 *
 * Email and password go through Supabase Auth rather than the staff table:
 *
 *   - `staff.email` is a display copy. Changing it there would leave you
 *     signing in with the old address forever, which is the worst possible
 *     outcome — the UI would show the change succeeded.
 *   - Auth sends a confirmation link to the NEW address before switching. So
 *     `changeMyEmail` returns "check your email", not "done", because it is
 *     not done. The staff row is updated only when the change is confirmed,
 *     by `syncMyEmailFromAuth` on the next profile load.
 */
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AuthedContext } from "@/lib/server-fn-context";

const STAFF_FIELDS =
  "id, organization_id, user_id, display_name, email, phone, role, avatar_url, is_field_tech, active, created_at";

async function myStaffRow(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("staff")
    .select(STAFF_FIELDS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export const getMyProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadMyProfile(context));

/** getMyProfile's answer, also asked by getShellContext. */
export const loadMyProfile = createServerOnlyFn(
  async (context: AuthedContext) => {
    const { supabase, userId } = context;
    const staff = await myStaffRow(supabase, userId);

    // The address you actually sign in with, which is not necessarily the one
    // on the staff row — see the note at the top of the file.
    const { data: auth } = await supabase.auth.getUser();
    const authEmail: string | null = auth?.user?.email ?? null;

    // A confirmed email change lands in Auth and nowhere else. Reconciling it
    // here means the staff row heals on the next page load instead of staying
    // wrong until somebody edits it by hand.
    if (staff && authEmail && staff.email !== authEmail) {
      await supabase.from("staff").update({ email: authEmail }).eq("user_id", userId);
      staff.email = authEmail;
    }

    return {
      staff,
      authEmail,
      // Surfaced so the page can say "unconfirmed" rather than implying the
      // change already took effect.
      emailConfirmed: Boolean(auth?.user?.email_confirmed_at),
      pendingEmail: (auth?.user as any)?.new_email ?? null,
    };
  },
);

export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        displayName: z.string().trim().min(1, "A name is required").max(80),
        phone: z.string().trim().max(40).optional().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("staff")
      .update({
        display_name: data.displayName,
        phone: data.phone?.trim() ? data.phone.trim() : null,
      })
      // Scoped to the caller's own row. No id crosses the wire, so there is
      // nothing to tamper with.
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Records a newly uploaded avatar and removes the one it replaces.
 *
 * The upload itself happens in the browser, straight to storage — the bytes
 * never pass through a server function. This only writes the path, and the
 * storage policy is what actually decides whether the write was allowed: a
 * path pointing at somebody else's folder could be posted here, but the
 * upload that produced it would already have been refused.
 *
 * The path is still validated against the caller's own user id, because
 * storing a path to a file you do not own would make the avatar break the
 * moment its real owner replaced theirs.
 */
export const setMyAvatar = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ path: z.string().max(400).nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const staff = await myStaffRow(supabase, userId);
    if (!staff) throw new Error("No staff record for this account");

    if (data.path) {
      const [orgSeg, userSeg] = data.path.split("/");
      if (orgSeg !== staff.organization_id || userSeg !== userId) {
        throw new Error("That file does not belong to your account");
      }
    }

    const previous: string | null = staff.avatar_url;
    const { error } = await supabase
      .from("staff")
      .update({ avatar_url: data.path })
      .eq("user_id", userId);
    if (error) throw new Error(error.message);

    // Best-effort. A failed cleanup leaves an orphan file, which costs a few
    // kilobytes; failing the whole request over it would leave the person
    // looking at their old photo and an error, which costs their trust.
    if (previous && previous !== data.path) {
      await supabase.storage.from("avatars").remove([previous]);
    }
    return { ok: true };
  });

export const changeMyEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ email: z.string().trim().email() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: current } = await supabase.auth.getUser();
    if (current?.user?.email?.toLowerCase() === data.email.toLowerCase()) {
      throw new Error("That is already your email address");
    }
    const { error } = await supabase.auth.updateUser({ email: data.email });
    if (error) throw new Error(error.message);
    // Not "changed". Nothing has changed until the link in that message is
    // clicked, and saying otherwise is how somebody locks themselves out
    // believing they updated their sign-in address.
    return { sentTo: data.email };
  });

export const sendMyPasswordReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ redirectTo: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: current } = await supabase.auth.getUser();
    const email = current?.user?.email;
    if (!email) throw new Error("No email address on this account");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: data.redirectTo,
    });
    if (error) throw new Error(error.message);
    return { sentTo: email };
  });
