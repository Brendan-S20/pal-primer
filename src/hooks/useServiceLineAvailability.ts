import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ServiceLineAvailability } from "@/lib/service-lines";
import { getServiceLineAvailability } from "@/lib/service-line-availability.functions";

/** The platform switch (#531), for a signed-in screen. Null until it has
 *  arrived: a screen then neither marks a line Coming soon nor lets one be
 *  added, so nothing is offered early and nothing flickers. */
export function useServiceLineAvailability(): ServiceLineAvailability | null {
  const fn = useServerFn(getServiceLineAvailability);
  const q = useQuery({
    queryKey: ["service-line-availability"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  return q.data ?? null;
}
