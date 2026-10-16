import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarCheck, CalendarOff, CalendarPlus, Inbox, Repeat, Sparkles } from "lucide-react";
import { ScheduleRecleanDialog, type RecleanTicket } from "@/components/ScheduleRecleanDialog";
import {
  BookOneOffRequestDialog,
  type OneOffRequestTicket,
} from "@/components/BookOneOffRequestDialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listConcerns,
  updateConcernStatus,
  replyToConcern,
  CONCERN_CATEGORY_LABELS,
  type ConcernStatus,
} from "@/lib/concerns.functions";
import { parseHoldRequest } from "@/lib/hold-request";
import { humanizeEnum } from "@/lib/humanize";
import { parseFrequencyRequest, frequencyLabel } from "@/lib/frequency-request";
import { applyFrequencyChangeRequest } from "@/lib/subscriptions.functions";
import { bookLessonRequest } from "@/lib/training-packages.functions";
import { usePermissions } from "@/hooks/useMyRole";
import { ConfirmButton } from "@/components/ConfirmButton";
import { VacationHoldDrawer } from "@/components/client-detail/VacationHoldDrawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useRowSelection } from "@/hooks/useRowSelection";
import { formatDateTime, formatDay, formatPhone } from "@/lib/format";
import { toast } from "sonner";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/concerns")({
  head: () => titleHead("Concerns"),
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
  return formatDateTime(d);
}

/** PostgREST returns a to-one embed as an object, but older typings and some
 *  callers see an array; read either. */
function oneOf<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * What a re-clean request needs that a concern does not: which visit it is
 * about, and whether the free return visit is booked yet.
 *
 * Once booked the row says so and the button is gone, which is what stops a
 * second free visit being booked for one request. Without manage_pricing the
 * button is hidden rather than left to fail: createOneOffVisit sets a price
 * (even $0) and requires it, the same gate as the frequency-change apply.
 */
function RecleanRow({
  concern,
  status,
  canSchedule,
  onSchedule,
}: {
  concern: any;
  status: ConcernStatus;
  canSchedule: boolean;
  onSchedule: () => void;
}) {
  const visit = oneOf<{ scheduled_on: string; property_id: string }>(concern.visit);
  const booked = oneOf<{ scheduled_on: string }>(concern.reclean_visit);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
      {booked ? (
        <CalendarCheck className="h-4 w-4 shrink-0 text-sky-700 dark:text-sky-400" />
      ) : (
        <Sparkles className="h-4 w-4 shrink-0 text-sky-700 dark:text-sky-400" />
      )}
      <span className="min-w-0 flex-1 basis-48 text-sky-900 dark:text-sky-200">
        {booked
          ? `Re-clean booked for ${formatDay(booked.scheduled_on)}.`
          : visit
            ? `Asked for a free re-clean of the visit on ${formatDay(visit.scheduled_on)}.`
            : "Asked for a free re-clean. The visit it was about has since been deleted."}
      </span>
      {!booked && visit && status !== "resolved" && canSchedule && (
        <Button size="sm" className="ml-auto" onClick={onSchedule}>
          Schedule re-clean
        </Button>
      )}
    </div>
  );
}

/** What the office tells a customer whose extra cleanup it cannot fit in,
 *  unless somebody writes something better in the resolution note. */
const ONE_OFF_DECLINE_NOTE =
  "We couldn't fit that day in. Please pick another day, or give us a call.";

/**
 * A customer's request for an extra cleanup: the day and the address, and
 * either "Book it" or what became of it. Book it is manage_pricing only, for
 * the same reason as Schedule re-clean: createOneOffVisit sets a price.
 * Declining resolves the request with a note the customer reads in the
 * portal, so they are never left looking at "Received" for a day that passed.
 */
