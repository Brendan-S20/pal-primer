import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarOff, Inbox, Repeat } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  listConcerns,
  updateConcernStatus,
  replyToConcern,
  CONCERN_CATEGORY_LABELS,
  type ConcernStatus,
} from "@/lib/concerns.functions";
import { parseHoldRequest } from "@/lib/hold-request";
import { parseFrequencyRequest, frequencyLabel } from "@/lib/frequency-request";
import { applyFrequencyChangeRequest } from "@/lib/subscriptions.functions";
import { ConfirmButton } from "@/components/ConfirmButton";
import { VacationHoldDrawer } from "@/components/client-detail/VacationHoldDrawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDay } from "@/lib/format";
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
  const [replies, setReplies] = useState<Record<string, string>>({});
  // The reply / resolution textareas are collapsed behind an action by default
  // (D polish) — a card shows buttons, and the box appears when you act.
  const [openReply, setOpenReply] = useState<Set<string>>(new Set());
  const [openResolve, setOpenResolve] = useState<Set<string>>(new Set());
  const toggle = (setter: typeof setOpenReply, id: string) =>
    setter((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // The concern we're placing a hold for (C4/G4): opens the shared hold drawer
  // prefilled from the parsed request, then resolves the concern on success.
  const [holdFor, setHoldFor] = useState<{
    ticketId: string;
    clientId: string;
    startsOn: string;
    endsOn: string;
    reason: string;
  } | null>(null);
  // Concerns that have already had a hold placed this session. Guards against a
  // second hold if the follow-up resolve fails (the hold is committed, but the
  // concern may stay open) — the "Create hold" action is hidden regardless.
  const [heldTicketIds, setHeldTicketIds] = useState<Set<string>>(new Set());
  // Same session-local dedupe for applied frequency changes (C4/G4): once a
  // request is applied, the action is hidden even if the follow-up resolve
  // fails, so a double-click can't re-apply.
  const [appliedFreqTicketIds, setAppliedFreqTicketIds] = useState<Set<string>>(new Set());
  const qc = useQueryClient();
  const listFn = useServerFn(listConcerns);
  const updateFn = useServerFn(updateConcernStatus);
  const replyFn = useServerFn(replyToConcern);
  const applyFreqFn = useServerFn(applyFrequencyChangeRequest);
  const replyMut = useMutation({
    mutationFn: (v: { ticketId: string; message: string }) => replyFn({ data: v }),
    onSuccess: (r: any, v) => {
      toast.success(`Replied to ${r?.recipient ?? "the client"}`);
      setReplies((s) => ({ ...s, [v.ticketId]: "" }));
      qc.invalidateQueries({ queryKey: ["concerns"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

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

  const applyFreqMut = useMutation({
    mutationFn: (v: { ticketId: string; subscriptionId: string; frequency: string }) =>
      applyFreqFn({ data: { subscriptionId: v.subscriptionId, frequency: v.frequency as any } }),
    onSuccess: (r: any, v) => {
      setAppliedFreqTicketIds((s) => new Set(s).add(v.ticketId));
      toast.success(
        r?.changed
          ? `Frequency changed to ${frequencyLabel(v.frequency)}`
          : "Service already at the requested frequency",
      );
      // Close the loop on the concern; if this fails the applied-set above
      // still hides the action so the change can't be applied twice.
      mut.mutate({
        ticketId: v.ticketId,
        status: "resolved",
        resolutionNote: r?.changed
          ? `Frequency change applied: ${frequencyLabel(r.fromFrequency)} → ${frequencyLabel(v.frequency)}`
          : `Frequency change request closed — service already ${frequencyLabel(v.frequency)}`,
      });
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
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-10 text-center">
          <div className="rounded-full bg-emerald-500/10 p-3">
            <Inbox className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <p className="font-medium">
              {filter === "all"
                ? "No concerns, happy yards all around"
                : `Nothing in "${filter === "open" ? "Received" : STATUS_LABEL[filter as ConcernStatus]}"`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              When a client flags an issue from their portal or a visit review, it lands here so
              you can respond before it becomes a churn risk.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/messages">Open client messages</Link>
          </Button>
        </div>
      ) : (
        <ul className="space-y-3">
          {concerns.map((c) => {
            const status = c.status as ConcernStatus;
            const client = Array.isArray(c.clients) ? c.clients[0] : c.clients;
            const holdRequest = c.client_id ? parseHoldRequest(c.message) : null;
            const freqRequest = c.client_id ? parseFrequencyRequest(c.message) : null;
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

                {holdRequest && status !== "resolved" && !heldTicketIds.has(c.id) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    <CalendarOff className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
                    <span className="text-amber-800 dark:text-amber-300">
                      Hold requested {formatDay(holdRequest.startsOn)} to {formatDay(holdRequest.endsOn)}.
                    </span>
                    <Button
                      size="sm"
                      className="ml-auto"
                      onClick={() =>
                        setHoldFor({
                          ticketId: c.id,
                          clientId: c.client_id,
                          startsOn: holdRequest.startsOn,
                          endsOn: holdRequest.endsOn,
                          reason: holdRequest.reason || "Vacation hold",
                        })
                      }
                    >
                      Create hold from request
                    </Button>
                  </div>
                )}

                {freqRequest && status !== "resolved" && !appliedFreqTicketIds.has(c.id) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    <Repeat className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
                    <span className="text-amber-800 dark:text-amber-300">
                      Frequency change requested: {frequencyLabel(freqRequest.fromFrequency)} →{" "}
                      {frequencyLabel(freqRequest.toFrequency)}.
                    </span>
                    <ConfirmButton
                      variant="default"
                      size="sm"
                      title="Apply frequency change?"
                      description={`Change ${client?.display_name ?? "this client"}'s service from ${frequencyLabel(freqRequest.fromFrequency)} to ${frequencyLabel(freqRequest.toFrequency)}. Upcoming visits are rescheduled to the new cadence and the concern is resolved.`}
                      confirmLabel="Apply change"
                      disabled={applyFreqMut.isPending}
                      onConfirm={() =>
                        applyFreqMut.mutate({
                          ticketId: c.id,
                          subscriptionId: freqRequest.subscriptionId,
                          frequency: freqRequest.toFrequency,
                        })
                      }
                      trigger={
                        <Button size="sm" className="ml-auto" disabled={applyFreqMut.isPending}>
                          Apply frequency change
                        </Button>
                      }
                    />
                  </div>
                )}

                {c.last_reply_at && (
                  <p className="mt-2 rounded bg-muted/50 p-2 text-xs text-muted-foreground">
                    You replied {fmt(c.last_reply_at)}: <span className="italic">{c.last_reply}</span>
                  </p>
                )}

                {client?.primary_email &&
                  (openReply.has(c.id) ? (
                    <div className="mt-3 space-y-2">
                      <Textarea
                        rows={2}
                        autoFocus
                        placeholder={`Reply to ${client.display_name ?? "the client"} by email…`}
                        value={replies[c.id] ?? ""}
                        onChange={(e) => setReplies((s) => ({ ...s, [c.id]: e.target.value }))}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={replyMut.isPending || !(replies[c.id] ?? "").trim()}
                          onClick={() => replyMut.mutate({ ticketId: c.id, message: replies[c.id] })}
                        >
                          {replyMut.isPending ? "Sending…" : "Send reply"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggle(setOpenReply, c.id)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3"
                      onClick={() => toggle(setOpenReply, c.id)}
                    >
                      Reply by email
                    </Button>
                  ))}

                {status === "resolved" ? (
                  <div className="mt-3 text-xs text-muted-foreground">
                    Resolved {c.resolved_at ? fmt(c.resolved_at) : ""}
                    {c.resolution_note ? `: ${c.resolution_note}` : ""}
                    <button
                      className="ml-2 text-primary underline underline-offset-2"
                      onClick={() => mut.mutate({ ticketId: c.id, status: "in_progress" })}
                    >
                      Reopen
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {openResolve.has(c.id) && (
                      <Textarea
                        rows={2}
                        autoFocus
                        placeholder="Resolution note (optional): what was done"
                        value={notes[c.id] ?? ""}
                        onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                      />
                    )}
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
                      {!openResolve.has(c.id) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggle(setOpenResolve, c.id)}
                        >
                          Add resolution note
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {holdFor && (
        <VacationHoldDrawer
          open={!!holdFor}
          onClose={() => setHoldFor(null)}
          clientId={holdFor.clientId}
          initialStartsOn={holdFor.startsOn}
          initialEndsOn={holdFor.endsOn}
          initialReason={holdFor.reason}
          onCreated={(info) => {
            // The hold is committed. Retire the "Create hold" action for this
            // concern immediately so a resolve failure can't leave it available
            // and let a second hold be placed for the same request.
            const ticketId = holdFor.ticketId;
            setHeldTicketIds((s) => new Set(s).add(ticketId));
            // Link + resolve the originating concern once the hold is placed.
            mut.mutate(
              {
                ticketId,
                status: "resolved",
                resolutionNote: `Vacation hold placed ${info.startsOn} to ${info.endsOn}${
                  info.removedVisits
                    ? ` (${info.removedVisits} scheduled visit${info.removedVisits === 1 ? "" : "s"} removed)`
                    : ""
                }.`,
              },
              {
                onError: () =>
                  toast.error(
                    "Hold placed, but the concern couldn't be auto-resolved. Resolve it manually.",
                  ),
              },
            );
            setHoldFor(null);
          }}
        />
      )}
    </div>
  );
}
