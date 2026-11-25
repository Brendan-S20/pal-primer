import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getStartPoints } from "@/lib/visits.functions";

/** Where a day can start from; see src/lib/start-point.ts. Undefined until known. */
export function useStartPoints() {
  const fn = useServerFn(getStartPoints);
  return useQuery({
    queryKey: ["start-points"],
    queryFn: () => fn(),
    staleTime: 60_000,
  }).data;
}
