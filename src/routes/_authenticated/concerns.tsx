import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  listConcerns,
  updateConcernStatus,
  CONCERN_CATEGORY_LABELS,
  type ConcernStatus,
} from "@/lib/concerns.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/concerns")({
  component: ConcernsPage,
});

const FILTERS: Array<{ key: "all" | ConcernStatus; label: string }> = [
  { key: "open", label: "Received" },
  { key: "in_progress", label: "In progress" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

const STATUS_LABEL: Record<ConcernStatus, string> = {
  open: "Received",
  in_progress: "In progress",
  resolved: "Resolved",
};

function fmt(d: string) {
  return new Date(d).toLocaleString();
}

function ConcernsPage() {
  const [filter, setFilter] = useState<"all" | ConcernStatus>("open");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const listFn = useServerFn(listConcerns);
  const updateFn = useServerFn(updateConcernStatus);

  const q = useQuery({
    queryKey: ["concerns", filter],
    queryFn: () => listFn({ data: { status: filter } }),
  });

  const mut = useMutation({
    mutationFn: (v: { ticketId: string; status: ConcernStatus; resolutionNote?: string }) =>
      updateFn({ data: v }),
    onSuccess: () => {
      toast.success("Concern updated");
      qc.invalidateQueries({ queryKey: ["concerns"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const concerns: any[] = (q.data as any)?.concerns ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Concerns</h1>
        <p className="text-sm text-muted-foreground">
          Issues clients submit from their portal ("Report a concern"). Triage and resolve them here.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-sm ${filter === f.key ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : concerns.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          No concerns {filter === "all" ? "yet" : `in "${filter === "open" ? "Received" : STATUS_LABEL[filter as ConcernStatus]}"`}.
        </p>
      ) : (
        <ul className="space-y-3">
          {concerns.map((c) => {
            const status = c.status as ConcernStatus;
            const client = Array.isArray(c.clients) ? c.clients[0] : c.clients;
            return (
              <li key={c.id} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{client?.display_name ?? "Client"}</span>
                      <Badge variant="outline">{CONCERN_CATEGORY_LABELS[c.category] ?? c.category}</Badge>
                      <Badge variant={status === "resolved" ? "secondary" : status === "in_progress" ? "default" : "destructive"}>
                        {STATUS_LABEL[status]}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Submitted {fmt(c.created_at)}
                      {client?.primary_phone ? ` · ${client.primary_phone}` : ""}
                      {client?.primary_email ? ` · ${client.primary_email}` : ""}
                    </div>
                  </div>
                </div>
                {c.message && <p className="mt-2 whitespace-pre-wrap text-sm">{c.message}</p>}

                {status === "resolved" ? (
                  <div className="mt-3 text-xs text-muted-foreground">
                    Resolved {c.resolved_at ? fmt(c.resolved_at) : ""}
                    {c.resolution_note ? ` — ${c.resolution_note}` : ""}
                    <button
                      className="ml-2 text-primary underline underline-offset-2"
                      onClick={() => mut.mutate({ ticketId: c.id, status: "in_progress" })}
                    >
                      Reopen
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    <Textarea
                      rows={2}
                      placeholder="Resolution note (optional) — what was done"
                      value={notes[c.id] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      {status === "open" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={mut.isPending}
                          onClick={() => mut.mutate({ ticketId: c.id, status: "in_progress" })}
                        >
                          Mark in progress
                        </Button>
                      )}
                      <Button
                        size="sm"
                        disabled={mut.isPending}
                        onClick={() =>
                          mut.mutate({ ticketId: c.id, status: "resolved", resolutionNote: notes[c.id] })
                        }
                      >
                        Mark resolved
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
