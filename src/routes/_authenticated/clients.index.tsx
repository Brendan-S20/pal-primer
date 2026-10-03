import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RowActions } from "@/components/RowActions";
import { AiSection, ChurnPanel } from "@/components/ai/AiPanels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  bulkTagClients,
  getSmsConsentCoverage,
  listClients,
  updateClient,
} from "@/lib/clients.functions";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useRowSelection } from "@/hooks/useRowSelection";
import { usePermissions } from "@/hooks/useMyRole";
import { humanizeEnum } from "@/lib/humanize";
import { frequencyLabel } from "@/lib/frequency-request";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { AlertTriangle, Download, MessageSquareOff, Search, Tag, Users } from "lucide-react";
import { downloadCsv } from "@/lib/csv";
import { HelpTip } from "@/components/HelpTip";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/clients/")({
  head: () => titleHead("Clients"),
  component: ClientsList,
});

type StatusFilter = "all" | "active" | "inactive" | "outstanding" | "at_risk" | "no_plan";
type TypeFilter = "all" | "residential" | "commercial";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

/** CSV of the visible client columns — used by both the page-level export
 * (filtered rows) and the bulk bar (selected rows). */
function exportClientsCsv(rows: any[]) {
  downloadCsv(
    `clients-${new Date().toISOString().slice(0, 10)}.csv`,
    [
      "Name",
      "Type",
      "Status",
      "Email",
      "Phone",
      "Frequency",
      "Outstanding",
      "Credit",
      "Churn score",
    ],
    rows.map((c: any) => [
      c.display_name,
      c.account_type,
      c.active ? "active" : "inactive",
      c.primary_email,
      c.primary_phone,
      (c.frequencies ?? []).map((f: string) => frequencyLabel(f)).join("; "),
      ((c.outstanding_cents ?? 0) / 100).toFixed(2),
      ((c.credit_balance_cents ?? 0) / 100).toFixed(2),
      c.churn_score ?? "",
    ]),
  );
}