function OneOffRow({
  concern,
  status,
  canBook,
  onBook,
  onDecline,
  declining,
}: {
  concern: any;
  status: ConcernStatus;
  canBook: boolean;
  onBook: () => void;
  onDecline: () => void;
  declining: boolean;
}) {
  const booked = oneOf<{ scheduled_on: string }>(concern.booked_visit);
  const property = oneOf<{ street: string; city: string | null }>(concern.property);
  const where = property ? [property.street, property.city].filter(Boolean).join(", ") : null;
  // What was asked for (phase 5): "an extra visit" for pet waste or a request
  // from before the catalog, else the service by name.
  const service = oneOf<{ name: string; service_line: string }>(concern.service);
  const what =
    service && service.service_line !== "pet_waste" ? `"${service.name}"` : "an extra visit";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm">
      {booked ? (
        <CalendarCheck className="h-4 w-4 shrink-0 text-violet-700 dark:text-violet-400" />
      ) : (
        <CalendarPlus className="h-4 w-4 shrink-0 text-violet-700 dark:text-violet-400" />
      )}
      <span className="min-w-0 flex-1 basis-48 break-words text-violet-900 dark:text-violet-200">
        {booked
          ? `Booked for ${formatDay(booked.scheduled_on)}.`
          : status === "resolved"
            ? `Asked for ${formatDay(concern.requested_on)}. Not booked.`
            : `Asked for ${what} on ${formatDay(concern.requested_on)}${
                where ? ` at ${where}` : ""
              }.`}
      </span>
      {!booked && status !== "resolved" && canBook && concern.property_id && (
        <div className="ml-auto flex flex-wrap gap-2">
          <ConfirmButton
            title="Decline this request?"
            description={`The client sees it as not booked, with this reply: "${ONE_OFF_DECLINE_NOTE}" Write your own in the resolution note first if you'd rather.`}
            confirmLabel="Decline"
            onConfirm={onDecline}
            trigger={
              <Button size="sm" variant="outline" disabled={declining}>
                Decline
              </Button>
            }
          />
          <Button size="sm" onClick={onBook}>
            Book it
          </Button>
        </div>
      )}
    </div>
  );
}

const LESSON_DECLINE_NOTE = "We couldn't book that time. We'll be in touch to find another.";

/** A client asked for the next lesson from a training package in the portal.
 *  Booking takes the day, time, address and package they asked for; the
 *  trainer is assigned on the schedule afterwards. */
