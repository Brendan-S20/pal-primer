import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listInvoices,
  generateInvoicesForOrg,
  createManualInvoice,
  bulkVoidInvoices,
  bulkMarkInvoicesPaid,
} from "@/lib/invoices.functions";
import { listClients } from "@/lib/clients.functions";
import { getMyOrg } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
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
import { Download, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { downloadCsv } from "@/lib/csv";
import { HelpTip } from "@/components/HelpTip";
import { useConfirmDialog } from "@/components/ConfirmDialog";

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

function InvoicesPage() {
  const { confirm, dialog } = useConfirmDialog();
  const list = useServerFn(listInvoices);
  const orgFn = useServerFn(getMyOrg);
  const gen = useServerFn(generateInvoicesForOrg);
  const voidBulk = useServerFn(bulkVoidInvoices);
  const paidBulk = useServerFn(bulkMarkInvoicesPaid);
  const qc = useQueryClient();

  const [through, setThrough] = useState(() => new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState<StatusKey>("all");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});

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
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

  const selectedIds = useMemo(
    () =>
      Object.entries(selected)
        .filter(([, v]) => v)
        .map(([k]) => k),
    [selected],
  );
  const allVisibleSelected = filtered.length > 0 && filtered.every((i) => selected[i.id]);
  const totalSelected = filtered
    .filter((i) => selected[i.id])
    .reduce((sum, i) => sum + (i.total_cents ?? 0), 0);

  const toggleAll = () => {
    if (allVisibleSelected) {
      setSelected({});
    } else {
      const next: Record<string, boolean> = {};
      filtered.forEach((i) => {
        next[i.id] = true;
      });
      setSelected(next);
    }
  };

  const voidM = useMutation({
    mutationFn: () => voidBulk({ data: { ids: selectedIds } }),
    onSuccess: (r) => {
      toast.success(`Voided ${r.ok}${r.failed ? ` (${r.failed} skipped)` : ""}`);
      setSelected({});
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const paidM = useMutation({
    mutationFn: () => paidBulk({ data: { ids: selectedIds } }),
    onSuccess: (r) => {
      toast.success(`Marked ${r.ok} paid${r.failed ? ` (${r.failed} skipped)` : ""}`);
      setSelected({});
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      {dialog}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Invoices</h1>
          <p className="text-sm text-muted-foreground">Bill clients for completed visits.</p>
        </div>
        <div className="flex items-end gap-2">
          <Button
            variant="outline"
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
                    (inv.paid_at ?? "").slice(0, 10),
                  ];
                }),
              )
            }
          >
            <Download className="mr-1 h-4 w-4" /> Export CSV
          </Button>
          <NewInvoiceDialog />
          <div>
            <label className="text-xs text-muted-foreground">Through date</label>
            <Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
          </div>
          <Button variant="outline" onClick={() => genM.mutate()} disabled={genM.isPending}>
            {genM.isPending ? "Generating…" : "Generate from visits"}
          </Button>
          <span className="pb-2">
            <HelpTip article="generate-invoices" />
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <div className="min-w-[200px] flex-1">
          <label className="text-xs text-muted-foreground">Search client</label>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Client name…"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Status</label>
          <div className="flex flex-wrap gap-1">
            {(["all", ...STATUSES] as StatusKey[]).map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant={status === s ? "default" : "outline"}
                onClick={() => setStatus(s)}
              >
                {s}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Period from</label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">to</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {(search || from || to || status !== "all") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setFrom("");
              setTo("");
              setStatus("all");
            }}
          >
            Reset
          </Button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.length > 0 && (
        <div className="flex items-center justify-between rounded-lg border bg-accent/40 px-4 py-2 text-sm">
          <div>
            <span className="font-medium">{selectedIds.length} selected</span>
            <span className="ml-3 text-muted-foreground">Total {fmtCents(totalSelected)}</span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => paidM.mutate()}
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
            <Button size="sm" variant="ghost" onClick={() => setSelected({})}>
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-10 px-4 py-2">
                <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAll} />
              </th>
              <th className="px-4 py-2">Client</th>
              <th className="px-4 py-2">Period</th>
              <th className="px-4 py-2">Total</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {invQ.isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                  No invoices match.
                </td>
              </tr>
            ) : (
              filtered.map((inv) => {
                const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
                const checked = !!selected[inv.id];
                return (
                  <tr key={inv.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => setSelected((prev) => ({ ...prev, [inv.id]: !!v }))}
                      />
                    </td>
                    <td className="px-4 py-2">{client?.display_name ?? "-"}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {inv.period_start ? `${inv.period_start} → ` : ""}
                      {inv.period_end}
                    </td>
                    <td className="px-4 py-2">{fmtCents(inv.total_cents, inv.currency)}</td>
                    <td className="px-4 py-2">
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        to="/invoices/$invoiceId"
                        params={{ invoiceId: inv.id }}
                        className="text-primary hover:underline"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
