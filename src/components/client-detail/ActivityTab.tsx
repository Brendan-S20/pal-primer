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
import { listClientActivity } from "@/lib/activity.functions";

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
    <div className="rounded-lg border bg-card p-5">
      <ol className="relative space-y-4 border-l pl-5">
        {entries.map((e: any) => {
          const Icon = iconFor(e.kind ?? "");
          return (
            <li key={e.id} className="relative">
              <span className="absolute -left-[27px] flex h-4 w-4 items-center justify-center rounded-full border bg-background">
                <Icon className="h-2.5 w-2.5 text-muted-foreground" />
              </span>
              <div className="text-sm">{e.summary}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {new Date(e.created_at).toLocaleString()}
                {e.actor_label ? ` · ${e.actor_label}` : ""}
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
