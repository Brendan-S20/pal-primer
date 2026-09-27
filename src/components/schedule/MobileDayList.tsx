// Mobile Phase 2: the phone-sized schedule for office roles. The dnd-kit
// dispatch board is touch-hostile and can't fit a phone, so below `md` the
// Board view renders this instead — an ordered read-only day list grouped by
// tech.
//
// This header used to say the drawer's "reassign / reschedule / cancel /
// complete" controls were the mobile way to dispatch. Three of those four do
// not exist in VisitDetailDrawer and never did: it has no staff picker and no
// date field, and its complete/skip buttons called the tech-scoped RPCs, which
// reject every office user who can open it. The footer note below repeated the
// same promise to the user.
//
// So what mobile dispatch actually is today: observe the day, tap through for
// address / gate codes / hazards / dogs, and complete or cancel a visit if you
// hold manage_client_billing. Moving a visit between techs and moving it to
// another day are desktop-only. Q-12 is how much of that should change.
import { useMemo } from "react";
import { ChevronRight, CloudRain } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { orgLocalTime } from "@/lib/org-day";
import { useOrgTimezone } from "@/hooks/useOrgToday";

type Visit = any;
type Staff = any;

/** "HH:MM[:SS]" wall-clock → "8:00 AM". */
function fmtWindowTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

/** Best time label for a row: computed ETA if the route was optimized, else
 *  the configured service window (service first, legacy property fallback —
 *  same precedence as the board's VisitCardView). ETAs are instants and render
 *  on the ORG's clock; the windows below are `time` columns — wall clock with
 *  no zone — and stay as they are. */
function timeLabel(v: Visit, tz: string): string | null {
  if (v?.eta_start) {
    const start = orgLocalTime(v.eta_start, tz);
    const end = v?.eta_end ? orgLocalTime(v.eta_end, tz) : "";
    if (start) return end ? `ETA ${start}–${end}` : `ETA ${start}`;
  }
  const sub = v?.subscriptions;
  const p = v?.properties;
  const useSub = !!(sub?.earliest_time || sub?.latest_time);
  const s = (useSub ? sub?.earliest_time : p?.earliest_service_time) as string | undefined;
  const e = (useSub ? sub?.latest_time : p?.latest_service_time) as string | undefined;
  const early = s ? fmtWindowTime(s) : "";
  const late = e ? fmtWindowTime(e) : "";
  if (early && late) return `Window ${early}–${late}`;
  if (early) return `After ${early}`;
  if (late) return `By ${late}`;
  return null;
}

const STATUS_CHIP: Record<string, string> = {
  scheduled: "bg-muted text-muted-foreground",
  in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  skipped: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  canceled: "bg-destructive/15 text-destructive",
};

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-3xs font-medium ${STATUS_CHIP[status] ?? "bg-muted"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function MobileDayList({
  visits,
  staff,
  onOpen,
}: {
  visits: Visit[];
  staff: Staff[];
  onOpen: (visitId: string) => void;
}) {
  const tz = useOrgTimezone();
  const groups = useMemo(() => {
    const byTech = new Map<string | null, Visit[]>();
    for (const v of visits) {
      const key = (v.assigned_staff_id as string | null) ?? null;
      const arr = byTech.get(key);
      if (arr) arr.push(v);
      else byTech.set(key, [v]);
    }
    const bySeq = (a: Visit, b: Visit) => (a.sequence ?? 9999) - (b.sequence ?? 9999);
    const out: Array<{ key: string; name: string; unassigned?: boolean; items: Visit[] }> = [];
    const un = byTech.get(null);
    if (un?.length) {
      out.push({
        key: "__unassigned__",
        name: "Unassigned",
        unassigned: true,
        items: [...un].sort(bySeq),
      });
    }
    for (const s of staff) {
      const items = byTech.get(s.id);
      if (items?.length)
        out.push({ key: s.id, name: s.display_name ?? "Tech", items: [...items].sort(bySeq) });
    }
    return out;
  }, [visits, staff]);

  if (visits.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
        No visits scheduled for this day.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <section key={g.key} className="overflow-hidden rounded-lg border bg-card">
          <header className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
            <span
              className={`truncate text-sm font-medium ${
                g.unassigned ? "text-amber-700 dark:text-amber-400" : ""
              }`}
            >
              {g.name}
            </span>
            <Badge variant="secondary">{g.items.length}</Badge>
          </header>
          <ol className="divide-y">
            {g.items.map((v, i) => {
              const p = v.properties;
              const t = timeLabel(v, tz);
              return (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(v.id)}
                    className="flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">#{v.sequence ?? i + 1}</span>
                        {t && <span className="font-medium text-foreground">{t}</span>}
                      </div>
                      <div className="truncate text-sm font-semibold">
                        {v.clients?.display_name ?? "-"}
                      </div>
                      {p && (
                        <div className="truncate text-xs text-muted-foreground">
                          {p.street}
                          {p.city ? `, ${p.city}` : ""}
                          {p.postal_code ? ` ${p.postal_code}` : ""}
                        </div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <StatusChip status={v.status} />
                        {v.zones?.name && (
                          <Badge variant="outline" className="h-4 px-1 text-3xs">
                            {v.zones.name}
                          </Badge>
                        )}
                        {v.window_violated && (
                          <Badge variant="destructive" className="h-4 px-1 text-3xs">
                            Late
                          </Badge>
                        )}
                        {v.weather_flagged && (
                          <Badge
                            variant="destructive"
                            className="h-4 gap-0.5 px-1 text-3xs"
                            title={v.weather_note ?? "Weather risk"}
                          >
                            <CloudRain className="h-2.5 w-2.5 shrink-0" />
                            {v.weather_note ? String(v.weather_note).split(",")[0] : "Weather"}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      <p className="text-2xs text-muted-foreground">
        Tap a visit for details, and to complete or cancel it. Moving a visit to another tech or
        another day is on desktop.
      </p>
    </div>
  );
}
