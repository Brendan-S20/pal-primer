import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X, Info, AlertTriangle, AlertOctagon, CheckCircle2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  listActiveAnnouncements,
  dismissAnnouncement,
  type ActiveAnnouncement,
} from "@/lib/announcements-viewer.functions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SEV_STYLE: Record<string, { wrap: string; icon: ReactNode }> = {
  info: {
    wrap: "border-blue-500/30 bg-blue-500/10 text-blue-900 dark:text-blue-100",
    icon: <Info className="h-4 w-4 shrink-0" />,
  },
  success: {
    wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100",
    icon: <CheckCircle2 className="h-4 w-4 shrink-0" />,
  },
  warning: {
    wrap: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100",
    icon: <AlertTriangle className="h-4 w-4 shrink-0" />,
  },
  critical: {
    wrap: "border-destructive/50 bg-destructive/10 text-destructive",
    icon: <AlertOctagon className="h-4 w-4 shrink-0" />,
  },
};

export function AnnouncementBanner() {
  const qc = useQueryClient();
  const listFn = useServerFn(listActiveAnnouncements);
  const dismissFn = useServerFn(dismissAnnouncement);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const q = useQuery({
    queryKey: ["announcements", "active"],
    queryFn: () => listFn(),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissFn({ data: { id } }),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ["announcements", "active"] });
      const prev = qc.getQueryData<{ rows: ActiveAnnouncement[] }>(["announcements", "active"]);
      qc.setQueryData<{ rows: ActiveAnnouncement[] }>(["announcements", "active"], (old) => ({
        rows: (old?.rows ?? []).filter((r) => r.id !== id),
      }));
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["announcements", "active"], ctx.prev);
    },
  });

  const rows = q.data?.rows ?? [];
  if (!rows.length) return null;

  return (
    <div className="flex flex-col gap-2 px-4 pt-3 sm:px-6">
      {rows.map((r) => {
        const style = SEV_STYLE[r.severity] ?? SEV_STYLE.info;
        const isLong = r.body.length > 140;
        const open = expanded[r.id];
        return (
          <div
            key={r.id}
            className={cn(
              "flex items-start gap-3 rounded-lg border px-3 py-2 text-sm shadow-sm",
              style.wrap,
            )}
            role="status"
          >
            <div className="mt-0.5">{style.icon}</div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{r.title}</div>
              <div className={cn("whitespace-pre-wrap text-sm/5 opacity-90", !open && isLong && "line-clamp-2")}>
                {r.body}
              </div>
              {isLong && (
                <button
                  type="button"
                  onClick={() => setExpanded((m) => ({ ...m, [r.id]: !open }))}
                  className="mt-1 text-xs font-medium underline underline-offset-2 opacity-80 hover:opacity-100"
                >
                  {open ? "Show less" : "Show more"}
                </button>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-current hover:bg-black/5 dark:hover:bg-white/10"
              aria-label="Dismiss"
              onClick={() => dismiss.mutate(r.id)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
