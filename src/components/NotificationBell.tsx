import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Bell, Settings, X } from "lucide-react";
import {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getNotificationPrefs,
  setNotificationPrefs,
} from "@/lib/notifications-center.functions";

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const listFn = useServerFn(listMyNotifications);
  const markFn = useServerFn(markNotificationRead);
  const markAllFn = useServerFn(markAllNotificationsRead);
  const deleteFn = useServerFn(deleteNotification);

  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => listFn(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const data = q.data as any;
  const unread: number = data?.unread ?? 0;
  const items: any[] = data?.notifications ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const markAll = useMutation({ mutationFn: () => markAllFn(), onSuccess: invalidate });
  const markOne = useMutation({ mutationFn: (id: string) => markFn({ data: { id } }), onSuccess: invalidate });
  const deleteOne = useMutation({ mutationFn: (id: string) => deleteFn({ data: { id } }), onSuccess: invalidate });

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground max-md:p-2.5"
      >
        <Bell className="h-4 w-4 max-md:h-5 max-md:w-5" />
        {unread > 0 && (
          <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-3xs font-semibold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Below `md` the panel pins to the viewport edges (the absolute w-80
              box overflows ≤360px screens); md+ keeps the header popover. */}
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-md border bg-card shadow-lg max-md:fixed max-md:inset-x-3 max-md:top-16 max-md:mt-0 max-md:w-auto">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-medium">{showPrefs ? "Notification settings" : "Notifications"}</span>
              <div className="flex items-center gap-3">
                {!showPrefs && unread > 0 && (
                  <button className="text-xs text-primary hover:underline" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
                    Mark all read
                  </button>
                )}
                <button className="text-muted-foreground hover:text-foreground" aria-label="Notification settings" onClick={() => setShowPrefs((v) => !v)}>
                  <Settings className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {showPrefs ? (
              <NotificationPrefs />
            ) : (
            <div className="max-h-96 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">You're all caught up.</p>
              ) : (
                <ul className="divide-y">
                  {items.map((n) => {
                    const inner = (
                      <div className={`px-3 py-2.5 ${n.read_at ? "" : "bg-primary/5"}`}>
                        <div className="flex items-start gap-2">
                          {!n.read_at && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                          <div className="min-w-0">
                            <div className="text-sm font-medium">{n.title}</div>
                            {n.body && <div className="truncate text-xs text-muted-foreground">{n.body}</div>}
                            <div className="mt-0.5 text-3xs text-muted-foreground">{timeAgo(n.created_at)}</div>
                          </div>
                        </div>
                      </div>
                    );
                    const onClick = () => { if (!n.read_at) markOne.mutate(n.id); setOpen(false); };
                    return (
                      <li key={n.id} className="group relative">
                        {n.link ? (
                          <a href={n.link} onClick={onClick} className="block hover:bg-muted">{inner}</a>
                        ) : (
                          <button type="button" onClick={onClick} className="block w-full text-left hover:bg-muted">{inner}</button>
                        )}
                        <button
                          type="button"
                          aria-label="Delete notification"
                          title="Delete"
                          onClick={(e) => { e.stopPropagation(); deleteOne.mutate(n.id); }}
                          disabled={deleteOne.isPending}
                          // Hover-only visibility is unreachable on touch: below
                          // `md` the delete stays visible at reduced opacity
                          // (and on focus for keyboard users).
                          className="absolute right-2 top-2 hidden rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground group-hover:block group-focus-within:block max-md:block max-md:p-1.5 max-md:opacity-60"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex items-center justify-between border-t px-3 py-1.5">
                <Link
                  to="/notifications"
                  onClick={() => setOpen(false)}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  View all
                </Link>
                <span className="text-3xs text-muted-foreground">Kept for 30 days</span>
              </div>
            </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function NotificationPrefs() {
  const qc = useQueryClient();
  const getFn = useServerFn(getNotificationPrefs);
  const setFn = useServerFn(setNotificationPrefs);
  const q = useQuery({ queryKey: ["notification-prefs"], queryFn: () => getFn() });
  const data = q.data as any;
  const muted: string[] = data?.mutedTypes ?? [];
  const types: Array<{ type: string; label: string }> = data?.types ?? [];

  const save = useMutation({
    mutationFn: (next: string[]) => setFn({ data: { mutedTypes: next } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-prefs"] }),
  });

  const toggle = (t: string, on: boolean) => {
    const next = on ? muted.filter((m) => m !== t) : Array.from(new Set([...muted, t]));
    save.mutate(next);
  };

  if (q.isLoading) return <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>;
  return (
    <div className="max-h-96 overflow-y-auto p-3">
      <p className="mb-2 text-xs text-muted-foreground">Choose what shows up here.</p>
      <ul className="space-y-2">
        {types.map((t) => {
          const on = !muted.includes(t.type);
          return (
            <li key={t.type} className="flex items-center justify-between text-sm">
              <span>{t.label}</span>
              <input type="checkbox" checked={on} disabled={save.isPending} onChange={(e) => toggle(t.type, e.target.checked)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
