import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listPlatformInvoices } from "@/lib/platform-billing.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Receipt } from "lucide-react";
import { formatDay } from "@/lib/format";

export const Route = createFileRoute("/platform/invoices")({
  component: InvoicesPage,
});

function fmt(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

function statusBadge(status: string) {
  const map: Record<string, "default" | "outline" | "secondary" | "destructive"> = {
    paid: "default",
    open: "secondary",
    void: "outline",
    uncollectible: "destructive",
    draft: "outline",
  };
  return <Badge variant={map[status] ?? "outline"}>{status}</Badge>;
}

function InvoicesPage() {
  const [status, setStatus] = useState<"all" | "open" | "paid" | "void" | "uncollectible">("all");
  const listFn = useServerFn(listPlatformInvoices);
  const q = useQuery({
    queryKey: ["platform", "invoices", status],
    queryFn: () => listFn({ data: { status, limit: 200 } }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">SaaS invoices</h1>
        <p className="text-sm text-muted-foreground">Invoices Stripe generates for tenant subscriptions on the platform account.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Invoices</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{q.data?.totals.count ?? 0}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Total billed</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{fmt(q.data?.totals.due_cents ?? 0)}</CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Total collected</CardTitle></CardHeader><CardContent className="text-2xl font-semibold">{fmt(q.data?.totals.paid_cents ?? 0)}</CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Invoices</CardTitle>
          <Select value={status} onValueChange={(v: any) => setStatus(v)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="void">Void</SelectItem>
              <SelectItem value="uncollectible">Uncollectible</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data?.rows ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.number ?? r.stripe_invoice_id?.slice(0, 12) ?? "-"}</TableCell>
                    <TableCell>
                      {r.organization_id ? (
                        <Link to="/platform/tenants/$id" params={{ id: r.organization_id }} className="text-primary hover:underline">
                          {r.organization_name ?? r.organization_id.slice(0, 8)}
                        </Link>
                      ) : "-"}
                    </TableCell>
                    <TableCell>
                      <div>{fmt(r.amount_due_cents, r.currency)}</div>
                      {r.amount_paid_cents !== r.amount_due_cents ? (
                        <div className="text-xs text-muted-foreground">paid {fmt(r.amount_paid_cents, r.currency)}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell className="text-sm">{r.issued_at ? formatDay(r.issued_at) : "-"}</TableCell>
                    <TableCell className="text-sm">{r.paid_at ? formatDay(r.paid_at) : "-"}</TableCell>
                    <TableCell className="text-right">
                      {r.hosted_invoice_url ? (
                        <Button variant="outline" size="sm" asChild><a href={r.hosted_invoice_url} target="_blank" rel="noreferrer">View</a></Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {q.isLoading ? (
                  <TableRow><TableCell colSpan={7}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
                ) : (q.data?.rows ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-6">
                    <EmptyState
                      icon={<Receipt className="h-5 w-5" />}
                      title="No invoices yet"
                      description="Once tenants subscribe, Stripe events will populate this list via the platform webhook."
                    />
                  </TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
