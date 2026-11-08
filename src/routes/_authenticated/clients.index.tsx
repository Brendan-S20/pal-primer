import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ListSkeleton } from "@/components/PageSkeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { PullToRefresh } from "@/components/motion/PullToRefresh";
import { RowActions } from "@/components/RowActions";
import { AiSection, ChurnPanel } from "@/components/ai/AiPanels";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  bulkTagClients,
  getSmsConsentCoverage,
  listClientsPage,
  listClientsSummary,
  updateClient,
} from "@/lib/clients.functions";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useRowSelection } from "@/hooks/useRowSelection";
import { useMyRole, usePermissions } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import { DismissButton } from "@/components/DismissButton";
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
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  MessageSquareOff,
  Search,
  Tag,
  Users,
} from "lucide-react";
import { downloadCsv } from "@/lib/csv";
import { HelpTip } from "@/components/HelpTip";
import { titleHead } from "@/lib/page-title";
import { useClientTexting } from "@/hooks/useClientTexting";
import { useMotionList } from "@/lib/motion/use-motion-list";
import { CLIENTS_PAGE_SIZE } from "@/lib/client-roster";

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

/** A tile value while the list loads. text-2xl is a 2rem line box, so the bone
 *  is h-8: the tile keeps its height when the number replaces it, and the list
 *  under the tiles does not move. (KpiValueBone is sized for text-3xl.) */
function TileValueBone() {
  return <Skeleton className="h-8 w-20" />;
}

