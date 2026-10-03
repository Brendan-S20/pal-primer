import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Settings, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from "@/lib/notifications-center.functions";
import { Button } from "@/components/ui/button";
import { NotificationPrefs } from "@/components/NotificationPrefs";
import { cacheAgeParts } from "@/lib/offline/read-cache-policy";
import { pageTitle, titleHead, useDocumentTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/notifications")({
  head: () => titleHead("Alerts"),
  component: NotificationsPage,
});

/** "12 min ago" / "hace 12 min": the same buckets and words My Day uses for
 *  its saved copy (cacheAgeParts). Clamped at zero first, so a notification
 *  stamped a moment ahead of a phone's clock reads "just now" — as it always
 *  did here — rather than cacheAgeParts' "at an unknown time", which is the
 *  right answer for a cache and the wrong one for something that just arrived. */
function timeAgo(iso: string, t: TFunction): string {
  const age = cacheAgeParts(Math.max(0, Date.now() - new Date(iso).getTime()));
  if (age.unit === "unknown" || age.unit === "now") return t(`cacheAge.${age.unit}`);
  return t(`cacheAge.${age.unit}`, { count: age.count });
}

function NotificationsPage() {
  const { t } = useTranslation();
  // In the language this device reads. The route's head is English because
  // it runs before i18n has read the device's choice.
  useDocumentTitle(pageTitle(t("nav.alerts")));
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  // The gear used to live in the header bell's dropdown. The bell is a link
  // now, so this page owns the only way to reach notification settings.
  const [showPrefs, setShowPrefs] = useState(false);
  const listFn = useServerFn(listMyNotifications);
  const markFn = useServerFn(markNotificationRead);
  const markAllFn = useServerFn(markAllNotificationsRead);
  const deleteFn = useServerFn(deleteNotification);

  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => listFn(),
    refetchOnWindowFocus: true,
  });
  const data = q.data as any;
  const items: any[] = data?.notifications ?? [];
  const unread: number = data?.unread ?? 0;
  const shown = filter === "unread" ? items.filter((n) => !n.read_at) : items;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const markAll = useMutation({ mutationFn: () => markAllFn(), onSuccess: invalidate });
  const markOne = useMutation({ mutationFn: (id: string) => markFn({ data: { id } }), onSuccess: invalidate });
  const deleteOne = useMutation({ mutationFn: (id: string) => deleteFn({ data: { id } }), onSuccess: invalidate });

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {/* "Alerts", because that is the word on the tab that opens this
              page. The tech tab bar has room for one short word and "Alerts"
              is it, so the page adopts the tab's name rather than greeting the
              person with a different one than the button they just pressed. */}
          <h1 className="text-2xl font-bold tracking-tight md:text-xl md:font-semibold">
            {t("nav.alerts")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("alerts.subtitle")}</p>
        </div>
        {/* `flex-wrap`, because at 320px this row is a filter pair, a Mark
            all read and a Settings — 349px of controls in a 320px viewport,
            measured. Without it the last button runs off the side. */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border p-0.5 text-sm"
            role="group"
            aria-label={t("alerts.show")}
          >
            <button
              type="button"
              onClick={() => setFilter("all")}
              // MEASURED 2026-08-19: 32.0px, both halves of the filter pair.
              aria-pressed={filter === "all"}
              className={`rounded-md px-3 py-1.5 font-medium touch:min-h-11 ${filter === "all" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              {t("alerts.all")}
            </button>
            <button
              type="button"
              onClick={() => setFilter("unread")}
              aria-pressed={filter === "unread"}
              className={`rounded-md px-3 py-1.5 font-medium touch:min-h-11 ${filter === "unread" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
            >
              {t("alerts.unread")}{" "}
              {unread > 0 && <span className="ml-1 text-xs opacity-80">({unread})</span>}
            </button>
          </div>
          {unread > 0 && (
            <Button size="sm" variant="outline" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
              {t("alerts.markAllRead")}
            </Button>
          )}
          <Button
            size="sm"
            variant={showPrefs ? "default" : "outline"}
            onClick={() => setShowPrefs((v) => !v)}
            aria-expanded={showPrefs}
            aria-label={t("alerts.settings")}
            // `touch:min-h-11` for the same reason as the filter pair beside
            // it: `size="sm"` is a 32px box, which is legal with a mouse and
            // not with a thumb.
            className="touch:min-h-11"
          >
            {/* The word is dropped on the narrowest screens, not the button.
                A labelled control that is off the side of the page is worth
                less than an icon that is on it; `aria-label` keeps it named
                for anyone not reading pixels. */}
            <Settings className="h-4 w-4 sm:mr-1 shrink-0" />
            <span className="max-sm:sr-only">{t("alerts.settingsShort")}</span>
          </Button>
        </div>
      </div>

      {showPrefs && (
        <div className="rounded-md border bg-card p-4">
          <h2 className="text-sm font-medium">{t("alerts.settings")}</h2>
          <div className="mt-2">
            <NotificationPrefs />
          </div>
        </div>
      )}

      <div className="rounded-md border bg-card">
        {q.isLoading ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : shown.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {filter === "unread" ? t("alerts.noUnread") : t("alerts.caughtUp")}
          </p>
        ) : (
          <ul className="divide-y">
            {shown.map((n) => {
              const inner = (
                <div className={`flex items-start gap-3 px-4 py-3 ${n.read_at ? "" : "bg-primary/5"}`}>
                  {!n.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  {/* Room for the delete button, which is always visible on
                      touch rather than revealed on hover — see below. Without
                      the reserved gutter it lands on top of the title. */}
                  {/* The title and body are written by the server, in
                      English, when the event happens; they are stored text,
                      not chrome, and stay as they were written. */}
                  <div className="min-w-0 flex-1 touch:pr-11">
                    <div className="text-sm font-medium">{n.title}</div>
                    {n.body && <div className="text-sm text-muted-foreground">{n.body}</div>}
                    <div className="mt-1 text-xs text-muted-foreground">
                      {timeAgo(n.created_at, t)}
                    </div>
                  </div>
                </div>
              );
              const onClick = () => { if (!n.read_at) markOne.mutate(n.id); };
              return (
                <li key={n.id} className="group relative">
                  {n.link ? (
                    <a href={n.link} onClick={onClick} className="block hover:bg-muted">{inner}</a>
                  ) : (
                    <button type="button" onClick={onClick} className="block w-full text-left hover:bg-muted">{inner}</button>
                  )}
                  {/* `hidden group-hover:flex` alone made deleting a
                      notification impossible on a phone: hover does not exist
                      on touch, so the row's only destructive control never
                      appeared.

                      `max-md:flex` was the fix, and it was half a fix. It
                      keyed on WIDTH, and the thing that is missing is not
                      width, it is HOVER. Tailwind 4 compiles every `hover:`
                      and `group-hover:` rule inside `@media (hover:hover)` —
                      verified in the built stylesheet — so on any touch
                      device the reveal simply never fires. Below 768px the
                      width escape covered that. On an iPad it does not: no
                      hover, and no `max-md` either, so this control was
                      invisible and unreachable on EVERY iPad, at every size,
                      in both orientations.

                      `touch:flex` is the honest condition — shown
                      wherever the primary input is a finger, whatever the
                      screen is doing. `max-md:flex` stays beside it because
                      the two answer different questions and a narrow window
                      on a laptop is still a narrow window.

                      "Mark read" is dropped on touch rather than enlarged.
                      Tapping the row already marks it read, so it would be a
                      second button doing the same thing, sitting on top of the
                      title it duplicates. `group-focus-within` covers the
                      keyboard, which had the same problem for the same reason. */}
                  <div className="absolute right-3 top-3 hidden gap-1 group-hover:flex group-focus-within:flex touch:flex">
                    {!n.read_at && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); markOne.mutate(n.id); }}
                        disabled={markOne.isPending}
                        className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground touch:hidden"
                      >
                        {t("alerts.markRead")}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={t("alerts.delete")}
                      title={t("common.delete")}
                      onClick={(e) => { e.stopPropagation(); deleteOne.mutate(n.id); }}
                      disabled={deleteOne.isPending}
                      // `p-1` is a 24px target around a 16px glyph. The `touch:p-3.5` pair
                      // grows it to 44 on a phone; `touch:` does the same
                      // wherever the input is a finger, which is the actual condition —
                      // on an iPad this was a 24px destructive control.
                      className="rounded p-1 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground touch:-mr-1.5 touch:-mt-1.5 touch:p-3.5 touch:opacity-60 touch:-mr-1.5 touch:-mt-1.5 touch:p-3.5 touch:opacity-60"
                    >
                      <X className="h-4 w-4 shrink-0" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
