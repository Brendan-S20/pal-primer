import Papa from "papaparse";
import { toast } from "sonner";
import { isJobberVisitsReport } from "@/lib/import-jobber-visits";

type Row = Record<string, unknown>;

/** The optional second file on a Jobber plans import: the Visits report,
 *  read in the browser and handed back as rows. Its last completed and next
 *  booked visit per Job # go on each plan (src/lib/import-jobber-visits.ts). */
export function JobberVisitsFile({
  count,
  onRows,
}: {
  count: number | null;
  onRows: (rows: Row[] | null) => void;
}) {
  const onFile = (f: File | null) => {
    if (!f) return onRows(null);
    Papa.parse<Row>(f, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        if (!isJobberVisitsReport(res.meta.fields ?? [])) {
          onRows(null);
          toast.error(
            "That is not Jobber's Visits report: it needs the Job #, Date and Visit completed date columns.",
          );
          return;
        }
        onRows(res.data);
      },
      error: (err) => toast.error(`CSV parse error: ${err.message}`),
    });
  };
  return (
    <label className="block space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
      <span className="font-medium text-foreground">
        Last and next visit (optional): Jobber&apos;s Visits report
      </span>
      <span className="block text-muted-foreground">
        In Jobber, go to Insights &gt; Reports &gt; Visits, set the dates to cover the past few
        months and the next few, and export All Columns. Each plan then gets its last completed
        visit and its next booked visit, matched by Job #, and its schedule starts from that next
        visit.
        {count != null && ` ${count} visits read.`}
      </span>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        className="block w-full cursor-pointer text-sm text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
      />
    </label>
  );
}
