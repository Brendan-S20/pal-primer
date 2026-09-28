import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";

/**
 * Rules the business sets for work in the field, read from the same
 * `["my-org"]` query the shell has already loaded and the offline cache
 * persists, so My Day knows them in a dead zone too.
 *
 * `requireCompletionPhoto` defaults to true, which is what every business had
 * before it was a setting, and what the database assumes when unsure.
 */
export function useOrgFieldRules(): { requireCompletionPhoto: boolean } {
  const fn = useServerFn(getMyOrg);
  const { data } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  const org = data?.organization as { require_completion_photo?: boolean | null } | undefined;
  return { requireCompletionPhoto: org?.require_completion_photo !== false };
}