function ClientsList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fn = useServerFn(listClients);
  const updateFn = useServerFn(updateClient);
  const { can } = usePermissions();
  // Archiving is a manager-class write (updateClient enforces this
  // server-side when `active` changes) — hide the bulk button for roles
  // that would only get an error.
  const canArchive = can("manage_client_billing");
  const { confirm, dialog } = useConfirmDialog();
  const { data, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => fn(),
  });

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [tag, setTag] = useState<string>("all");

  const clients = data?.clients ?? [];

  const stats = useMemo(() => {
    const active = clients.filter((c: any) => c.active).length;
    const outstanding = clients.filter((c: any) => c.outstanding_cents > 0).length;
    const owedTotal = clients.reduce((sum: number, c: any) => sum + (c.outstanding_cents ?? 0), 0);
    const atRisk = clients.filter((c: any) => (c.churn_score ?? 0) >= 60).length;
    // A client with no service plan is never visited, never invoiced, never
    // routed. Until now the list showed them in green as "Active", identical
    // to somebody on a weekly route — and on this database that is 287 of
    // them, sitting in a count of 297 that the schedule flatly contradicts.
    // "Active" is a flag somebody set; having work is a fact. They are not the
    // same thing and the list was only showing the flag.
    const noPlan = clients.filter(
      (c: any) => c.active && (c.active_subscription_count ?? 0) === 0,
    ).length;
    return { total: clients.length, active, outstanding, owedTotal, atRisk, noPlan };
  }, [clients]);

  // Every tag in use, for the filter: tags came in by the hundred once
  // imports carried Jobber's Tags column across, and nothing could find them.
  const allTags = useMemo(() => {
    const byLc = new Map<string, string>();
    for (const c of clients as any[]) for (const t of (c.tags ?? []) as string[]) {
      if (!byLc.has(t.toLowerCase())) byLc.set(t.toLowerCase(), t);
    }
    return [...byLc.values()].sort((a, b) => a.localeCompare(b));
  }, [clients]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter((c: any) => {
      if (type !== "all" && c.account_type !== type) return false;
      if (
        tag !== "all" &&
        !((c.tags ?? []) as string[]).some((t) => t.toLowerCase() === tag.toLowerCase())
      )
        return false;
      if (status === "active" && !c.active) return false;
      if (status === "inactive" && c.active) return false;
      if (status === "outstanding" && !(c.outstanding_cents > 0)) return false;
      if (status === "at_risk" && !((c.churn_score ?? 0) >= 60)) return false;
      if (status === "no_plan" && !(c.active && (c.active_subscription_count ?? 0) === 0))
        return false;
      if (!needle) return true;
      const hay = [c.display_name, c.primary_email, c.primary_phone, ...((c.tags ?? []) as string[])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [clients, q, status, type, tag]);

  // Multi-select over the currently filtered rows (desktop table). Selection
  // clears whenever a filter changes so a bulk action never hits hidden rows.
  const visibleIds = useMemo(() => filtered.map((c: any) => c.id as string), [filtered]);
  const sel = useRowSelection(visibleIds, `${q}|${status}|${type}|${tag}`);
  const selectedRows = useMemo(
    () => filtered.filter((c: any) => sel.isSelected(c.id)),
    [filtered, sel],
  );

  // Bulk archive loops the existing per-client updateClient fn (same
  // permission gate + per-client activity log as the edit drawer).
  const archiveM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => updateFn({ data: { clientId: id, active: false } })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed) toast.error(`Archived ${r.ok} of ${r.ok + r.failed} clients, ${r.failed} failed`);
      else toast.success(`Archived ${r.ok} client${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Lift the imported-clients communications hold in bulk — same per-client
  // updateClient fn (and activity log) as the client-header toggle.
  const resumeCommsM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => updateFn({ data: { clientId: id, commsPaused: false } })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Resumed communications for ${r.ok} of ${r.ok + r.failed} clients, ${r.failed} failed`);
      else toast.success(`Resumed communications for ${r.ok} client${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Bulk tags: one tag added to, or taken off, every selected client.
  const tagFn = useServerFn(bulkTagClients);
  const [tagAction, setTagAction] = useState<"add" | "remove" | null>(null);
  const [tagText, setTagText] = useState("");
  const askTag = (action: "add" | "remove") => {
    setTagText("");
    setTagAction(action);
  };
  const selectedTags = useMemo(() => {
    const byLc = new Map<string, string>();
    for (const c of selectedRows as any[]) for (const t of (c.tags ?? []) as string[]) {
      if (!byLc.has(t.toLowerCase())) byLc.set(t.toLowerCase(), t);
    }
    return [...byLc.values()].sort((a, b) => a.localeCompare(b));
  }, [selectedRows]);
  const tagM = useMutation({
    mutationFn: (v: { action: "add" | "remove"; tag: string }) =>
      tagFn({ data: { ids: sel.selectedIds, tag: v.tag, action: v.action } }),
    onSuccess: (r, v) => {
      toast.success(
        v.action === "add"
          ? `Tagged ${r.changed} client${r.changed === 1 ? "" : "s"} "${v.tag}"`
          : `Removed "${v.tag}" from ${r.changed} client${r.changed === 1 ? "" : "s"}`,
      );
      setTagAction(null);
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      {dialog}
      <Dialog open={tagAction != null} onOpenChange={(o) => !o && setTagAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {tagAction === "remove" ? "Remove a tag" : "Add a tag"} ({sel.count} selected)
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const t = tagText.trim();
              if (t && tagAction) tagM.mutate({ action: tagAction, tag: t });
            }}
          >
            {tagAction === "remove" ? (
              <select
                aria-label="Tag to remove"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Choose a tag…</option>
                {selectedTags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                aria-label="Tag to add"
                list="client-tags-in-use"
                maxLength={40}
                placeholder="e.g. VIP, Tuesday, HOA"
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
                autoFocus
              />
            )}
            <datalist id="client-tags-in-use">
              {allTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setTagAction(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!tagText.trim() || tagM.isPending}>
                {tagAction === "remove" ? "Remove tag" : "Add tag"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {/* flex-wrap, because at 360px "Export CSV" and "New client" beside a
          two-line title is about 480px of content in a 360px row: without it
          the buttons go over the right edge rather than dropping under. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="text-sm text-muted-foreground">
            {stats.total} total · {stats.active} active
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={!filtered.length}
            onClick={() => exportClientsCsv(filtered)}
          >
            <Download className="mr-1 h-4 w-4 shrink-0" /> Export CSV
          </Button>
          <Link to="/clients/new">
            <Button>New client</Button>
          </Link>
        </div>
      </div>

      <SmsConsentBanner />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Users className="h-4 w-4 shrink-0" /> Active
          </div>
          <p className="mt-1 text-2xl font-semibold">{stats.active}</p>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Outstanding</div>
          <p className="mt-1 text-2xl font-semibold">{money(stats.owedTotal)}</p>
          <p className="text-xs text-muted-foreground">{stats.outstanding} clients</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0" /> At churn risk
          </div>
          <p className="mt-1 text-2xl font-semibold">{stats.atRisk}</p>
        </Card>
        {/* Replaces the "Inactive" tile. Inactive was already derivable from
            Active and the total, and it is the less useful of the two: an
            archived client is a decision somebody made, whereas an active
            client with no plan is usually an oversight — an import that was
            never finished, or a service that ended and was never replaced.
            Those are the ones that quietly stop earning. */}
        <Card
          className={`p-4 ${stats.noPlan > 0 ? "cursor-pointer hover:bg-muted/40" : ""}`}
          onClick={() => stats.noPlan > 0 && setStatus("no_plan")}
        >
          <div
            className="text-xs text-muted-foreground"
            title="Active clients with no running service. They are never scheduled, never invoiced, and never appear on a route."
          >
            No service plan
          </div>
          <p
            className={`mt-1 text-2xl font-semibold ${stats.noPlan > 0 ? "text-amber-600" : ""}`}
          >
            {stats.noPlan}
          </p>
          <p className="text-xs text-muted-foreground">
            {stats.total - stats.active} archived
          </p>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground shrink-0" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email or phone…"
            className="pl-8"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="outstanding">Has balance</SelectItem>
            <SelectItem value="at_risk">At churn risk</SelectItem>
            <SelectItem value="no_plan">No service plan</SelectItem>
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={(v) => setType(v as TypeFilter)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="residential">Residential</SelectItem>
            <SelectItem value="commercial">Commercial</SelectItem>
          </SelectContent>
        </Select>
        {allTags.length > 0 && (
          <Select value={tag} onValueChange={setTag}>
            <SelectTrigger className="w-44" aria-label="Filter by tag">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              {allTags.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Bulk action bar — appears once rows are checked in the table */}
      {sel.count > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
          <span className="font-medium">{sel.count} selected</span>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={tagM.isPending}
              onClick={() => askTag("add")}
            >
              <Tag className="mr-1 h-4 w-4 shrink-0" /> Add tag
            </Button>
            {selectedRows.some((c: any) => (c.tags ?? []).length > 0) && (
              <Button
                size="sm"
                variant="outline"
                disabled={tagM.isPending}
                onClick={() => askTag("remove")}
              >
                Remove tag
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => exportClientsCsv(selectedRows)}>
              <Download className="mr-1 h-4 w-4 shrink-0" /> Export CSV
            </Button>
            {selectedRows.some((c: any) => c.comms_paused) && (
              <Button
                size="sm"
                variant="outline"
                disabled={resumeCommsM.isPending}
                onClick={() =>
                  resumeCommsM.mutate(
                    selectedRows.filter((c: any) => c.comms_paused).map((c: any) => c.id),
                  )
                }
              >
                {resumeCommsM.isPending ? "Resuming…" : "Resume communications"}
              </Button>
            )}
            {canArchive && (
              <Button
                size="sm"
                variant="destructive"
                disabled={archiveM.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Archive ${sel.count} client${sel.count === 1 ? "" : "s"}?`,
                      description:
                        "They are marked inactive. You can reactivate a client anytime from their page.",
                      destructive: true,
                      confirmLabel: "Archive",
                    })
                  )
                    archiveM.mutate(sel.selectedIds);
                }}
              >
                {archiveM.isPending ? "Archiving…" : "Archive"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={sel.clear}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !filtered.length ? (
        <div className="rounded-lg border border-dashed bg-card p-10 text-center">
          <p className="text-muted-foreground">
            {clients.length ? "No clients match those filters." : "No clients yet."}
          </p>
          {!clients.length && (
            <Link to="/clients/new" className="mt-3 inline-block">
              <Button size="sm">Create the first one</Button>
            </Link>
          )}
        </div>
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 sm:hidden">
            {filtered.map((c: any) => (
              <Link
                key={c.id}
                to="/clients/$clientId"
                params={{ clientId: c.id }}
                className="block rounded-lg border bg-card p-4 hover:bg-muted/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.display_name}</span>
                      <Badge
                        variant={c.account_type === "commercial" ? "default" : "secondary"}
                        className="text-3xs"
                      >
                        {humanizeEnum(c.account_type)}
                      </Badge>
                      {(c.churn_score ?? 0) >= 60 && (
                        <Badge variant="destructive" className="text-3xs">
                          At risk
                        </Badge>
                      )}
                      {c.comms_paused && (
                        <Badge variant="outline" className="text-3xs">
                          Comms paused
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground truncate">
                      {c.primary_email ?? "-"}
                    </div>
                    <div className="text-xs text-muted-foreground">{c.primary_phone ?? ""}</div>
                  </div>
                  <div className="text-right">
                    {/* Three states, not two. "Active with no plan" was
                        rendering as plain green "Active", which is the same
                        thing it says about somebody on a weekly route. */}
                    {!c.active ? (
                      <span className="text-xs text-muted-foreground">Inactive</span>
                    ) : (c.active_subscription_count ?? 0) === 0 ? (
                      <span className="text-xs text-amber-600">No service plan</span>
                    ) : (
                      <span className="text-xs text-emerald-600">Active</span>
                    )}
                    {/* Show owed and credit distinctly and labeled — a client
                        can carry both at once (finding #22). */}
                    <div className="mt-1 space-y-0.5 text-sm">
                      {c.outstanding_cents > 0 && (
                        <div className="font-medium text-amber-600">
                          {money(c.outstanding_cents)}{" "}
                          <span className="text-2xs font-normal">owed</span>
                        </div>
                      )}
                      {c.credit_balance_cents > 0 && (
                        <div className="text-emerald-600">
                          +{money(c.credit_balance_cents)}{" "}
                          <span className="text-2xs text-emerald-700/70">credit</span>
                        </div>
                      )}
                      {!(c.outstanding_cents > 0) && !(c.credit_balance_cents > 0) && (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>{c.dog_count} dogs</span>
                  <span>{c.active_subscription_count} subs</span>
                  {(c.frequencies ?? []).length > 0 && (
                    <Badge variant="outline" className="text-3xs">
                      {(c.frequencies as string[]).map((f) => frequencyLabel(f)).join(", ")}
                    </Badge>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop: table */}
          <div className="relative hidden overflow-x-auto rounded-lg border bg-card sm:block">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2">
                    <Checkbox
                      checked={sel.allSelected}
                      onCheckedChange={sel.toggleAll}
                      aria-label="Select all clients"
                    />
                  </th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Dogs</th>
                  <th className="px-4 py-2 font-medium">Subs</th>
                  <th className="px-4 py-2 font-medium">Frequency</th>
                  <th className="px-4 py-2 font-medium">Balance</th>
                  <th className="px-4 py-2 font-medium">Contact</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="w-28 px-4 py-2 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c: any) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={sel.isSelected(c.id)}
                        onCheckedChange={(next) => sel.toggle(c.id, !!next)}
                        aria-label={`Select ${c.display_name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to="/clients/$clientId"
                        params={{ clientId: c.id }}
                        className="font-medium hover:underline"
                      >
                        {c.display_name}
                      </Link>
                      {(c.churn_score ?? 0) >= 60 && (
                        <Badge variant="destructive" className="ml-2 text-3xs">
                          At risk
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={c.account_type === "commercial" ? "default" : "secondary"}>
                        {humanizeEnum(c.account_type)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.dog_count}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.active_subscription_count}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {(c.frequencies ?? []).length
                        ? (c.frequencies as string[]).map((f) => frequencyLabel(f)).join(", ")
                        : "-"}
                    </td>
                    <td className="px-4 py-3">
                      {c.outstanding_cents > 0 ? (
                        <span className="font-medium text-amber-600">
                          {money(c.outstanding_cents)}
                        </span>
                      ) : c.credit_balance_cents > 0 ? (
                        <span className="text-emerald-600">+{money(c.credit_balance_cents)}</span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <div className="truncate max-w-[220px]">{c.primary_email ?? "-"}</div>
                      <div className="text-xs">{c.primary_phone ?? ""}</div>
                    </td>
                    <td className="px-4 py-3">
                      {/* Same three states as the mobile cards above — the two
                          views disagreeing about what "Active" means is how
                          somebody checks on a phone and gets a different
                          answer than the person beside them on a laptop. */}
                      {!c.active ? (
                        <span className="text-muted-foreground">Inactive</span>
                      ) : (c.active_subscription_count ?? 0) === 0 ? (
                        <span className="text-amber-600">No service plan</span>
                      ) : (
                        <span className="text-emerald-600">Active</span>
                      )}
                      {c.comms_paused && (
                        <Badge variant="outline" className="ml-2 text-3xs">
                          Comms paused
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RowActions
                        view={{
                          label: `View ${c.display_name}`,
                          onSelect: () =>
                            navigate({ to: "/clients/$clientId", params: { clientId: c.id } }),
                        }}
                        edit={{
                          label: `Edit ${c.display_name}`,
                          // Deep link that opens the Edit Client drawer on the
                          // detail page (?edit=true, handled by that route).
                          onSelect: () =>
                            navigate({
                              to: "/clients/$clientId",
                              params: { clientId: c.id },
                              search: { edit: true },
                            }),
                        }}
                        actions={[
                          {
                            // Existing messaging surface — /messages/$clientId.
                            label: "Message",
                            onSelect: () =>
                              navigate({ to: "/messages/$clientId", params: { clientId: c.id } }),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Churn scoring lives with the client roster it scores (punch list #11). */}
      <div className="relative">
        <AiSection
          title="Churn risk"
          description="Score active clients on skip rate, unpaid invoices, and recency."
        >
          <div className="mb-1 text-right">
            <HelpTip article="churn-score" />
          </div>
          <ChurnPanel />
        </AiSection>
      </div>
    </>
  );
}


/**
 * How much of the book can actually be texted.
 *
 * The consent guard turned texting off for every client who had never been
 * asked — correctly, but silently. Without this the only way to discover the
 * gap is one failed send at a time, and an owner whose reminders stopped going
 * out has no way to find out why from any screen.
 *
 * Shown only when there IS a gap. A banner that says "316 of 316, all good"
 * every day is furniture, and furniture is not read on the day it changes.
 */
function SmsConsentBanner() {
  const fn = useServerFn(getSmsConsentCoverage);
  const q = useQuery({ queryKey: ["sms-consent-coverage"], queryFn: () => fn() });
  const d = q.data;
  if (!d || d.withPhone === 0) return null;

  const missing = d.withPhone - d.consented;
  if (missing <= 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <MessageSquareOff className="h-4 w-4 shrink-0" />
      <span>
        <strong>
          {missing} of {d.withPhone}
        </strong>{" "}
        clients with a phone number have no texting consent on file, so reminders and
        notifications will not reach them.
      </span>
      {/* Says what to do, not just what is wrong. Both routes are real: the
          client opts in from their portal, or you record consent you already
          hold on their Communication tab. */}
      <span className="text-amber-800 dark:text-amber-300">
        Ask them to opt in from their portal, or record consent you already have on a
        client&apos;s Communication tab.
      </span>
    </div>
  );
}
