import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listInvoices, generateInvoicesForOrg } from "@/lib/invoices.functions";
import { getMyOrg } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/invoices/")({
  component: InvoicesPage,
});

function fmtCents(c: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format((c ?? 0) / 100);
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  draft: "secondary",
  open: "default",
  paid: "outline",
  void: "destructive",
  uncollectible: "destructive",
};

function InvoicesPage() {
  const list = useServerFn(listInvoices);
  const orgFn = useServerFn(getMyOrg);
  const gen = useServerFn(generateInvoicesForOrg);
  const qc = useQueryClient();
  const [through, setThrough] = useState(() => new Date().toISOString().slice(0, 10));

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

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
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

      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Client</th>
              <th className="px-4 py-2">Period</th>
              <th className="px-4 py-2">Total</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {invQ.isLoading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
            ) : (invQ.data ?? []).length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">No invoices yet.</td></tr>
            ) : (
              (invQ.data ?? []).map((inv) => {
                const client = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
                return (
                  <tr key={inv.id} className="border-b last:border-0">
                    <td className="px-4 py-2">{client?.display_name ?? "—"}</td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {inv.period_start ? `${inv.period_start} → ` : ""}{inv.period_end}
                    </td>
                    <td className="px-4 py-2">{fmtCents(inv.total_cents, inv.currency)}</td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_VARIANT[inv.status] ?? "secondary"}>{inv.status}</Badge>
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
