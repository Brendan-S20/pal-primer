import type { SkippedLine } from "@/lib/import-file-table";

/** What the import did with the file's shape before the mapping step: the
 *  lines it did not read as rows (src/lib/import-file-table.ts), and a
 *  visits file read as one plan per client and service
 *  (src/lib/import-visit-plans.ts). Nothing here is hidden from the owner. */
export function ImportFileNotes({
  skipped,
  visitRows,
  plans,
  left = [],
}: {
  skipped: readonly SkippedLine[];
  visitRows: number | null;
  plans: number;
  /** Visits and plans of a visits file not imported, or to check, with the
   *  reason (planVisitFile). */
  left?: readonly string[];
}) {
  if (!skipped.length && visitRows == null && !left.length) return null;
  return (
    <div className="space-y-1 break-words rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
      {visitRows != null && (
        <p>
          {visitRows} visit rows were read as {plans} {plans === 1 ? "plan" : "plans"}, one per
          client, service and address. How often, and the first, last and next visit, come from the
          visit dates, and the price is the one most of its upcoming visits charge; the other
          columns come from each plan&apos;s next visit (or its last).
        </p>
      )}
      {left.length > 0 && (
        <>
          <p className="font-medium text-foreground">Visits and plans to check:</p>
          <ul className="list-disc space-y-0.5 ps-4">
            {left.map((l, i) => (
              <li key={`${i}-${l}`}>
                <bdi>{l}</bdi>
              </li>
            ))}
          </ul>
        </>
      )}
      {skipped.length > 0 && (
        <>
          <p className="font-medium text-foreground">Lines not imported:</p>
          <ul className="list-disc space-y-0.5 ps-4">
            {skipped.map((s) => (
              <li key={s.line}>
                Line {s.line}: {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
