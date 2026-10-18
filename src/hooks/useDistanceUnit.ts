import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";
import { orgDistanceUnit, type DistanceUnitOrg } from "@/lib/distance-unit";
import type { DistanceUnit } from "@/lib/measures";

/**
 * "mi" or "km" for the signed-in business, for components that print a
 * stored kilometre figure (`formatDistance` in measures.ts).
 *
 * Same `["my-org"]` query as useOrgTimezone, so it adds no fetch and works
 * offline. Not for the portal, which has no getMyOrg session.
 */
export function useDistanceUnit(): DistanceUnit {
  const fn = useServerFn(getMyOrg);
  const { data } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  return orgDistanceUnit(data?.organization as DistanceUnitOrg | null | undefined);
}
