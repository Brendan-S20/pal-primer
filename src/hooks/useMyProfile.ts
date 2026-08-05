import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyProfile } from "@/lib/profile.functions";

/**
 * The signed-in person's own staff row.
 *
 * Shared by the header menu, the sidebar footer, the mobile "More" sheet and
 * the profile page, all of which render on nearly every screen — hence the
 * long staleTime. Your own name and photo do not change behind your back;
 * when they do, the profile page invalidates this key.
 */
export function useMyProfile() {
  const fn = useServerFn(getMyProfile);
  const q = useQuery({
    queryKey: ["my-profile"],
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
  });
  return {
    staff: q.data?.staff ?? null,
    authEmail: q.data?.authEmail ?? null,
    emailConfirmed: q.data?.emailConfirmed ?? false,
    pendingEmail: q.data?.pendingEmail ?? null,
    loading: q.isLoading,
  };
}

export const MY_PROFILE_KEY = ["my-profile"] as const;
