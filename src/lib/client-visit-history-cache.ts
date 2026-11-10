// The client page's visit list (["client-visit-history", clientId]) is what
// every row on the Visits tab reads. When the office completes a visit, the
// toast says so at once; the row has to as well, without waiting on a refetch
// that can be slow, fail, or come back before it has seen the write (#789).
// So the completed status goes into the list first, and the caller still
// invalidates it so the server has the last word.
import type { QueryClient } from "@tanstack/react-query";

export const clientVisitHistoryKey = (clientId: string) =>
  ["client-visit-history", clientId] as const;

type VisitRow = { id: string; status?: string | null; completed_at?: string | null };

export function markVisitCompletedInClientHistory(
  qc: QueryClient,
  clientId: string,
  visitId: string,
  now: Date = new Date(),
): void {
  qc.setQueryData<{ visits?: VisitRow[] }>(clientVisitHistoryKey(clientId), (old) => {
    if (!old?.visits?.some((v) => v.id === visitId)) return old;
    return {
      ...old,
      visits: old.visits.map((v) =>
        v.id === visitId
          ? { ...v, status: "completed", completed_at: v.completed_at ?? now.toISOString() }
          : v,
      ),
    };
  });
}