function LessonRequestRow({
  concern,
  status,
  canBook,
  booking,
  onBook,
  onDecline,
  declining,
}: {
  concern: any;
  status: ConcernStatus;
  canBook: boolean;
  booking: boolean;
  onBook: () => void;
  onDecline: () => void;
  declining: boolean;
}) {
  const booked = oneOf<{ scheduled_on: string }>(concern.booked_visit);
  const pack = oneOf<{ name: string; sessions_count: number; sessions_used: number }>(
    concern.client_package,
  );
  const property = oneOf<{ street: string; city: string | null }>(concern.property);
  const where = property ? [property.street, property.city].filter(Boolean).join(", ") : null;
  const at = concern.requested_time ? ` at ${String(concern.requested_time).slice(0, 5)}` : "";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-sm">
      {booked ? (
        <CalendarCheck className="h-4 w-4 shrink-0 text-violet-700 dark:text-violet-400" />
      ) : (
        <CalendarPlus className="h-4 w-4 shrink-0 text-violet-700 dark:text-violet-400" />
      )}
      <span className="min-w-0 flex-1 basis-48 break-words text-violet-900 dark:text-violet-200">
        {booked
          ? `Lesson booked for ${formatDay(booked.scheduled_on)}${at}. Assign the trainer on the schedule.`
          : status === "resolved"
            ? `Asked for a lesson on ${formatDay(concern.requested_on)}${at}. Not booked.`
            : `Asked for a lesson on ${formatDay(concern.requested_on)}${at}${
                where ? ` at ${where}` : ""
              }${pack ? `, from ${pack.name} (${pack.sessions_count - pack.sessions_used} of ${pack.sessions_count} left)` : ""}.`}
      </span>
      {!booked && status !== "resolved" && canBook && concern.client_package_id && (
        <div className="ml-auto flex flex-wrap gap-2">
          <ConfirmButton
            title="Decline this request?"
            description={`The client sees it as not booked, with this reply: "${LESSON_DECLINE_NOTE}" Write your own in the resolution note first if you'd rather.`}
            confirmLabel="Decline"
            onConfirm={onDecline}
            trigger={
              <Button size="sm" variant="outline" disabled={declining}>
                Decline
              </Button>
            }
          />
          <Button size="sm" onClick={onBook} disabled={booking}>
            {booking ? "Booking…" : "Book this lesson"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ConcernsPage() {
  // The one-click frequency apply is a manage_pricing action — hide it for
  // roles (dispatcher) that can reach Concerns but would be server-rejected.
  const { can } = usePermissions();
  const canManagePricing = can("manage_pricing");
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
  // The re-clean request being scheduled, if any.
  const [recleanFor, setRecleanFor] = useState<RecleanTicket | null>(null);
  // The extra-cleanup request being booked, if any.
  const [oneOffFor, setOneOffFor] = useState<OneOffRequestTicket | null>(null);
  const qc = useQueryClient();
  const listFn = useServerFn(listConcerns);
  const updateFn = useServerFn(updateConcernStatus);
  const replyFn = useServerFn(replyToConcern);
  const applyFreqFn = useServerFn(applyFrequencyChangeRequest);
  const bookLessonFn = useServerFn(bookLessonRequest);
  const bookLessonMut = useMutation({
    mutationFn: (ticketId: string) => bookLessonFn({ data: { ticketId } }),
    onSuccess: (r) => {
      toast.success(`Lesson booked for ${formatDay(r.scheduledOn)}`);
      qc.invalidateQueries({ queryKey: ["concerns"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
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
    // Apply + resolve happen in ONE server call so a lost follow-up can't
    // strand an open ticket that blocks the client's next request.
    mutationFn: (v: { ticketId: string; subscriptionId: string; frequency: string }) =>
      applyFreqFn({
        data: { subscriptionId: v.subscriptionId, frequency: v.frequency as any, ticketId: v.ticketId },
      }),
    onSuccess: (r: any, v) => {
      setAppliedFreqTicketIds((s) => new Set(s).add(v.ticketId));
      toast.success(
        r?.changed
          ? `Frequency changed to ${frequencyLabel(v.frequency)}`
          : "Service already at the requested frequency",
      );
      qc.invalidateQueries({ queryKey: ["concerns"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const concerns: any[] = (q.data as any)?.concerns ?? [];

  // Multi-select for bulk resolve (Invoices-page pattern). Only unresolved
  // concerns are selectable; the clearKey drops the selection on filter
  // changes so a bulk action never hits hidden rows.
  const selectableIds = useMemo(
    () => concerns.filter((c) => c.status !== "resolved").map((c) => c.id as string),
    [concerns],
  );
  const sel = useRowSelection(selectableIds, filter);

  // Bulk resolve loops the existing per-ticket updateConcernStatus fn (same
  // permission gate + side effects as the card's "Mark resolved" button).
  const bulkResolveM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((ticketId) => updateFn({ data: { ticketId, status: "resolved" as const } })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Resolved ${r.ok} of ${r.ok + r.failed} concerns, ${r.failed} failed`);
      else toast.success(`Resolved ${r.ok} concern${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["concerns"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Concerns</h1>
        <p className="text-sm text-muted-foreground">
          Issues clients submit from their portal, including re-clean requests and extra visits
          they ask for. Triage and resolve them here.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`touch:min-h-11 rounded-full border px-3 py-1 text-sm touch:px-4 ${filter === f.key ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {selectableIds.length > 0 && (
        <label className="flex min-h-8 w-fit items-center gap-2 px-1 text-xs text-muted-foreground">
          <Checkbox
            checked={sel.allSelected}
            onCheckedChange={sel.toggleAll}
            aria-label="Select all unresolved concerns"
          />
          Select all unresolved
        </label>
      )}

      {/* Bulk action bar */}
      {sel.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
          <span className="font-medium">{sel.count} selected</span>
          <div className="flex gap-2">
            <ConfirmButton
              title={`Resolve ${sel.count} concern${sel.count === 1 ? "" : "s"}?`}
              description="Marks each selected concern resolved (no resolution note). Reopen any of them from its card if needed."
              confirmLabel="Mark resolved"
              onConfirm={() => bulkResolveM.mutate(sel.selectedIds)}
              trigger={
                <Button size="sm" disabled={bulkResolveM.isPending}>
                  {bulkResolveM.isPending ? "Resolving…" : "Mark resolved"}
                </Button>
              }
            />
            <Button size="sm" variant="ghost" onClick={sel.clear}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : concerns.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border bg-card p-10 text-center">
          <div className="rounded-full bg-emerald-500/10 p-3">
            <Inbox className="h-6 w-6 text-emerald-600 dark:text-emerald-400 shrink-0" />
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
                  <div className="flex min-w-0 items-start gap-2.5">
                    {status !== "resolved" && (
                      <Checkbox
                        className="mt-0.5"
                        checked={sel.isSelected(c.id)}
                        onCheckedChange={(v) => sel.toggle(c.id, v === true)}
                        aria-label={`Select concern from ${client?.display_name ?? "client"}`}
                      />
                    )}
                    {/* The submitted line below ends in the client's email
                        address. With no `min-w-0` on this wrapper or on the row
                        above it, the card's minimum width is that one token and
                        the whole PAGE scrolls sideways. `break-words` breaks the
                        address once the box is narrower than it; it is the
                        address the office replies to, so it is not truncated. */}
                    <div className="min-w-0">
                    <div className="flex items-center gap-2 max-md:flex-wrap">
                      <span className="font-medium">{client?.display_name ?? "Client"}</span>
                      <Badge variant="outline">{CONCERN_CATEGORY_LABELS[c.category] ?? humanizeEnum(c.category)}</Badge>
                      {(c as { requested_via?: string | null }).requested_via === "ai_receptionist" && (
                        <Badge variant="outline">By text: AI receptionist</Badge>
                      )}
                      <Badge variant={status === "resolved" ? "secondary" : status === "in_progress" ? "default" : "destructive"}>
                        {STATUS_LABEL[status]}
                      </Badge>
                    </div>
                    <div className="mt-1 break-words text-xs text-muted-foreground">
                      Submitted {fmt(c.created_at)}
                      {client?.primary_phone ? ` · ${formatPhone(client.primary_phone)}` : ""}
                      {client?.primary_email ? ` · ${client.primary_email}` : ""}
                    </div>
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

                {freqRequest && status !== "resolved" && canManagePricing && !appliedFreqTicketIds.has(c.id) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
                    <Repeat className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
                    <span className="text-amber-800 dark:text-amber-300">
                      Frequency change requested: {frequencyLabel(freqRequest.fromFrequency)} →{" "}
                      {frequencyLabel(freqRequest.toFrequency)}.
                    </span>
                    <ConfirmButton
                      title="Apply frequency change?"
                      description={`Change ${client?.display_name ?? "this client"}'s service from ${frequencyLabel(freqRequest.fromFrequency)} to ${frequencyLabel(freqRequest.toFrequency)}. Upcoming visits are rescheduled to the new cadence and the concern is resolved.`}
                      confirmLabel="Apply change"
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

                {c.category === "reclean_request" && (
                  <RecleanRow
                    concern={c}
                    status={status}
                    canSchedule={canManagePricing}
                    onSchedule={() =>
                      setRecleanFor({
                        ticketId: c.id,
                        clientId: c.client_id,
                        clientName: client?.display_name ?? "this client",
                        visit: oneOf(c.visit)!,
                      })
                    }
                  />
                )}

                {c.category === "one_off_request" && (
                  <OneOffRow
                    concern={c}
                    status={status}
                    canBook={canManagePricing}
                    declining={mut.isPending}
                    onDecline={() =>
                      mut.mutate({
                        ticketId: c.id,
                        status: "resolved",
                        resolutionNote: (notes[c.id] ?? "").trim() || ONE_OFF_DECLINE_NOTE,
                      })
                    }
                    onBook={() => {
                      const prop = oneOf<{
                        street: string;
                        city: string | null;
                        dogs?: Array<{ active: boolean | null }> | null;
                      }>(c.property);
                      // Counted as bookOneOffVisit counts them: active dogs,
                      // NOT (active IS false), at least one; one for a
                      // commercial account.
                      const pets =
                        client?.account_type === "commercial"
                          ? 1
                          : Math.max(1, (prop?.dogs ?? []).filter((d) => d.active !== false).length);
                      setOneOffFor({
                        ticketId: c.id,
                        clientId: c.client_id,
                        clientName: client?.display_name ?? "this client",
                        propertyId: c.property_id,
                        address: prop ? [prop.street, prop.city].filter(Boolean).join(", ") : null,
                        requestedOn: c.requested_on,
                        pets,
                        service: oneOf<OneOffRequestTicket["service"]>(c.service) ?? null,
                      });
                    }}
                  />
                )}

                {c.category === "training_lesson_request" && (
                  <LessonRequestRow
                    concern={c}
                    status={status}
                    canBook={canManagePricing}
                    booking={bookLessonMut.isPending && bookLessonMut.variables === c.id}
                    onBook={() => bookLessonMut.mutate(c.id)}
                    declining={mut.isPending}
                    onDecline={() =>
                      mut.mutate({
                        ticketId: c.id,
                        status: "resolved",
                        resolutionNote: (notes[c.id] ?? "").trim() || LESSON_DECLINE_NOTE,
                      })
                    }
                  />
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
                      className="ml-2 text-primary underline underline-offset-2 max-md:inline-block max-md:py-2"
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

      {/* Always mounted: it remembers a visit it booked but could not link,
          so a retry links instead of booking a second one. */}
      <ScheduleRecleanDialog
        ticket={recleanFor}
        onOpenChange={(o) => {
          if (!o) setRecleanFor(null);
        }}
      />

      {/* Always mounted, for the same reason as the re-clean dialog. */}
      <BookOneOffRequestDialog
        ticket={oneOffFor}
        onOpenChange={(o) => {
          if (!o) setOneOffFor(null);
        }}
      />

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
    </>
  );
}
