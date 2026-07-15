// Visits tab (spec): scheduled window and actual timing are separate,
// clearly labeled things. Missing timestamps say so instead of blurring
// estimates into facts.
import { Badge } from "@/components/ui/badge";

const STATUS_TONE: Record<string, string> = {
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  scheduled: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  in_progress: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  skipped: "bg-muted text-muted-foreground",
  canceled: "bg-destructive/10 text-destructive",
};

function fmtTime(ts: string | null | undefined): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function fmtWindow(v: any): string {
  if (v.eta_start && v.eta_end) return `${fmtTime(v.eta_start)} - ${fmtTime(v.eta_end)}`;
  const early = v.properties?.earliest_service_time?.slice(0, 5);
  const late = v.properties?.latest_service_time?.slice(0, 5);
  if (early && late) return `${early} - ${late}`;
  if (early) return `After ${early}`;
  if (late) return `Before ${late}`;
  return "Anytime";
}

function durationMin(v: any): number | null {
  if (!v.started_at || !v.completed_at) return null;
  const ms = new Date(v.completed_at).getTime() - new Date(v.started_at).getTime();
  if (ms <= 0) return null;
  return Math.round(ms / 60000);
}

export function VisitsTab({ visits, isLoading }: { visits: any[]; isLoading: boolean }) {
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (visits.length === 0)
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No visits yet. They appear here once a service starts generating them.
      </div>
    );

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Date</th>
            <th className="px-4 py-2.5 font-medium">Scheduled window</th>
            <th className="px-4 py-2.5 font-medium">Actual start</th>
            <th className="px-4 py-2.5 font-medium">Actual completion</th>
            <th className="px-4 py-2.5 font-medium">Duration</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Property</th>
            <th className="px-4 py-2.5 font-medium">Tech</th>
          </tr>
        </thead>
        <tbody>
          {visits.map((v: any) => {
            const done = v.status === "completed";
            const inProgress = v.status === "in_progress";
            const dur = durationMin(v);
            return (
              <tr key={v.id} className="border-b last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5">
                  {v.scheduled_on}
                  {v.rescheduled_from && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (moved from {v.rescheduled_from})
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{fmtWindow(v)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {v.started_at ? (
                    fmtTime(v.started_at)
                  ) : done || inProgress ? (
                    <span className="text-xs italic text-muted-foreground">Arrival not recorded</span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {v.completed_at ? (
                    fmtTime(v.completed_at)
                  ) : done ? (
                    <span className="text-xs italic text-muted-foreground">
                      Completion not recorded
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  {dur != null ? `${dur} min` : <span className="text-muted-foreground">-</span>}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[v.status] ?? "bg-muted"}`}
                  >
                    {String(v.status).replace("_", " ")}
                  </span>
                  {v.status === "skipped" && (v.skip_reason_code || v.skip_reason) && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {String(v.skip_reason_code ?? v.skip_reason).replace(/_/g, " ")}
                    </span>
                  )}
                  {v.is_deepclean && (
                    <Badge variant="outline" className="ml-1 text-[10px]">
                      Deep clean
                    </Badge>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {v.properties?.street ?? "-"}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                  {v.staff?.display_name ?? "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
