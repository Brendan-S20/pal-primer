import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrgFeatures } from "@/lib/org-features.functions";
import { humanizeRole } from "@/lib/humanize";
import {
  DEFAULT_SERVICE_LINES,
  runsPetWaste,
  serviceLinesOrDefault,
  type ServiceLine,
} from "@/lib/service-lines";

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

/**
 * What this business runs (organizations.service_lines), for rendering.
 *
 * Same query and the same fail-OPEN rule as useCommercialAccounts, and for a
 * sharper version of the same reason: every business on the platform today
 * is a pet-waste business, so "the lookup failed" must read as pet waste.
 * The other way round, a flaky connection in a van would take the waste log
 * off a tech's tab bar mid-route.
 *
 * One deliberate difference: while the answer is unknown, `petWaste` is TRUE
 * (and `known` is false). The tab bar and the sidebar lay themselves out from
 * this on every cold load, and for the case that is all of production today,
 * pet waste, guessing right means nothing moves when the answer arrives.
 * Something that would rather draw nothing until it knows -- a card, say --
 * checks `known`, which is what PetWasteOnly does.
 */
export function useServiceLines(): {
  lines: ServiceLine[];
  petWaste: boolean;
  known: boolean;
} {
  const fn = useServerFn(getMyOrgFeatures);
  const q = useQuery({
    queryKey: ["my-org-features"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  if (q.isLoading) return { lines: [...DEFAULT_SERVICE_LINES], petWaste: true, known: false };
  // serviceLinesOrDefault is the fail-open: an error, no data, or a value
  // that is not a usable list all read as {pet_waste}.
  const lines = serviceLinesOrDefault(q.isError ? null : q.data?.serviceLines);
  return { lines, petWaste: runsPetWaste(lines), known: true };
}

/** humanizeRole with the business's lines: "Trainer" for a technician in a
 *  training-only business (train-17). Until the lines are known, the usual
 *  word. */
export function useRoleLabel(): (role: string | null | undefined) => string {
  const { lines, known } = useServiceLines();
  return (role) => humanizeRole(role, known ? lines : null);
}

/** The lines a service picker filters by (RC3): the business's, once they
 *  are known. Until then nothing is hidden, so a pet-waste business never
 *  loses its service from a picker while the answer loads. */
export function usePickerLines(): readonly ServiceLine[] | undefined {
  const { lines, known } = useServiceLines();
  return known ? lines : undefined;
}

/** Children only for a business that runs pet waste. Nothing while the answer
 *  is unknown, like CommercialOnly; everything when the lookup fails. */
export function PetWasteOnly({ children }: { children: ReactNode }) {
  const { petWaste, known } = useServiceLines();
  if (!known) return null;
  return petWaste ? <>{children}</> : null;
}
