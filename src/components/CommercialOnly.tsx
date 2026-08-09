import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrgFeatures } from "@/lib/org-features.functions";

/**
 * Hides commercial-account machinery from an org that only does driveways.
 *
 * Deliberately NOT modelled on `PlanGate`, despite looking similar. PlanGate
 * shows an upgrade prompt, because the thing behind it is for sale. There is
 * nothing to sell here and nothing to upsell to: an org that says it has no
 * HOAs should see no trace of HOAs, not a locked card advertising them. So
 * the false branch renders nothing at all.
 *
 * It copies the two things PlanGate gets right, for the same reasons:
 *
 *   - Nothing while the answer is unknown. Flashing a Units tab and then
 *     yanking it, or flashing its absence at an org that does serve HOAs, are
 *     both worse than a beat of blank space.
 *   - Fail OPEN on error. This is a decluttering preference, not a lock. If
 *     the lookup fails, showing a slightly busier screen is strictly better
 *     than hiding the tab where a customer's unit charges live.
 */
export function useCommercialAccounts(): { enabled: boolean; known: boolean } {
  const fn = useServerFn(getMyOrgFeatures);
  const q = useQuery({
    queryKey: ["my-org-features"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  // `known: false` means "don't render either way yet". `enabled` falls open
  // to true on error for the reason in the header.
  if (q.isLoading) return { enabled: false, known: false };
  if (q.isError || !q.data) return { enabled: true, known: true };
  return { enabled: q.data.commercialAccounts, known: true };
}

export function CommercialOnly({ children }: { children: ReactNode }) {
  const { enabled, known } = useCommercialAccounts();
  if (!known) return null;
  return enabled ? <>{children}</> : null;
}
