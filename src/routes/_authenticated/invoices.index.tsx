import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listInvoices,
  generateInvoicesForOrg,
  bulkVoidInvoices,
  bulkMarkInvoicesPaid,
} from "@/lib/invoices.functions";
import { getMyOrg } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/invoices/")({
  component: InvoicesPage,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format((c ?? 0) / 100);
}

const STATUSES = ["draft", "open", "paid", "void", "uncollectible"] as const;
type StatusKey = (typeof STATUSES)[number] | "all";

function InvoicesPage() {
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
      toast.success(`Generated ${r.generated} invoice(s)`);
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
    () => Object.entries(selected).filter(([, v]) => v).map(([k]) => k),
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
      filtered.forEach((i) => { next[i.id] = true; });
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Invoices</h1>
          <p className="text-sm text-muted-foreground">Bill clients for completed visits.</p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="text-xs text-muted-foreground">Through date</label>
            <Input type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
          </div>
          <Button onClick={() => genM.mutate()} disabled={genM.isPending}>
            {genM.isPending ? "Generating…" : "Generate invoices"}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <div className="min-w-[200px] flex-1">
          <label className="text-xs text-muted-foreground">Search client</label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Client name…" />
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
          <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setFrom(""); setTo(""); setStatus("all"); }}>
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
              onClick={() => {
                if (confirm(`Void ${selectedIds.length} invoice(s)?`)) voidM.mutate();
              }}
              disabled={voidM.isPending}
            >
              Void
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected({})}>Clear</Button>
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
              <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">No invoices match.</td></tr>
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
                    <td className="px-4 py-2">{client?.display_name ?? "—"}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {inv.period_start ? `${inv.period_start} → ` : ""}{inv.period_end}
                    </td>
                    <td className="px-4 py-2">{fmtCents(inv.total_cents, inv.currency)}</td>
                    <td className="px-4 py-2">
                      <InvoiceStatusBadge status={inv.status} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link to="/invoices/$invoiceId" params={{ invoiceId: inv.id }} className="text-primary hover:underline">
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
