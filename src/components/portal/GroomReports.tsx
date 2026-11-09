// The client's groom reports in the portal (#412): the next groom on the
// schedule, then each finished groom with who groomed, what was booked, the
// add-ons that were billed, the groomer's note, and the before and after
// photos side by side.
//
// Draws nothing for a client with no grooms. English: the portal speaks the
// business's language, not the reader's device (see CLAUDE.md).

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, Scissors } from "lucide-react";
import { clockOf } from "@/lib/groom-request";
import type { PortalGroomReport } from "@/lib/groom-report";
import { portalListGroomReports } from "@/lib/portal-groom-reports.functions";
import { fmtDay, usePortalCtx } from "@/lib/portal-ui";

export function GroomReportsSection() {
  const { token, verified } = usePortalCtx();
  const fn = useServerFn(portalListGroomReports);
  const q = useQuery({
    queryKey: ["portal", token, "groom-reports"],
    queryFn: () => fn({ data: { token } }),
    enabled: verified,
    staleTime: 30_000,
  });
  const reports = q.data?.reports ?? [];
  const next = q.data?.next ?? null;
  if (!next && reports.length === 0) return null;
  const at = clockOf(next?.startTime);

  return (
    <div className="space-y-6">
      {next && (
        <section className="flex min-w-0 items-start gap-2 rounded-lg border bg-card p-4 text-sm">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="font-semibold">Your next groom</h2>
            <p className="break-words text-muted-foreground">
              {fmtDay(next.day)}
              {at ? ` at ${at}` : ""}
              {next.serviceName ? ` · ${next.serviceName}` : ""}
            </p>
          </div>
        </section>
      )}
      {reports.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
            <Scissors className="h-4 w-4 shrink-0" /> Groom reports
          </h2>
          <ul className="space-y-2">
            {reports.map((r) => (
              <GroomReportCard key={r.visitId} r={r} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function GroomReportCard({ r }: { r: PortalGroomReport }) {
  return (
    <li className="space-y-2 rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 break-words font-medium">{fmtDay(r.day)}</span>
        {r.serviceName && (
          <span className="min-w-0 break-words text-xs text-muted-foreground">{r.serviceName}</span>
        )}
      </div>
      {r.groomerFirstName && (
        <p className="break-words text-xs text-muted-foreground">Groomed by {r.groomerFirstName}</p>
      )}
      {r.summary && <p className="break-words">{r.summary}</p>}
      {r.addonsDone.length > 0 && (
        <p className="break-words">
          <span className="text-muted-foreground">Add-ons done:</span> {r.addonsDone.join(", ")}
        </p>
      )}
      {r.reportNote && (
        <p className="whitespace-pre-line break-words rounded bg-muted/50 p-2">{r.reportNote}</p>
      )}
      {(r.before.length > 0 || r.after.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <PhotoRow label="Before" urls={r.before} day={r.day} />
          <PhotoRow label="After" urls={r.after} day={r.day} />
        </div>
      )}
    </li>
  );
}

function PhotoRow({ label, urls, day }: { label: string; urls: string[]; day: string }) {
  if (urls.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="grid grid-cols-3 gap-2">
        {urls.map((url, i) => (
          <li key={url} className="min-w-0">
            <a href={url} target="_blank" rel="noreferrer" className="block min-h-11">
              <img
                src={url}
                alt={`${label} photo ${i + 1} from ${fmtDay(day)}`}
                className="aspect-square w-full rounded object-cover"
                loading="lazy"
              />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
