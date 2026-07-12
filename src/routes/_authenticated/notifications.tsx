import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { X } from "lucide-react";
import {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from "@/lib/notifications-center.functions";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/notifications")({
  component: NotificationsPage,
});

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function NotificationsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "unread">("all");
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            Recent activity. Notifications are automatically deleted after 30 days.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md border text-sm">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`px-3 py-1.5 ${filter === "all" ? "bg-muted font-medium" : ""}`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setFilter("unread")}
              className={`border-l px-3 py-1.5 ${filter === "unread" ? "bg-muted font-medium" : ""}`}
            >
              Unread {unread > 0 && <span className="ml-1 text-xs text-muted-foreground">({unread})</span>}
            </button>
          </div>
          {unread > 0 && (
            <Button size="sm" variant="outline" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
              Mark all read
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border bg-card">
        {q.isLoading ? (
          <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {filter === "unread" ? "No unread notifications." : "You're all caught up."}
          </p>
        ) : (
          <ul className="divide-y">
            {shown.map((n) => {
              const inner = (
                <div className={`flex items-start gap-3 px-4 py-3 ${n.read_at ? "" : "bg-primary/5"}`}>
                  {!n.read_at && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{n.title}</div>
                    {n.body && <div className="text-sm text-muted-foreground">{n.body}</div>}
                    <div className="mt-1 text-xs text-muted-foreground">{timeAgo(n.created_at)}</div>
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
                  <div className="absolute right-3 top-3 hidden gap-1 group-hover:flex">
                    {!n.read_at && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); markOne.mutate(n.id); }}
                        disabled={markOne.isPending}
                        className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                      >
                        Mark read
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Delete notification"
                      title="Delete"
                      onClick={(e) => { e.stopPropagation(); deleteOne.mutate(n.id); }}
                      disabled={deleteOne.isPending}
                      className="rounded p-1 text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