function ClientsList() {
  const motionList = useMotionList<HTMLDivElement>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fn = useServerFn(listClientsPage);
  const summaryFn = useServerFn(listClientsSummary);
  const updateFn = useServerFn(updateClient);
  const { can } = usePermissions();
  const rowTexting = useClientTexting();
  // Archiving is a manager-class write (updateClient enforces this
  // server-side when `active` changes) — hide the bulk button for roles
  // that would only get an error.
  const canArchive = can("manage_client_billing");
  const { confirm, dialog } = useConfirmDialog();
  const [q, setQ] = useState("");
  // The search runs on the server now (#617), so the box shows every
  // keystroke at once and the request waits for a pause in the typing.
  // What is being looked for and which page of it, as one value. A filter
  // change puts the page back to the first in the SAME update: as two state
  // updates (the filter, then an effect resetting the page) the old page of
  // the new filter was fetched first, and then the first page again.
  const [view, setView] = useState({
    searched: "",
    status: "all" as StatusFilter,
    type: "all" as TypeFilter,
    tag: "all",
    offset: 0,
  });
  const { searched, status, type, tag, offset } = view;
  const setFilter = (patch: Partial<Omit<typeof view, "offset">>) =>
    setView((v) => ({ ...v, ...patch, offset: 0 }));
  const setStatus = (status: StatusFilter) => setFilter({ status });
  const setType = (type: TypeFilter) => setFilter({ type });
  const setTag = (tag: string) => setFilter({ tag });
  const setOffset = (offset: number) => setView((v) => ({ ...v, offset }));
  useEffect(() => {
    const t = setTimeout(() => {
      const next = q.trim();
      setView((v) => (v.searched === next ? v : { ...v, searched: next, offset: 0 }));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // One page at a time, filtered and searched on the server (#617). The page
  // used to receive the whole roster; past ~1,000 clients the reads behind it
  // put every client id in a URL, were refused as "URI too long", and the page
  // and every client picker went empty.
  //
  // The tiles and the tag list are the whole book. They are asked for once,
  // not with every page, filter and keystroke: that was the full-book read
  // the page did each time until the second round of #617.
  const summaryQ = useQuery({
    queryKey: ["clients", "summary"],
    queryFn: () => summaryFn(),
    staleTime: 60_000,
    throwOnError: (_error, query) => query.state.data === undefined,
  });
  const summary = summaryQ.data;
  const tagSpellings =
    tag !== "all" ? summary?.tagSpellings?.[tag.toLowerCase()] : undefined;
  const filters = { q: searched, status, type, tag, tagSpellings };
  const { data, isLoading } = useQuery({
    queryKey: ["clients", "page", { q: searched, status, type, tag }, offset],
    queryFn: () => fn({ data: { ...filters, offset, limit: CLIENTS_PAGE_SIZE } }),
    placeholderData: keepPreviousData,
    // A tag filter waits for the spellings it is sent with.
    enabled: tag === "all" || !!summary,
    throwOnError: (_error, query) => query.state.data === undefined,
  });

  const filtered = (data?.rows ?? []) as any[];
  const matched = data?.matched ?? 0;
  // The tiles describe the whole book, whatever the filters say.
  const stats = summary?.stats ?? {
    total: 0,
    active: 0,
    outstanding: 0,
    owedTotal: 0,
    atRisk: 0,
    noPlan: 0,
  };
  // Every tag in use, for the filter: tags came in by the hundred once
  // imports carried Jobber's Tags column across, and nothing could find them.
  const allTags: string[] = summary?.tags ?? [];

  // Export CSV is every row the filters match, not just this page.
  const [exporting, setExporting] = useState(false);
  const exportAll = async () => {
    setExporting(true);
    try {
      const all = await fn({ data: { ...filters, all: true } });
      exportClientsCsv(all.rows);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  // Multi-select over the currently filtered rows (desktop table). Selection
  // clears whenever a filter changes so a bulk action never hits hidden rows.
  const visibleIds = useMemo(() => filtered.map((c: any) => c.id as string), [filtered]);
  const sel = useRowSelection(visibleIds, `${searched}|${status}|${type}|${tag}|${offset}`);
  const pageSelection = useMemo(
    () => filtered.filter((c: any) => sel.isSelected(c.id)),
    [filtered, sel],
  );
  // "Select all N matching" (#617 review, S2): the header box ticks one page
  // of 50, and with paging that is all it can tick. This is every client the
  // filters match, read when asked for, and dropped when a filter changes.
  const [allMatching, setAllMatching] = useState<any[] | null>(null);
  useEffect(() => setAllMatching(null), [searched, status, type, tag]);
  const selectedRows: any[] = allMatching ?? pageSelection;
  const selectedIds = useMemo(() => selectedRows.map((c: any) => c.id as string), [selectedRows]);
  const selectedCount = selectedRows.length;
  const clearSelection = () => {
    setAllMatching(null);
    sel.clear();
  };
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const all = await fn({ data: { ...filters, all: true } });
      setAllMatching(all.rows);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSelectingAll(false);
    }
  };

  // Bulk archive loops the existing per-client updateClient fn (same
  // permission gate + per-client activity log as the edit drawer).
  const archiveM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await settleInBatches(ids, (id) =>
        updateFn({ data: { clientId: id, active: false } }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed) toast.error(`Archived ${r.ok} of ${r.ok + r.failed} clients, ${r.failed} failed`);
      else toast.success(`Archived ${r.ok} client${r.ok === 1 ? "" : "s"}`);
      clearSelection();
      qc.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Lift the imported-clients communications hold in bulk — same per-client
  // updateClient fn (and activity log) as the client-header toggle.
  const resumeCommsM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await settleInBatches(ids, (id) =>
        updateFn({ data: { clientId: id, commsPaused: false } }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Resumed communications for ${r.ok} of ${r.ok + r.failed} clients, ${r.failed} failed`);
      else toast.success(`Resumed communications for ${r.ok} client${r.ok === 1 ? "" : "s"}`);
      clearSelection();
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
  // bulkTagClients takes 500 ids a call; "all matching" can be thousands.
  const tagSelected = async (v: { action: "add" | "remove"; tag: string }) => {
    let changed = 0;
    for (let i = 0; i < selectedIds.length; i += 500) {
      const r = await tagFn({ data: { ids: selectedIds.slice(i, i + 500), tag: v.tag, action: v.action } });
      changed += r.changed;
    }
    return { changed };
  };
  const tagM = useMutation({
    mutationFn: (v: { action: "add" | "remove"; tag: string }) =>
      tagSelected(v),
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
      <PullToRefresh />
      {dialog}
      <Dialog open={tagAction != null} onOpenChange={(o) => !o && setTagAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {tagAction === "remove" ? "Remove a tag" : "Add a tag"} ({selectedCount} selected)
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
          <div className="text-sm text-muted-foreground">
            {!summary ? <Skeleton className="h-5 w-36" /> : `${stats.total} total · ${stats.active} active`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={!matched || exporting}
            onClick={exportAll}
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
          <div className="mt-1 text-2xl font-semibold">{!summary ? <TileValueBone /> : stats.active}</div>
        </Card>
        <Card className="@container min-w-0 p-4">
          <div className="text-xs text-muted-foreground">Outstanding</div>
          {/* A book of thousands owes six figures: "$340,125.00" in text-2xl is
              wider than half a 360px phone. On the same 2rem line box as the
              bone, so the list under the tiles does not move when the number
              lands — but only if the number stays on ONE line, and whether
              it does depends on the font, which is the system's. In DejaVu
              Sans (a stock Linux runner) it wrapped at 320, 360, 768 and
              900px, and the list jumped 32px. So the size follows the tile's
              own width (12cqi: an 11-character amount is ~7.7em in the
              widest common sans), capped at text-lg / text-2xl. Wrapping
              stays as the last resort for an amount longer than that. */}
          <div className="mt-1 text-[length:min(1.125rem,12cqi)] leading-8 font-semibold [overflow-wrap:anywhere] sm:text-[length:min(1.5rem,12cqi)]">
            {!summary ? <TileValueBone /> : money(stats.owedTotal)}
          </div>
          <div className="text-xs text-muted-foreground">{!summary ? <Skeleton className="h-4 w-20" /> : `${stats.outstanding} clients`}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0" /> At churn risk
          </div>
          <div className="mt-1 text-2xl font-semibold">{!summary ? <TileValueBone /> : stats.atRisk}</div>
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
          <div
            className={`mt-1 text-2xl font-semibold ${stats.noPlan > 0 ? "text-amber-600" : ""}`}
          >
            {!summary ? <TileValueBone /> : stats.noPlan}
          </div>
          <div className="text-xs text-muted-foreground">
            {!summary ? <Skeleton className="h-4 w-20" /> : `${stats.total - stats.active} archived`}
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground shrink-0" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, company, email, phone or street…"
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
        {/* While the list loads nobody knows yet whether there are tags, and
            on a phone this filter is a row of its own: hold its place, so the
            list does not drop 52px when the clients arrive. */}
        {summaryQ.isLoading ? (
          <Skeleton aria-hidden="true" className="h-9 w-44 touch:h-11" />
        ) : allTags.length > 0 && (
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
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">
              {allMatching
                ? `All ${selectedCount.toLocaleString("en-US")} matching selected`
                : `${selectedCount} selected`}
            </span>
            {/* Past one page, say so and offer the rest, rather than act on
                50 of 5,000 without a word. */}
            {!allMatching && sel.allSelected && matched > filtered.length && (
              <Button
                size="sm"
                variant="link"
                className="h-auto px-0"
                disabled={selectingAll}
                onClick={selectAllMatching}
              >
                {selectingAll
                  ? "Selecting…"
                  : `Select all ${matched.toLocaleString("en-US")} matching`}
              </Button>
            )}
          </div>
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
                      title: `Archive ${selectedCount} client${selectedCount === 1 ? "" : "s"}?`,
                      description:
                        "They are marked inactive. You can reactivate a client anytime from their page.",
                      destructive: true,
                      confirmLabel: "Archive",
                    })
                  )
                    archiveM.mutate(selectedIds);
                }}
              >
                {archiveM.isPending ? "Archiving…" : "Archive"}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {!data ? (
        <ListSkeleton breakpoint="sm" columns={7} />
      ) : !filtered.length ? (
        <div className="rounded-lg border border-dashed bg-card p-10 text-center">
          <p className="text-muted-foreground">
            {stats.total ? "No clients match those filters." : "No clients yet."}
          </p>
          {!stats.total && (
            <Link to="/clients/new" className="mt-3 inline-block">
              <Button size="sm">Create the first one</Button>
            </Link>
          )}
        </div>
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div ref={motionList} className="motion-list space-y-3 sm:hidden">
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
                    {/* No line at all for a client with no email: a lone dash
                        under the name read as a rendering fault on a phone. The
                        desktop table keeps its "-", where a column needs a cell. */}
                    {c.primary_email && (
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {c.primary_email}
                      </div>
                    )}
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
                  <span>
                    {c.dog_count} {c.dog_count === 1 ? "dog" : "dogs"}
                    {c.dog_count_source === "plan" && " (names not on file)"}
                  </span>
                  <span>
                    {c.active_subscription_count}{" "}
                    {c.active_subscription_count === 1 ? "plan" : "plans"}
                  </span>
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
                      checked={allMatching ? true : sel.allSelected}
                      onCheckedChange={() => {
                        setAllMatching(null);
                        sel.toggleAll();
                      }}
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
                        checked={allMatching ? true : sel.isSelected(c.id)}
                        onCheckedChange={(next) => {
                          // Unticking a row ends "all matching": the bar goes
                          // back to what is ticked on this page.
                          if (allMatching) {
                            setAllMatching(null);
                            if (!next) {
                              sel.toggle(c.id, false);
                              return;
                            }
                          }
                          sel.toggle(c.id, !!next);
                        }}
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
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.dog_count}
                      {/* Counted from the plan: no dog records yet (#429). */}
                      {c.dog_count_source === "plan" && (
                        <span className="block whitespace-nowrap text-2xs">names not on file</span>
                      )}
                    </td>
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
                      {/* A dash only when there is nothing at all to show,
                          not above a phone number as a line of its own. */}
                      {c.primary_email ? (
                        <div className="truncate max-w-[220px]">{c.primary_email}</div>
                      ) : !c.primary_phone ? (
                        <div>-</div>
                      ) : null}
                      {c.primary_phone && <div className="text-xs">{c.primary_phone}</div>}
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
                        // Message only where this business can text; until
                        // then the thread page is a coming-soon dead end.
                        actions={
                          rowTexting
                            ? [
                                {
                                  label: "Message",
                                  onSelect: () =>
                                    navigate({
                                      to: "/messages/$clientId",
                                      params: { clientId: c.id },
                                    }),
                                },
                              ]
                            : []
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ClientsPager
            offset={data?.offset ?? offset}
            shown={filtered.length}
            matched={matched}
            onPage={(next) => {
              setOffset(next);
              window.scrollTo({ top: 0 });
            }}
          />
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


/** Run `fn` over every id, 20 at a time. "All matching" can be thousands of
 *  clients, and thousands of requests at once is a burst nothing should get. */
async function settleInBatches<T>(
  ids: string[],
  fn: (id: string) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    out.push(...(await Promise.allSettled(ids.slice(i, i + 20).map(fn))));
  }
  return out;
}

/** "1-50 of 5,000" with Previous and Next. Paged on the server (#617). */
function ClientsPager({
  offset,
  shown,
  matched,
  onPage,
}: {
  offset: number;
  shown: number;
  matched: number;
  onPage: (offset: number) => void;
}) {
  if (matched <= CLIENTS_PAGE_SIZE) return null;
  const first = offset + 1;
  const last = offset + shown;
  const fmt = (n: number) => n.toLocaleString("en-US");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">
        {fmt(first)}-{fmt(last)} of {fmt(matched)}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - CLIENTS_PAGE_SIZE))}
        >
          <ChevronLeft className="me-1 h-4 w-4 shrink-0" /> Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={last >= matched}
          onClick={() => onPage(offset + CLIENTS_PAGE_SIZE)}
        >
          Next <ChevronRight className="ms-1 h-4 w-4 shrink-0" />
        </Button>
      </div>
    </div>
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
 *
 * DISMISSIBLE SINCE 2026-10-03, pinned to the two numbers it states. Once the
 * owner has read "56 of 198" it can go; it comes back when either number
 * moves (a new client without consent, one who opted in, a phone added), which
 * is exactly the day it has something new to say. No timed snooze: an
 * unchanged gap is not news. Rule in src/lib/dismissible.ts.
 */
function SmsConsentBanner() {
  const fn = useServerFn(getSmsConsentCoverage);
  const q = useQuery({ queryKey: ["sms-consent-coverage"], queryFn: () => fn() });
  const { orgId } = useMyRole();
  const texting = useClientTexting();
  const d = q.data;
  const missing = d ? d.withPhone - d.consented : 0;
  const { dismissed, dismiss } = useDismissed(
    "sms-consent-gap",
    d && d.withPhone > 0 && missing > 0 ? `${missing}/${d.withPhone}` : null,
    { orgId },
  );
  if (!d || d.withPhone === 0) return null;
  if (missing <= 0) return null;
  if (dismissed) return null;

  return (
    <div className="flex items-start gap-1 rounded-lg border border-amber-300 bg-amber-50 py-3 ps-3 pe-1 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <MessageSquareOff className="h-4 w-4 shrink-0" />
        <span>
          <strong>
            {missing} of {d.withPhone}
          </strong>{" "}
          clients with a phone number have no texting consent on file,{" "}
          {texting
            ? "so reminders and notifications will not reach them."
            : "so they won't get texts when texting your clients arrives (coming soon)."}
        </span>
        {/* Says what to do, not just what is wrong. Both routes are real: the
            client opts in from their portal, or you record consent you already
            hold on their Communication tab. */}
        <span className="text-amber-800 dark:text-amber-300">
          Ask them to opt in from their portal, or record consent you already have on a
          client&apos;s Communication tab.
        </span>
      </div>
      <DismissButton
        onClick={dismiss}
        label="Hide the texting consent notice"
        className="-my-3"
      />
    </div>
  );
}
