import { fmtDay } from "@/lib/portal-ui";

export type PortalVisitReportFields = {
  day: string;
  serviceName?: string | null;
  startTime?: string;
  endTime?: string;
  durationMin?: number;
  reportNote?: string;
  photos: Array<{ url: string; kind: string }>;
};

/** The report content shared by walks and sitting visits. */
export function PortalVisitReport({ report: r, facts = [], details = [], photoLabel = "Visit" }: {
  report: PortalVisitReportFields;
  facts?: string[];
  details?: string[];
  photoLabel?: string;
}) {
  const times = r.startTime && r.endTime ? `${r.startTime} to ${r.endTime}` : (r.startTime ?? r.endTime ?? null);
  const lines = [...facts, times, r.durationMin != null ? `${r.durationMin} min` : null].filter(Boolean);
  return <div className="space-y-2 text-sm">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className="min-w-0 break-words font-medium">{fmtDay(r.day)}</span>
      {r.serviceName && <span className="min-w-0 break-words text-xs text-muted-foreground">{r.serviceName}</span>}
    </div>
    {lines.length > 0 && <p className="break-words text-xs text-muted-foreground">{lines.join(" · ")}</p>}
    {details.length > 0 && <p className="break-words">{details.join(" · ")}</p>}
    {r.reportNote && <p className="whitespace-pre-line break-words rounded bg-muted/50 p-2">{r.reportNote}</p>}
    {r.photos.length > 0 && <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {r.photos.map((p, i) => <li key={p.url} className="min-w-0">
        <a href={p.url} target="_blank" rel="noreferrer" className="block min-h-11">
          <img src={p.url} alt={`${photoLabel} photo ${i + 1} from ${fmtDay(r.day)}`} className="aspect-square w-full rounded object-cover" loading="lazy" />
        </a>
      </li>)}
    </ul>}
  </div>;
}
