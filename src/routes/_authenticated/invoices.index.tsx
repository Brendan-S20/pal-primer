import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listInvoices,
  generateInvoicesForOrg,
  createManualInvoice,
  bulkVoidInvoices,
  bulkMarkInvoicesPaid,
  voidInvoice,
} from "@/lib/invoices.functions";
import { sendInvoiceEmail } from "@/lib/notifications.functions";
import { formatDay } from "@/lib/format";
import { listClients } from "@/lib/clients.functions";
import { getMyOrg } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Download, FileText, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv";
import { HelpTip } from "@/components/HelpTip";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { EmptyState, SectionLabel } from "@/components/client-detail/primitives";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { InvoiceCard, InvoiceRow } from "@/components/InvoiceRow";
import type { RowAction } from "@/components/RowActions";
import { invoiceOutstandingCents } from "@/lib/ar";
import { useRowSelection } from "@/hooks/useRowSelection";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/invoices/")({
  component: InvoicesPage,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format((c ?? 0) / 100);
}

const STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
type StatusKey = (typeof STATUSES)[number] | "all";

function statusLabel(s: StatusKey) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** P3.1 quick charge — bill a client right now, no visit required. */
function NewInvoiceDialog() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const clientsFn = useServerFn(listClients);
  const createFn = useServerFn(createManualInvoice);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [items, setItems] = useState<Array<{ description: string; amount: string }>>([
    { description: "", amount: "" },
  ]);

  const clientsQ = useQuery({
    queryKey: ["clients", "picker"],
    queryFn: () => clientsFn(),
    enabled: open,
    staleTime: 60_000,
  });
  const clients: Array<{ id: string; display_name: string; active: boolean }> =
    (clientsQ.data as any)?.clients ?? (clientsQ.data as any) ?? [];

  const parsedItems = items
    .map((i) => ({
      description: i.description.trim(),
      amountCents: Math.round((parseFloat(i.amount) || 0) * 100),
    }))
    .filter((i) => i.description && i.amountCents > 0);
  const totalCents = parsedItems.reduce((s, i) => s + i.amountCents, 0);

  const createM = useMutation({
    mutationFn: () => createFn({ data: { clientId, items: parsedItems } }),
    onSuccess: (r) => {
      toast.success(`Invoice created: ${fmtCents(r.totalCents)}`);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setOpen(false);
      setClientId("");
      setItems([{ description: "", amount: "" }]);
      navigate({ to: "/invoices/$invoiceId", params: { invoiceId: r.invoiceId } });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> New invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New invoice</DialogTitle>
          <DialogDescription>
            Bill a client directly, no visit needed. The invoice opens immediately and is payable
            from their portal or a checkout link.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Client</label>
            <select
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">Select a client…</option>
              {clients
                .filter((c) => c.active !== false)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                  </option>
                ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Line items</label>
            {items.map((item, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="Description (e.g. One-time cleanup)"
                  value={item.description}
                  onChange={(e) =>
                    setItems(
                      items.map((it, j) => (j === i ? { ...it, description: e.target.value } : it)),
                    )
                  }
                />
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  className="w-28"
                  value={item.amount}
                  onChange={(e) =>
                    setItems(
                      items.map((it, j) => (j === i ? { ...it, amount: e.target.value } : it)),
                    )
                  }
                />
                {items.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 px-2"
                    onClick={() => setItems(items.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setItems([...items, { description: "", amount: "" }])}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add line
            </Button>
          </div>
          {totalCents > 0 && <p className="text-sm font-medium">Total: {fmtCents(totalCents)}</p>}
        </div>
        <DialogFooter>
          <Button
            disabled={!clientId || parsedItems.length === 0 || createM.isPending}
            onClick={() => createM.mutate()}
          >
            {createM.isPending
              ? "Creating…"
              : `Create invoice${totalCents > 0 ? ` · ${fmtCents(totalCents)}` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Clickable summary stat: clicking applies (or clears) the matching status filter. */
function StatCard({
  label,
  value,
  sub,
  active,
  destructive = false,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  active: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/30",
        destructive && "border-destructive/30 bg-destructive/5 hover:bg-destructive/10",
        active && "ring-2 ring-primary/50",
      )}
    >
      <SectionLabel>{label}</SectionLabel>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          destructive && "text-destructive",
        )}
      >
        {value}
      </div>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </button>
  );
}

function InvoicesPage() {
  const { confirm, dialog } = useConfirmDialog();
  const list = useServerFn(listInvoices);
  const orgFn = useServerFn(getMyOrg);
  const gen = useServerFn(generateInvoicesForOrg);
  const voidBulk = useServerFn(bulkVoidInvoices);
  const paidBulk = useServerFn(bulkMarkInvoicesPaid);
  const voidOne = useServerFn(voidInvoice);
  const emailFn = useServerFn(sendInvoiceEmail);
  const qc = useQueryClient();

  const [through, setThrough] = useState(() => new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState<StatusKey>("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Row click opens the shared invoice drawer (QA round 8) instead of
  // navigating away; "Open full invoice" inside goes to the page.
  const [drawerInvoiceId, setDrawerInvoiceId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const orgQ = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn() });
  const invQ = useQuery({ queryKey: ["invoices"], queryFn: () => list() });

  const genM = useMutation({
    mutationFn: async () => {
      const org = orgQ.data?.organization;
      if (!org) throw new Error("No organization");
      return gen({ data: { orgId: org.id, through } });
    },
    onSuccess: (r) => {
      // "Generated 0 invoice(s)" with success styling read as "nothing is
      // owed" to a first-time operator (P3.1) — say what it actually means.
      if (r.generated === 0) {
        toast.info(
          "No invoices to generate. This bills completed, unbilled visits. To charge a client directly, use New invoice.",
          { duration: 8000 },
        );
      } else {
        toast.success(`Generated ${r.generated} invoice(s)`);
      }
      setAdvancedOpen(false);
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const stats = useMemo(() => {
    const all = invQ.data ?? [];
    const monthPrefix = new Date().toISOString().slice(0, 7);
    let outstandingCents = 0;
    let openCount = 0;
    let paidThisMonthCents = 0;
    let paidThisMonthCount = 0;
    let draftCount = 0;
    for (const inv of all) {
      if (inv.status === "open") {
        openCount += 1;
        // Shared AR math (B1): open balance net of applied credit, identical
        // to the Dashboard "AR open" card and Reports "Outstanding".
        outstandingCents += invoiceOutstandingCents(inv as any);
      } else if (inv.status === "paid") {
        const paidDay = (inv.paid_at ?? inv.period_end ?? "").slice(0, 7);
        if (paidDay === monthPrefix) {
          paidThisMonthCents += inv.total_cents ?? 0;
          paidThisMonthCount += 1;
        }
      } else if (inv.status === "draft") {
        draftCount += 1;
      }
    }
    return { outstandingCents, openCount, paidThisMonthCents, paidThisMonthCount, draftCount };
  }, [invQ.data]);

  const toggleStatusFilter = (s: StatusKey) => setStatus((prev) => (prev === s ? "all" : s));

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (invQ.data ?? []).filter((inv) => {
      if (status !== "all" && inv.status !== status) return false;
      if (from && (inv.period_end ?? "") < from) return false;
      if (to && (inv.period_end ?? "") > to) return false;
      if (s) {
        const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
        const name = (client?.display_name ?? "").toLowerCase();
        if (!name.includes(s)) return false;
      }
      return true;
    });
  }, [invQ.data, status, search, from, to]);

  const filtersActive = Boolean(search || from || to || status !== "all");
  const resetFilters = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setStatus("all");
  };

  // Shared multi-select hook (same plumbing as Clients / Leads / Visits).
  // Selection clears whenever a filter changes so a bulk void/mark-paid never
  // silently mutates rows that were filtered out of view.
  const visibleIds = useMemo(() => filtered.map((i) => i.id), [filtered]);
  const sel = useRowSelection(visibleIds, `${status}|${search}|${from}|${to}`);
  const { selectedIds, allSelected: allVisibleSelected, toggleAll } = sel;
  const selectedRows = useMemo(
    () => filtered.filter((i) => sel.isSelected(i.id)),
    [filtered, sel],
  );
  const totalSelected = selectedRows.reduce((sum, i) => sum + (i.total_cents ?? 0), 0);
  const selectedOpen = selectedRows.filter((i) => i.status === "open");

  // A void/paid changes every money surface at once — refresh the summary
  // cards too, not just the table.
  const refreshMoney = () => {
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    qc.invalidateQueries({ queryKey: ["billing-summary"] });
  };

  const voidM = useMutation({
    mutationFn: () => voidBulk({ data: { ids: selectedIds } }),
    onSuccess: (r) => {
      // All-fail must not read as green success.
      if (r.failed) toast.error(`Voided ${r.ok} of ${r.ok + r.failed} — ${r.failed} skipped`);
      else toast.success(`Voided ${r.ok}`);
      sel.clear();
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const paidM = useMutation({
    mutationFn: () => paidBulk({ data: { ids: selectedIds } }),
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Marked ${r.ok} of ${r.ok + r.failed} paid — ${r.failed} skipped`);
      else toast.success(`Marked ${r.ok} paid`);
      sel.clear();
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Bulk send: loops the existing single-invoice sendInvoiceEmail over the
  // selected OPEN invoices (draft/paid/void rows are skipped) — same server
  // fn + permission gate as the per-row "Send to client" action.
  const sendM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((invoiceId) => emailFn({ data: { invoiceId, reminder: false } })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Sent ${r.ok} of ${r.ok + r.failed} invoice emails — ${r.failed} failed`);
      else toast.success(`Queued ${r.ok} invoice email${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const exportSelectedCsv = () =>
    downloadCsv(
      `invoices-selected-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        "Invoice ID",
        "Client",
        "Status",
        "Period start",
        "Period end",
        "Total",
        "Issued",
        "Due",
        "Paid",
      ],
      selectedRows.map((inv) => {
        const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
        return [
          inv.id,
          client?.display_name ?? "",
          inv.status,
          inv.period_start ?? "",
          inv.period_end ?? "",
          ((inv.total_cents ?? 0) / 100).toFixed(2),
          (inv.issued_at ?? "").slice(0, 10),
          inv.due_on ?? "",
          (inv.paid_at ?? "").slice(0, 10),
        ];
      }),
    );

  // ── Per-row ••• actions (Salesforce-style row actions) ────────────────────
  // These reuse the exact server fns the drawer / bulk bar already use:
  // sendInvoiceEmail, bulkMarkInvoicesPaid (with one id), voidInvoice.
  const rowEmailM = useMutation({
    mutationFn: (v: { invoiceId: string; reminder: boolean }) => emailFn({ data: v }),
    onSuccess: (r: any, v) => {
      toast.success(`${v.reminder ? "Reminder" : "Invoice"} queued for ${r.recipient ?? "the client"}`);
      // A first send stamps sent_at — refresh so the row chips update.
      if (!v.reminder) qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rowPaidM = useMutation({
    mutationFn: (id: string) => paidBulk({ data: { ids: [id] } }),
    onSuccess: (r) => {
      if (r.ok) toast.success("Invoice marked paid");
      else toast.error("Invoice could not be marked paid");
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rowVoidM = useMutation({
    mutationFn: (id: string) => voidOne({ data: { id } }),
    onSuccess: () => {
      toast.success("Invoice voided");
      refreshMoney();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /** ••• items for one row; open invoices only (mirrors the drawer's gating).
   *  "Open full invoice" + "Copy pay link" are built into InvoiceRow itself. */
  const rowActions = (inv: (typeof filtered)[number]): RowAction[] => {
    if (inv.status !== "open") return [];
    const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
    const busy = rowEmailM.isPending || rowPaidM.isPending || rowVoidM.isPending;
    return [
      {
        label: inv.sent_at ? "Send to client" : inv.send_after ? "Send now" : "Send to client",
        disabled: busy,
        onSelect: async () => {
          // Same grace-window bypass confirm as the drawer: emailing a held
          // invoice force-sends it ahead of its scheduled date.
          if (!inv.sent_at && inv.send_after) {
            const ok = await confirm({
              title: "Send this invoice now?",
              description: `This emails the invoice to ${client?.display_name ?? "the client"} right away, ahead of its scheduled send date (${formatDay(inv.send_after)}). It won't be sent again automatically.`,
              confirmLabel: "Send now",
            });
            if (!ok) return;
          }
          rowEmailM.mutate({ invoiceId: inv.id, reminder: false });
        },
      },
      {
        label: "Send reminder",
        disabled: busy,
        onSelect: () => rowEmailM.mutate({ invoiceId: inv.id, reminder: true }),
      },
      {
        label: "Mark paid",
        disabled: busy,
        onSelect: async () => {
          if (
            await confirm({
              title: "Mark this invoice paid?",
              description:
                "Records an out-of-band payment for the open balance (cash, check, etc.). This can't be undone here.",
              confirmLabel: "Mark paid",
            })
          )
            rowPaidM.mutate(inv.id);
        },
      },
      {
        label: "Void",
        destructive: true,
        disabled: busy,
        onSelect: async () => {
          if (
            await confirm({
              title: "Void this invoice?",
              description:
                "Voiding removes this invoice from the client's balance and can't be undone.",
              destructive: true,
              confirmLabel: "Void invoice",
            })
          )
            rowVoidM.mutate(inv.id);
        },
      },
    ];
  };

  return (
    <div className="space-y-6">
      {dialog}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Invoices</h1>
          <p className="text-sm text-muted-foreground">
            Invoices generate automatically on each client's cadence.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            disabled={!filtered.length}
            onClick={() =>
              downloadCsv(
                `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
                [
                  "Invoice ID",
                  "Client",
                  "Status",
                  "Period start",
                  "Period end",
                  "Total",
                  "Issued",
                  "Due",
                  "Paid",
                ],
                filtered.map((inv) => {
                  const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
                  return [
                    inv.id,
                    client?.display_name ?? "",
                    inv.status,
                    inv.period_start ?? "",
                    inv.period_end ?? "",
                    ((inv.total_cents ?? 0) / 100).toFixed(2),
                    (inv.issued_at ?? "").slice(0, 10),
                    inv.due_on ?? "",
                    (inv.paid_at ?? "").slice(0, 10),
                  ];
                }),
              )
            }
          >
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
          {/* Full auto billing: generation runs nightly on each client's
              cadence, so manual generate-from-visits is demoted to an
              overflow dialog kept as a fallback. */}
          <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Advanced invoicing actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Generate from visits (manual fallback)</DialogTitle>
                <DialogDescription>
                  Invoices generate automatically on each client's cadence, so you normally never
                  need this. Use it to bill all unbilled completed visits through a date right
                  now, for example before changing a client's cadence.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-end gap-2">
                <div>
                  <label htmlFor="invoices-through" className="text-xs text-muted-foreground">
                    Through
                  </label>
                  <Input
                    id="invoices-through"
                    type="date"
                    className="h-9 w-40"
                    value={through}
                    onChange={(e) => setThrough(e.target.value)}
                  />
                </div>
                <HelpTip article="generate-invoices" />
              </div>
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={() => genM.mutate()}
                  disabled={genM.isPending}
                >
                  {genM.isPending ? "Generating…" : "Generate from visits"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <NewInvoiceDialog />
        </div>
      </div>

      {/* Summary stats — click one to filter by that status */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Outstanding"
          value={fmtCents(stats.outstandingCents)}
          sub="Awaiting payment"
          destructive={stats.outstandingCents > 0}
          active={status === "open"}
          onClick={() => toggleStatusFilter("open")}
        />
        <StatCard
          label="Open invoices"
          value={String(stats.openCount)}
          sub={stats.openCount === 1 ? "1 invoice open" : `${stats.openCount} invoices open`}
          active={status === "open"}
          onClick={() => toggleStatusFilter("open")}
        />
        <StatCard
          label="Paid this month"
          value={fmtCents(stats.paidThisMonthCents)}
          sub={
            stats.paidThisMonthCount === 1
              ? "1 invoice paid"
              : `${stats.paidThisMonthCount} invoices paid`
          }
          active={status === "paid"}
          onClick={() => toggleStatusFilter("paid")}
        />
        {stats.draftCount > 0 && (
          <StatCard
            label="Drafts"
            value={String(stats.draftCount)}
            sub="Not yet issued"
            active={status === "draft"}
            onClick={() => toggleStatusFilter("draft")}
          />
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3 shadow-sm">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="invoices-search" className="text-xs text-muted-foreground">
            Search client
          </label>
          <Input
            id="invoices-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Client name…"
          />
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Status</span>
          <div className="flex flex-wrap gap-1">
            {(["all", ...STATUSES] as StatusKey[]).map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={status === s ? "default" : "outline"}
                onClick={() => setStatus(s)}
              >
                {statusLabel(s)}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="invoices-from" className="text-xs text-muted-foreground">
            Period from
          </label>
          <Input
            id="invoices-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="invoices-to" className="text-xs text-muted-foreground">
            Period to
          </label>
          <Input id="invoices-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={resetFilters}>
            Reset
          </Button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="flex items-center justify-between rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
          <div>
            <span className="font-medium">{selectedIds.length} selected</span>
            <span className="ml-3 tabular-nums text-muted-foreground">
              Total {fmtCents(totalSelected)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={exportSelectedCsv}>
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={sendM.isPending || selectedOpen.length === 0}
              title={
                selectedOpen.length === 0 ? "Only open invoices can be emailed" : undefined
              }
              onClick={async () => {
                const skipped = selectedIds.length - selectedOpen.length;
                if (
                  await confirm({
                    title: `Send ${selectedOpen.length} invoice${selectedOpen.length === 1 ? "" : "s"}?`,
                    description: `Emails each open invoice to its client now${
                      skipped ? `. ${skipped} non-open selected invoice${skipped === 1 ? " is" : "s are"} skipped` : ""
                    }.`,
                    confirmLabel: "Send invoices",
                  })
                )
                  sendM.mutate(selectedOpen.map((i) => i.id));
              }}
            >
              {sendM.isPending ? "Sending…" : "Send invoices"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                // Same confirm as the per-row action — this moves money.
                if (
                  await confirm({
                    title: `Mark ${selectedIds.length} invoice${selectedIds.length === 1 ? "" : "s"} paid?`,
                    description:
                      "Records an out-of-band payment (cash, check, etc.) for each open balance. This can't be undone here.",
                    confirmLabel: "Mark paid",
                  })
                )
                  paidM.mutate();
              }}
              disabled={paidM.isPending}
            >
              Mark paid
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Void ${selectedIds.length} invoice(s)?`,
                    destructive: true,
                    confirmLabel: "Void invoices",
                  })
                )
                  voidM.mutate();
              }}
              disabled={voidM.isPending}
            >
              Void
            </Button>
            <Button size="sm" variant="ghost" onClick={sel.clear}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {invQ.isLoading ? (
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={filtersActive ? "No invoices match" : "No invoices yet"}
          description={
            filtersActive
              ? "Try widening the search, status, or period filters."
              : "Invoices generate automatically when each client's billing cycle ends. Use New invoice to bill a client directly."
          }
          actionLabel={filtersActive ? "Reset filters" : undefined}
          onAction={filtersActive ? resetFilters : undefined}
        />
      ) : (
        <>
          {/* Mobile Phase 2: below `md` invoices render as tap-through cards
              (shared InvoiceCard — same data, ••• actions, and drawer as the
              table rows). Bulk-select stays via the card checkbox. */}
          <div className="space-y-3 md:hidden">
            <label className="flex min-h-10 items-center gap-2 px-1 text-xs text-muted-foreground">
              <Checkbox
                checked={allVisibleSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all invoices"
              />
              Select all
            </label>
            {filtered.map((inv) => (
              <InvoiceCard
                key={inv.id}
                invoice={inv}
                selectable
                selected={sel.isSelected(inv.id)}
                onToggleSelect={(next) => sel.toggle(inv.id, next)}
                onOpen={setDrawerInvoiceId}
                actions={rowActions(inv)}
              />
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border bg-card shadow-sm max-md:hidden">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 px-4 py-2">
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all invoices"
                  />
                </th>
                <th className="px-4 py-2 font-semibold">Client</th>
                <th className="px-4 py-2 font-semibold">Invoice</th>
                <th className="px-4 py-2 font-semibold">Period</th>
                <th className="px-4 py-2 font-semibold">Due</th>
                <th className="px-4 py-2 text-right font-semibold">Total</th>
                <th className="px-4 py-2 font-semibold">Status</th>
                <th className="w-28 px-4 py-2 text-right font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  showClient
                  selectable
                  selected={sel.isSelected(inv.id)}
                  onToggleSelect={(next) => sel.toggle(inv.id, next)}
                  onOpen={setDrawerInvoiceId}
                  actions={rowActions(inv)}
                />
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      <InvoiceDrawer
        invoiceId={drawerInvoiceId}
        onClose={() => setDrawerInvoiceId(null)}
        onChanged={() => qc.invalidateQueries({ queryKey: ["invoices"] })}
      />
    </div>
  );
}
