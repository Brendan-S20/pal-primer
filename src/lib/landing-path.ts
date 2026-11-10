// Which page a signed-in person lands on, by role.
//
// Lifted out of routes/auth.tsx (#786) so it can be tested on its own, and so
// the two reads it needs run at the same time. It used to ask "is this a
// platform admin?" and only once that answered ask "what is their role?":
// two Supabase round trips, back to back, between "we know who you are" and
// navigate(), on every sign-in. Neither read depends on the other, so they
// now go out together and the landing costs one round trip.
//
// The precedence is unchanged: a platform admin always lands in the platform
// console, whatever the role read says -- including when it failed.

type LandingDb = {
  rpc: (fn: "is_platform_admin", args: { _user_id: string }) => PromiseLike<{ data: unknown }>;
  from: (table: "user_roles") => {
    select: (cols: "role") => {
      eq: (
        col: "user_id",
        v: string,
      ) => {
        maybeSingle: () => PromiseLike<{ data: { role?: string | null } | null; error: unknown }>;
      };
    };
  };
};

export async function lookupLandingPath(db: LandingDb, userId: string): Promise<string> {
  // Platform admins always land in the platform console — never inside a
  // tenant dashboard (impersonation uses a separate magic-link session).
  const [{ data: isPlatform }, { data, error }] = await Promise.all([
    db.rpc("is_platform_admin", { _user_id: userId }),
    db.from("user_roles").select("role").eq("user_id", userId).maybeSingle(),
  ]);
  if (isPlatform) return "/platform";

  // A failed lookup is not "no role". Reading it as one sent a tech to
  // /dashboard and remembered that over their /my-day; the caller falls back
  // to the remembered answer instead.
  if (error) throw error;
  const role = data?.role;
  if (role === "tech") return "/my-day";
  if (role === "dispatcher") return "/routes";
  // owner, office_manager, or no role yet (fresh signup, where /dashboard
  // triggers onboarding).
  return "/dashboard";
}
