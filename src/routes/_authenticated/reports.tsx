import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { useState } from "react";
import { getReports } from "@/lib/reports.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 29);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

const reportsKey = (from: string, to: string) => ["reports", from, to] as const;

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta: [{ title: "Reports · HoundStack" }] }),
  component: ReportsPage,
});

function ReportsPage() {
  const initial = defaultRange();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [applied, setApplied] = useState(initial);
  const call = useServerFn(getReports);
  const router = useRouter();

  const opts = queryOptions({
    queryKey: reportsKey(applied.from, applied.to),
    queryFn: () => call({ data: applied }),
  });
  const { data } = useSuspenseQuery(opts);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Reports</h1>
          <p className="text-sm text-muted-foreground">
            {applied.from} → {applied.to}
          </p>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ from, to });
            router.invalidate();
          }}
        >
          <div>
            <Label htmlFor="from">From</Label>
            <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="to">To</Label>
            <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button type="submit">Apply</Button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {/* Every money tile says which basis it is on, in its own label.
            "Revenue" said neither, and meant paid-invoices-dated-by-issue minus
            a cash refund — a figure that could be reconciled to nothing. Cash
            and accrual now sit side by side and are never subtracted from each
            other.

            IMP-10: gross, then what came back, then net — three tiles rather
            than one adjusted number. A single "revenue" figure that silently
            moved when a dispute landed is exactly what this replaces, and
            netting in place would have reproduced it more quietly. */}
        <Metric
          label="Collected · cash"
          value={fmtMoney(data.collectedGrossCents)}
          valueClass={
            data.collectedGrossCents > 0 ? "text-emerald-700 dark:text-emerald-400" : undefined
          }
          hint={`${data.paymentCount} payment${data.paymentCount === 1 ? "" : "s"} received`}
        />
        <Metric
          label="Refunds & chargebacks"
          value={data.refundsNetCents === 0 ? "-" : `-${fmtMoney(data.refundsNetCents)}`}
          valueClass={data.refundsNetCents > 0 ? "text-destructive" : undefined}
          hint={
            data.refundsCount === 0
              ? "None in this range"
              : data.refundsRecoveredCents > 0
                ? `${data.refundsCount} in this range · ${fmtMoney(data.refundsRecoveredCents)} recovered`
                : `${data.refundsCount} in this range`
          }
        />
        <Metric
          label="Net collected · cash"
          value={fmtMoney(data.collectedNetCents)}
          valueClass={
            data.collectedNetCents > 0 ? "text-emerald-700 dark:text-emerald-400" : undefined
          }
        />
        <Metric
          label="Billed · accrual"
          value={fmtMoney(data.netBilledCents)}
          valueClass={data.netBilledCents > 0 ? "text-sky-700 dark:text-sky-400" : undefined}
          hint={
            data.creditsAppliedCents > 0
              ? `${fmtMoney(data.billedCents)} invoiced, less ${fmtMoney(data.creditsAppliedCents)} of credit`
              : `${data.invoiceCount} invoice${data.invoiceCount === 1 ? "" : "s"} issued`
          }
        />
        <Metric
          label="Outstanding"
          value={fmtMoney(data.outstandingCents)}
          valueClass={data.outstandingCents > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
          hint={`Open as at ${data.arAsOf}`}
        />
        <Metric label="Completed visits" value={String(data.visitCounts.completed ?? 0)} />
        <Metric
          label="Completion rate"
          value={data.completionRate == null ? "-" : `${Math.round(data.completionRate * 100)}%`}
        />
        <Metric label="Skipped visits" value={String(data.visitCounts.skipped ?? 0)} />
        <Metric label="Scheduled ahead" value={String(data.visitCounts.scheduled ?? 0)} />
        <Metric label="New clients" value={String(data.newClients)} />
        <Metric label="Active clients" value={String(data.activeClients)} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>AR aging as at {data.arAsOf}</CardTitle>
            {/* The date is in the title, not a footnote. A receivables figure
                without an "as at" is the ambiguity that let this card and the
                CPA pack's aging sheet print different totals for July: this one
                was a live position, that one was point-in-time, and neither
                said so. They now total the same. The BUCKETS still differ on
                purpose — this ages from the issue date, the pack from the due
                date, which is documented in cpa-reports.agingBucket. */}
            <p className="text-xs text-muted-foreground">
              Open balances, aged from the invoice date. Your accountant's pack ages the same
              balances from their due date.
            </p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {/* Older buckets get progressively hotter so a problem book
                    can be color-scanned, matching the cohort heatmap's
                    value→color idea (P2). */}
                <Row label="Current" value={fmtMoney(data.aging.current)} />
                <Row
                  label="1-30 days"
                  value={fmtMoney(data.aging.d30)}
                  valueClass={data.aging.d30 > 0 ? "text-amber-600 dark:text-amber-400" : undefined}
                />
                <Row
                  label="31-60 days"
                  value={fmtMoney(data.aging.d60)}
                  valueClass={
                    data.aging.d60 > 0 ? "text-orange-600 dark:text-orange-400" : undefined
                  }
                />
                <Row
                  label="60+ days"
                  value={fmtMoney(data.aging.d90)}
                  valueClass={data.aging.d90 > 0 ? "text-destructive" : undefined}
                />
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Skip reasons</CardTitle>
          </CardHeader>
          <CardContent>
            {data.skipReasons.length === 0 ? (
              <p className="text-sm text-muted-foreground">No skips in this range.</p>
            ) : (
              <table className="w-full text-sm min-w-[480px]">
                <tbody>
                  {data.skipReasons.map((r) => (
                    <Row key={r.code} label={r.code.replaceAll("_", " ")} value={String(r.count)} />
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tech productivity</CardTitle>
          </CardHeader>
          {/* Four columns of figures in a half-width card. Without a scroll
              container the table sets the width of the page rather than of
              itself, which is the one thing a layout must never do. */}
          <CardContent className="overflow-x-auto">
            {data.perTech.length === 0 ? (
              <p className="text-sm text-muted-foreground">No visits.</p>
            ) : (
              <table className="w-full text-sm min-w-[720px]">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1">Tech</th>
                    <th>Completed</th>
                    <th>Skipped</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perTech.map((t) => (
                    <tr key={t.id} className="border-t">
                      <td className="py-1">{t.name}</td>
                      <td>{t.completed}</td>
                      <td>{t.skipped}</td>
                      <td>{t.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Zone activity</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {data.perZone.length === 0 ? (
              <p className="text-sm text-muted-foreground">No visits.</p>
            ) : (
              <table className="w-full text-sm min-w-[480px]">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1">Zone</th>
                    <th>Completed</th>
                    <th>Skipped</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perZone.map((z) => (
                    <tr key={z.id} className="border-t">
                      <td className="py-1">{z.name}</td>
                      <td>{z.completed}</td>
                      <td>{z.skipped}</td>
                      <td>{z.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top clients by money collected</CardTitle>
          <p className="text-xs text-muted-foreground">
            Cash basis: what each customer actually paid in this range. Adds up to the Collected
            tile above, less anything paid without an invoice.
          </p>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {data.topClients.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments received in this range.</p>
          ) : (
            <table className="w-full text-sm min-w-[480px]">
              {/* Ranked on NET. Ranking on gross while the tiles above show net
                  is how a customer who refunded everything stays at the top of
                  the list. The refund column only appears when there is one, so
                  an ordinary month keeps a two-column table.

                  Both columns are CASH. They used to be issue-dated billing
                  minus a cash refund, which is the mixed-basis subtraction the
                  headline was making, repeated per customer. */}
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1">Client</th>
                  {data.refundsCount > 0 && <th className="py-1 text-right">Collected</th>}
                  {data.refundsCount > 0 && <th className="py-1 text-right">Refunded</th>}
                  <th className="py-1 text-right">{data.refundsCount > 0 ? "Net" : "Collected"}</th>
                </tr>
              </thead>
              <tbody>
                {data.topClients.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="py-1">{c.name}</td>
                    {data.refundsCount > 0 && (
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {fmtMoney(c.collectedCents)}
                      </td>
                    )}
                    {data.refundsCount > 0 && (
                      <td
                        className={`py-1 text-right tabular-nums ${
                          c.refundsCents > 0 ? "text-destructive" : "text-muted-foreground"
                        }`}
                      >
                        {c.refundsCents === 0 ? "-" : `-${fmtMoney(c.refundsCents)}`}
                      </td>
                    )}
                    <td className="py-1 text-right font-medium tabular-nums">
                      {fmtMoney(c.netCollectedCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  valueClass,
  hint,
}: {
  label: string;
  value: string;
  valueClass?: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold ${valueClass ?? ""}`}>{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <tr className="border-t">
      <td className="py-1 capitalize">{label}</td>
      <td className={`py-1 text-right font-medium ${valueClass ?? ""}`}>{value}</td>
    </tr>
  );
}
