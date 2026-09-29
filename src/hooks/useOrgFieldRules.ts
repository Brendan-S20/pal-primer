import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";
import { parseChecklist, type ChecklistItem } from "@/lib/visit-checklist";

/**
 * Rules the business sets for work in the field, read from the same
 * `["my-org"]` query the shell has already loaded and the offline cache
 * persists, so My Day knows them in a dead zone too.
 *
 * `requireCompletionPhoto` defaults to true, which is what every business had
 * before it was a setting, and what the database assumes when unsure.
 *
 * `checklist` is the owner's visit checklist, empty for every org that has
 * not written one. complete_visit enforces the same list in the database;
 * this copy is what draws it and gates the Complete button.
 */
export function useOrgFieldRules(): {
  requireCompletionPhoto: boolean;
  checklist: ChecklistItem[];
} {
  const fn = useServerFn(getMyOrg);
  const { data } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  const org = data?.organization as
    { require_completion_photo?: boolean | null; visit_checklist?: unknown } | undefined;
  const raw = org?.visit_checklist;
  // Memoised on the raw value, so the card's gate is not handed a new array
  // on every render.
  const checklist = useMemo(() => parseChecklist(raw), [raw]);
  return { requireCompletionPhoto: org?.require_completion_photo !== false, checklist };
}
