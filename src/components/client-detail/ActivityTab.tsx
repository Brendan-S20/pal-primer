// Activity tab: the unified audit timeline (activity_log). Every meaningful
// change lands here — client edits, property/boundary/zone changes, service
// lifecycle, notes, overrides.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  Clock,
  Dog,
  FileText,
  Home,
  MapPin,
  StickyNote,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { listClientActivity } from "@/lib/activity.functions";
import { activityChanges } from "@/lib/activity-diff";

function iconFor(kind: string) {
  if (kind.startsWith("client.")) return User;
  if (kind.startsWith("property.")) return Home;
  if (kind.startsWith("zone.")) return MapPin;
  if (kind.startsWith("estimate.")) return Clock;
  if (kind.startsWith("service.")) return FileText;
  if (kind.startsWith("note.")) return StickyNote;
  if (kind.startsWith("dog.")) return Dog;
  return Activity;
}

export function ActivityTab({ clientId }: { clientId: string }) {
  const listFn = useServerFn(listClientActivity);
  const [limit, setLimit] = useState(50);
  const { data, isLoading } = useQuery({
    queryKey: ["client-activity", clientId, limit],
    queryFn: () => listFn({ data: { clientId, limit } }),
  });
  const entries = data?.entries ?? [];

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  if (entries.length === 0)
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No activity recorded yet. Changes to this client, their properties, and their services will
        appear here.
      </div>
    );

  return (
    <div className="rounded-lg border bg-card shadow-sm p-5">
      <ol className="relative space-y-4 border-l pl-5">
        {entries.map((e: any) => {
          const Icon = iconFor(e.kind ?? "");
          const changes = activityChanges(e.meta, e.kind);
          return (
            <li key={e.id} className="relative">
              <span className="absolute -left-[27px] flex h-4 w-4 items-center justify-center rounded-full border bg-background">
                <Icon className="h-2.5 w-2.5 text-muted-foreground" />
              </span>
              <div className="text-sm">{e.summary}</div>

              {/* The diff the writer has always recorded. A native <details>
                  rather than a hover reveal or a click handler: it opens on
                  touch and from the keyboard, and fifty entries expanded at
                  once would bury the timeline they belong to. */}
              {changes.length > 0 && (
                <details className="mt-1 text-xs">
                  <summary className="inline-flex cursor-pointer list-none items-center text-muted-foreground underline-offset-4 hover:underline touch:min-h-11">
                    {changes.length === 1
                      ? "What changed"
                      : `What changed · ${changes.length} fields`}
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {changes.map((c) => (
                      <li key={c.field} className="flex flex-wrap gap-x-1.5">
                        <span className="text-muted-foreground">{c.label}</span>
                        {/* min-w-0 so a long value wraps inside the row rather
                            than widening the timeline past the viewport. */}
                        <span className="min-w-0 break-words line-through opacity-60">
                          {c.before}
                        </span>
                        <span className="min-w-0 break-words font-medium">{c.after}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span>
                  {formatDateTime(e.created_at)}
                  {e.actor_label ? ` · ${e.actor_label}` : ""}
                </span>
                {e.meta?.impersonation ? (
                  <span
                    className="rounded border border-amber-300 bg-amber-50 px-1.5 py-px text-3xs font-medium text-amber-700"
                    title="This action was taken by a platform admin impersonating the user. Details are in the platform audit log."
                  >
                    Platform-admin impersonation
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {entries.length >= limit && (
        <div className="mt-4 text-center">
          <Button variant="outline" size="sm" onClick={() => setLimit((l) => Math.min(l + 50, 200))}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
