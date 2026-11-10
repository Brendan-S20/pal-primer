import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getClientTextingAvailability } from "@/lib/client-texting.functions";
import type { ManagedTextingState } from "@/lib/managed-texting";

/**
 * site-r2-05: WHY this business cannot text its clients yet, when it cannot.
 * The same cached answer `useClientTexting` reads (one request for both), so
 * the yes or no and the reason never disagree. Undefined while loading.
 */
export function useTextingState(): ManagedTextingState | undefined {
  const fn = useServerFn(getClientTextingAvailability);
  const { data } = useQuery({
    queryKey: ["client-texting"],
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
  });
  return data?.state;
}
