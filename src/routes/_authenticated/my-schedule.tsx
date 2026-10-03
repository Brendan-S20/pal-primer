import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarDays, MapPin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getMyUpcomingDays, type UpcomingDay } from "@/lib/my-day.functions";
import { orgLocalTime } from "@/lib/org-day";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { APP_NAME } from "@/lib/scoop";
import { useIntlLocale } from "@/lib/i18n";

/**
 * A technician's own next two weeks.
 *
 * ── WHY THIS EXISTS RATHER THAN /routes ─────────────────────────────────
 *
 * A tech with an empty day was offered one action — "View schedule" — and it
 * went to /routes, which ROUTE_ROLES does not grant them. RoleGuard bounced
 * them straight back to /my-day with a red "You don't have access to that
 * page." The only button on the screen was a dead end for the only role the
 * screen is for.
 *
 * Granting /routes would have been the wrong fix. That page is the dispatch
 * board: it shows everyone's work and exists to move it between people. A
 * technician checking whether they are on Thursday does not need a control
 * that reassigns somebody else's stops.
 *
 * ── WHAT "HOW MANY ROUTES" TURNED OUT TO MEAN ───────────────────────────
 *
 * Nothing, literally. There is no routes table in this database, and no
 * shifts table: a route is a technician plus a date, and the visits carrying
 * that pair. So a day here is counted in the things a route is made of —
 * stops, how many are already behind you, the zones it touches, and when the
 * first and last are due. A day with nothing assigned is not a working day
 * and is simply absent, which is the honest reading of "which days they
 * work" from the only data that knows it.
 */
export const Route = createFileRoute("/_authenticated/my-schedule")({
  head: () => ({ meta: [{ title: `My schedule - ${APP_NAME}` }] }),
  component: MySchedulePage,
});

// `locale` is the interface language's (lib/i18n `intlLocaleFor`); English
// passes none and keeps the device's, as it always did.
const fmtDay = (iso: string, locale: string | undefined) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

function MySchedulePage() {
  const { t } = useTranslation();
  const locale = useIntlLocale();
  const tz = useOrgTimezone();
  const fn = useServerFn(getMyUpcomingDays);
  const { data, isLoading } = useQuery({
    queryKey: ["my-upcoming-days"],
    queryFn: () => fn({ data: {} }),
  });

  const days = (data?.days ?? []) as UpcomingDay[];
  // The org's today, not the device's: the "Today" badge below has to sit on
  // the same row the ETAs (already on the org clock) and My Day's default day
  // call today, or a phone in another timezone badges the wrong morning.
  const todayISO = useOrgToday();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold tracking-tight md:text-xl md:font-semibold">
          {t("nav.item.my-schedule")}
        </h1>
        <p className="text-xs text-muted-foreground">{t("schedule.subtitle")}</p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">{t("schedule.loading")}</p>}

      {!isLoading && days.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          <CalendarDays className="mx-auto mb-3 h-8 w-8 opacity-60 shrink-0" />
          <p>{t("schedule.empty")}</p>
          <p className="mt-1 text-xs">{t("schedule.emptyHint")}</p>
        </div>
      )}

      {/* Named, so a screen reader announces what the list is and so a test can
          address these rows without also catching the mobile tab bar's, which
          are also <li><a> and sit in the same document. In Spanish the name
          is Spanish too: "Tus próximos días". */}
      <ul aria-label={t("schedule.listLabel")} className="space-y-2">
        {days.map((d) => {
          const left = d.stops - d.done;
          const first = orgLocalTime(d.firstEta, tz, locale) || null;
          const last = orgLocalTime(d.lastEta, tz, locale) || null;
          return (
            <li key={d.date}>
              {/* The whole row is the link. A tech reading "Thursday, 6 stops"
                  and wanting the detail should not have to find a chevron. */}
              <Link
                to="/my-day"
                search={{ date: d.date === todayISO ? undefined : d.date } as any}
                className="flex min-h-16 items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted active:bg-muted"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-semibold">{fmtDay(d.date, locale)}</span>
                    {d.date === todayISO && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-primary">
                        {t("nav.today")}
                      </span>
                    )}
                  </div>
                  {/* min-w-0 + truncate: a day touching four zones with long
                      names is the row most likely to widen and push the count
                      off the side of a 360px screen. */}
                  {d.zones.length > 0 && (
                    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <bdi className="truncate">{d.zones.join(", ")}</bdi>
                    </div>
                  )}
                  {first && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {first}
                      {last ? ` – ${last}` : ""}
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-end">
                  <div className="text-lg font-semibold leading-none tabular-nums">{d.stops}</div>
                  <div className="text-3xs uppercase tracking-wide text-muted-foreground">
                    {t("schedule.stops", { count: d.stops })}
                  </div>
                  {/* Only when it says something. "0 done" on a day that has
                      not started is noise on every future row in the list. */}
                  {d.done > 0 && (
                    <div className="mt-1 text-3xs text-muted-foreground">
                      {left === 0 ? t("schedule.allDone") : t("schedule.left", { count: left })}
                    </div>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
