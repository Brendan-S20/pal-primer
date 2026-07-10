import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Bell } from "lucide-react";
import {
  listMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
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
  const listFn = useServerFn(listMyNotifications);
  const markFn = useServerFn(markNotificationRead);
  const markAllFn = useServerFn(markAllNotificationsRead);

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

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-md border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-medium">Notifications</span>
              {unread > 0 && (
                <button className="text-xs text-primary hover:underline" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
                  Mark all read
                </button>
              )}
            </div>
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
                            <div className="mt-0.5 text-[10px] text-muted-foreground">{timeAgo(n.created_at)}</div>
                          </div>
                        </div>
                      </div>
                    );
                    const onClick = () => { if (!n.read_at) markOne.mutate(n.id); setOpen(false); };
                    return (
                      <li key={n.id}>
                        {n.link ? (
                          <a href={n.link} onClick={onClick} className="block hover:bg-muted">{inner}</a>
                        ) : (
                          <button type="button" onClick={onClick} className="block w-full text-left hover:bg-muted">{inner}</button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
