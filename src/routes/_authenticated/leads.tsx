import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listLeads, updateLeadStatus, getLeadFormConfig } from "@/lib/leads.functions";
import { leadConversionState } from "@/lib/lead-conversion";
import { leadOriginLabel, type LeadSignupState } from "@/lib/new-customer-form";
import { formatStartDate, localToday, petsSummary } from "@/lib/booking-details";
import { Eye, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RowActions } from "@/components/RowActions";
import { useRowSelection } from "@/hooks/useRowSelection";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useMemo, useState } from "react";
import { humanizeEnum } from "@/lib/humanize";
import { formatDateTime, formatPhone } from "@/lib/format";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/leads")({
  head: () => titleHead("Leads"),
  component: LeadsPage,
});

const STATUSES = ["new", "contacted", "qualified", "converted", "archived"] as const;

function LeadsPage() {
  const list = useServerFn(listLeads);
  const upd = useServerFn(updateLeadStatus);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({ queryKey: ["leads"], queryFn: () => list() });
  const cfgFn = useServerFn(getLeadFormConfig);
  const cfgQ = useQuery({ queryKey: ["lead-form-config"], queryFn: () => cfgFn() });
  const formSlug = (cfgQ.data as any)?.slug as string | undefined;

  const mut = useMutation({
    mutationFn: (v: { id: string; status: (typeof STATUSES)[number] }) => upd({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success("Updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Converting opens the new-client wizard started from the lead, and the
  // wizard marks the lead converted when it saves. It used to be a confirm
  // dialog and a one-tap insert that kept the name, email, phone and message
  // and dropped the address, the dogs and the frequency. The wizard is the
  // confirmation now: nothing is written until its last step.
  const convert = (id: string) => navigate({ to: "/clients/new", search: { fromLead: id } });
  const openClient = (clientId: string) =>
    navigate({ to: "/clients/$clientId", params: { clientId } });
  // A price in writing before they commit. The quote editor reads the lead
  // server-side; only its id goes in the URL.
  const quote = (id: string) => navigate({ to: "/quotes/new", search: { fromLead: id } });

  const leads = (data ?? []).filter((l) => filter === "all" || l.status === filter);

  // Multi-select + bulk status changes: loops the same updateLeadStatus fn the
  // per-row select uses. Selection clears when the status filter changes.
  const visibleIds = useMemo(() => leads.map((l) => l.id), [leads]);
  const sel = useRowSelection(visibleIds, filter);
  const { confirm, dialog } = useConfirmDialog();

  const bulkStatusM = useMutation({
    mutationFn: async (v: { ids: string[]; status: (typeof STATUSES)[number] }) => {
      const results = await Promise.allSettled(
        v.ids.map((id) => upd({ data: { id, status: v.status } })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok, status: v.status };
    },
    onSuccess: (r) => {
      const verb = r.status === "archived" ? "Archived" : `Marked ${r.status}`;
      if (r.failed) toast.error(`${verb}: ${r.ok} of ${r.ok + r.failed} leads, ${r.failed} failed`);
      else toast.success(`${verb}: ${r.ok} lead${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      {dialog}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Quote requests and signups from your signup &amp; quote form, in one list.
          </p>
        </div>
        {/* MEASURED 2026-09-28 at 360px: Preview form, Edit form and a fixed
            `w-48` filter in one row that could not wrap came to 495px, so the
            filter ("All") sat off the right edge and the page scrolled
            sideways. It had never been measured: /leads was not a sweep
            surface until the conversion fix put it on the list. Now the row
            wraps, and the filter takes the full width once it is on a line of
            its own. */}
        <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
          {/* The form these leads come from: see it as a prospect would, or
              jump straight into editing it (Brendan, 2026-07-14). */}
          {formSlug && (
            <a href={`/signup/${formSlug}`} target="_blank" rel="noreferrer">
              <Button variant="outline">
                <Eye className="mr-1 h-4 w-4 shrink-0" /> Preview form
              </Button>
            </a>
          )}
          <Link to="/settings/online-signup">
            <Button variant="outline">
              <Pencil className="mr-1 h-4 w-4 shrink-0" /> Edit form
            </Button>
          </Link>
          <div className="w-full sm:w-48">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {humanizeEnum(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : leads.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No leads yet. Quote requests and online signups from your form will land here.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <Checkbox
              checked={sel.allSelected}
              onCheckedChange={sel.toggleAll}
              aria-label="Select all leads"
            />
            <span className="text-xs text-muted-foreground">Select all ({leads.length})</span>
          </div>

          {/* Bulk action bar */}
          {sel.count > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
              <span className="font-medium">{sel.count} selected</span>
              <div className="flex flex-wrap items-center gap-2">
                <div className="w-44">
                  <Select
                    value=""
                    onValueChange={(v) =>
                      bulkStatusM.mutate({
                        ids: sel.selectedIds,
                        status: v as (typeof STATUSES)[number],
                      })
                    }
                    disabled={bulkStatusM.isPending}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Mark as…" />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.filter((s) => s !== "archived").map((s) => (
                        <SelectItem key={s} value={s}>
                          {humanizeEnum(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={bulkStatusM.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Archive ${sel.count} lead${sel.count === 1 ? "" : "s"}?`,
                        description:
                          "Archived leads drop out of the working list but stay available under the Archived filter.",
                        destructive: true,
                        confirmLabel: "Archive",
                      })
                    )
                      bulkStatusM.mutate({ ids: sel.selectedIds, status: "archived" });
                  }}
                >
                  Archive
                </Button>
                <Button size="sm" variant="ghost" onClick={sel.clear}>
                  Clear
                </Button>
              </div>
            </div>
          )}

          {leads.map((l) => {
            const conversion = leadConversionState(l);
            // The signup this lead started, if it is a signup: the newest one,
            // since a visitor who went back and changed their dogs started two.
            const signups = ((l as any).signup_requests ?? []) as Array<
              NonNullable<LeadSignupState> & { created_at?: string }
            >;
            const signup =
              [...signups].sort((a, b) =>
                String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")),
              )[0] ?? null;
            const origin = leadOriginLabel(l.source, signup);
            return (
            <div key={l.id} className="rounded-lg border bg-card p-4">
              {/* MEASURED 2026-09-28 at 390px: the action column sat BESIDE
                  the lead as a hard `w-40`, which left the lead's name, email
                  and message about 96px between the checkbox and the buttons.
                  Below `sm` the actions now go underneath the lead at full
                  width, and beside it from `sm` up, where there is room. */}
              <div className="flex items-start gap-3">
                <Checkbox
                  className="mt-1"
                  checked={sel.isSelected(l.id)}
                  onCheckedChange={(next) => sel.toggle(l.id, !!next)}
                  aria-label={`Select lead ${l.name}`}
                />
                <div className="min-w-0 flex-1 space-y-3 sm:flex sm:items-start sm:gap-3 sm:space-y-0">
                <div className="min-w-0 sm:flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <div className="min-w-0 break-words font-medium">{l.name}</div>
                    <Badge variant="outline">{humanizeEnum(l.status)}</Badge>
                    {/* Where it came from, said plainly: a quote request to
                        answer, a signup that paid, or one that stopped at the
                        card form, which is the one most worth a call. */}
                    <Badge variant="secondary">{origin}</Badge>
                    {l.company ? (
                      <span className="min-w-0 break-words text-sm text-muted-foreground">
                        · {l.company}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {/* A lead's email is the only copy of it anywhere in the
                        app, so it cannot be truncated away; `break-all` gives
                        the address somewhere to break instead of setting the
                        width of the row. */}
                    <a href={`mailto:${l.email}`} className="break-all underline">
                      {l.email}
                    </a>
                    {l.phone ? (
                      <>
                        {" · "}
                        <a href={`tel:${l.phone}`} className="underline">
                          {formatPhone(l.phone)}
                        </a>
                      </>
                    ) : null}
                    {l.location ? <> · {l.location}</> : null}
                    {l.dog_count != null ? (
                      <>
                        {" "}
                        · {l.dog_count} dog{l.dog_count === 1 ? "" : "s"}
                      </>
                    ) : null}
                    {/* What they asked for, when the business sells more than
                        one thing and the form let them pick (phase 5). */}
                    {(l as any).service?.name ? <> · {(l as any).service.name}</> : null}
                  </div>
                  {/* What the first visit needs (#527): when they want to
                      start, the pets by name, and how to get in. */}
                  {l.preferred_start_date || petsSummary(l.pets) || l.access_notes ? (
                    <div className="mt-2 space-y-0.5 text-sm">
                      {l.preferred_start_date ? (
                        <div>
                          <span className="text-muted-foreground">Start on or after:</span>{" "}
                          <span className="font-medium">
                            {formatStartDate(l.preferred_start_date, localToday())}
                          </span>
                        </div>
                      ) : null}
                      {petsSummary(l.pets) ? (
                        <div className="break-words">
                          <span className="text-muted-foreground">Pets:</span>{" "}
                          {petsSummary(l.pets)}
                        </div>
                      ) : null}
                      {l.access_notes ? (
                        <div className="max-w-2xl whitespace-pre-wrap break-words">
                          <span className="text-muted-foreground">Access:</span>{" "}
                          {l.access_notes}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {l.message ? (
                    <p className="mt-2 max-w-2xl whitespace-pre-wrap break-words text-sm">
                      {l.message}
                    </p>
                  ) : null}
                  <div className="mt-2 text-xs text-muted-foreground">
                    {formatDateTime(l.created_at)}
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:w-40 sm:shrink-0">
                  {/* Salesforce-style ••• row actions. Leads have no detail
                      page or edit drawer, so the menu carries the same two
                      things as the buttons below it: convert (or open the
                      client it became) and archive (updateLeadStatus, the same
                      fn the status select uses). */}
                  <RowActions
                    actions={[
                      ...(conversion.kind === "convertible"
                        ? [{ label: "Convert to client", onSelect: () => convert(l.id) }]
                        : conversion.kind === "linked"
                          ? [{ label: "Open client", onSelect: () => openClient(conversion.clientId) }]
                          : []),
                      ...(l.status !== "archived"
                        ? [{ label: "Send a quote", onSelect: () => quote(l.id) }]
                        : []),
                      ...(l.status !== "archived"
                        ? [
                            {
                              label: "Archive",
                              destructive: true,
                              disabled: mut.isPending,
                              onSelect: async () => {
                                if (
                                  await confirm({
                                    title: `Archive lead ${l.name}?`,
                                    description:
                                      "Archived leads drop out of the working list but stay available under the Archived filter.",
                                    destructive: true,
                                    confirmLabel: "Archive",
                                  })
                                )
                                  mut.mutate({ id: l.id, status: "archived" });
                              },
                            },
                          ]
                        : []),
                    ]}
                  />
                  {conversion.kind === "convertible" && (
                    <Button size="sm" onClick={() => convert(l.id)}>
                      Convert to client
                    </Button>
                  )}
                  {conversion.kind === "linked" && (
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/clients/$clientId" params={{ clientId: conversion.clientId }}>
                        Open client
                      </Link>
                    </Button>
                  )}
                  {conversion.kind === "converted-unlinked" && (
                    <p className="text-xs text-muted-foreground">
                      Marked converted, with no client record linked.
                    </p>
                  )}
                  <Select
                    value={l.status}
                    onValueChange={(v) =>
                      mut.mutate({ id: l.id, status: v as (typeof STATUSES)[number] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {humanizeEnum(s)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}
