// The client's walk reports in the portal (#410): who walked, when, for how
// long, pee and poo when the walker recorded them, the walker's note for the
// client, and the photos. The rules for each line live in walk-report.ts,
// the same ones the walk report email uses, so the two say the same thing.
//
// Draws nothing for a client with no completed walks, which is every
// pet-waste client. English: the portal speaks the business's language.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Footprints } from "lucide-react";
import { portalListWalks, type PortalWalkReport } from "@/lib/portal-walks.functions";
import { fmtDay, usePortalCtx } from "@/lib/portal-ui";

/** The walks query, shared by the reports and the upcoming list's windows. */
export function usePortalWalks() {
  const { token, verified } = usePortalCtx();
  const fn = useServerFn(portalListWalks);
  const q = useQuery({
    queryKey: ["portal", token, "walks"],
    queryFn: () => fn({ data: { token } }),
    enabled: verified,
    staleTime: 30_000,
  });
  return {
    reports: q.data?.reports ?? [],
    upcomingWindows: q.data?.upcomingWindows ?? {},
  };
}

export function WalkReportsSection({ reports }: { reports: PortalWalkReport[] }) {
  if (reports.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        <Footprints className="h-4 w-4 shrink-0" /> Walk reports
      </h2>
      <ul className="space-y-2">
        {reports.map((r) => (
          <WalkReportCard key={r.visitId} r={r} />
        ))}
      </ul>
    </section>
  );
}

function WalkReportCard({ r }: { r: PortalWalkReport }) {
  const times =
    r.startTime && r.endTime ? `${r.startTime} to ${r.endTime}` : (r.startTime ?? r.endTime ?? null);
  const facts = [
    r.walkerFirstName ? `Walked by ${r.walkerFirstName}` : null,
    times,
    r.durationMin != null ? `${r.durationMin} min` : null,
  ].filter(Boolean);
  const bathroom = [r.peeLine, r.pooLine].filter(Boolean);
  return (
    <li className="space-y-2 rounded-md border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 break-words font-medium">{fmtDay(r.day)}</span>
        {r.serviceName && (
          <span className="min-w-0 break-words text-xs text-muted-foreground">{r.serviceName}</span>
        )}
      </div>
      {facts.length > 0 && (
        <p className="break-words text-xs text-muted-foreground">{facts.join(" · ")}</p>
      )}
      {bathroom.length > 0 && <p className="break-words">{bathroom.join(" · ")}</p>}
      {r.reportNote && (
        <p className="whitespace-pre-line break-words rounded bg-muted/50 p-2">{r.reportNote}</p>
      )}
      {r.photos.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {r.photos.map((p, i) => (
            <li key={p.url} className="min-w-0">
              <a href={p.url} target="_blank" rel="noreferrer" className="block">
                <img
                  src={p.url}
                  alt={`Walk photo ${i + 1} from ${fmtDay(r.day)}`}
                  className="aspect-square w-full rounded object-cover"
                  loading="lazy"
                />
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
