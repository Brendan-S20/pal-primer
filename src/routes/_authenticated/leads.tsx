import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listLeads,
  updateLeadStatus,
  convertLeadToClient,
  getLeadFormConfig,
} from "@/lib/leads.functions";
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

export const Route = createFileRoute("/_authenticated/leads")({
  component: LeadsPage,
});

const STATUSES = ["new", "contacted", "qualified", "converted", "archived"] as const;

function LeadsPage() {
  const list = useServerFn(listLeads);
  const upd = useServerFn(updateLeadStatus);
  const convertFn = useServerFn(convertLeadToClient);
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

  const convertMut = useMutation({
    mutationFn: (id: string) => convertFn({ data: { id } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["clients"] });
      toast.success("Converted to client");
      navigate({ to: "/clients/$clientId", params: { clientId: r.clientId } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
    <div className="space-y-6">
      {dialog}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Prospects submitted through the public contact form.
          </p>
        </div>
        <div className="flex items-end gap-2">
          {/* The form these leads come from: see it as a prospect would, or
              jump straight into editing it (Brendan, 2026-07-14). */}
          {formSlug && (
            <a href={`/lead/${formSlug}`} target="_blank" rel="noreferrer">
              <Button variant="outline">
                <Eye className="mr-1 h-4 w-4 shrink-0" /> Preview form
              </Button>
            </a>
          )}
          <Link to="/settings/lead-form">
            <Button variant="outline">
              <Pencil className="mr-1 h-4 w-4 shrink-0" /> Edit form
            </Button>
          </Link>
          <div className="w-48">
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
          No leads yet. The contact form on your marketing site will land here.
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

          {leads.map((l) => (
            <div key={l.id} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <Checkbox
                  className="mt-1"
                  checked={sel.isSelected(l.id)}
                  onCheckedChange={(next) => sel.toggle(l.id, !!next)}
                  aria-label={`Select lead ${l.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{l.name}</div>
                    <Badge variant="outline">{humanizeEnum(l.status)}</Badge>
                    {l.company ? (
                      <span className="text-sm text-muted-foreground">· {l.company}</span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {/* The action column beside this is a hard `w-40`, so the
                        lead body is about 96px wide on a phone. A lead's email
                        is the only copy of it anywhere in the app — it cannot be
                        truncated away — so `break-all` gives the address
                        somewhere to break instead of setting the width of the
                        row. */}
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
                  </div>
                  {l.message ? (
                    <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm">{l.message}</p>
                  ) : null}
                  <div className="mt-2 text-xs text-muted-foreground">
                    {formatDateTime(l.created_at)} · source: {humanizeEnum(l.source)}
                  </div>
                </div>
                <div className="flex w-40 flex-col gap-2">
                  {/* Salesforce-style ••• row actions. Leads have no detail
                      page or edit drawer, so only the existing actions are
                      wired: convert (convertLeadToClient) and archive
                      (updateLeadStatus — same fn the status select uses). */}
                  <RowActions
                    actions={[
                      ...(l.status !== "converted"
                        ? [
                            {
                              label: "Convert to client",
                              disabled: convertMut.isPending,
                              onSelect: async () => {
                                if (
                                  await confirm({
                                    title: `Convert ${l.name} to a client?`,
                                    description:
                                      "Creates a client record from this lead and marks the lead converted.",
                                    confirmLabel: "Convert",
                                  })
                                )
                                  convertMut.mutate(l.id);
                              },
                            },
                          ]
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
                  {l.status !== "converted" && (
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Convert ${l.name} to a client?`,
                            description:
                              "Creates a client record from this lead and marks the lead converted.",
                            confirmLabel: "Convert",
                          })
                        )
                          convertMut.mutate(l.id);
                      }}
                      disabled={convertMut.isPending}
                    >
                      Convert to client
                    </Button>
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
          ))}
        </div>
      )}
    </div>
  );
}
