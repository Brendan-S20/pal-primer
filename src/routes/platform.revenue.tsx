import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Line, ComposedChart,
} from "recharts";
import { DollarSign, TrendingUp, Building2, AlertCircle } from "lucide-react";
import { getPlatformRevenueTrend } from "@/lib/platform.functions";

export const Route = createFileRoute("/platform/revenue")({
  head: () => ({ meta: [{ title: "Revenue · Platform admin" }, { name: "robots", content: "noindex" }] }),
  component: RevenuePage,
});

const money = (c: number | null | undefined) =>
  `$${((c ?? 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const moneyPrecise = (c: number | null | undefined) =>
  `$${((c ?? 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function RevenuePage() {
  const fn = useServerFn(getPlatformRevenueTrend);
  const q = useQuery({ queryKey: ["platform", "revenue"], queryFn: () => fn() });

  if (q.isLoading) return <div className="text-sm text-muted-foreground">Loading revenue…</div>;
  if (q.isError) return <div className="text-sm text-destructive">{(q.error as Error).message}</div>;
  const d = q.data!;
  const chartData = d.months.map((m) => ({
    month: m.month.slice(2),
    revenue: m.revenue_cents / 100,
    newOrgs: m.new_orgs,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={TrendingUp} label="ARR estimate" value={money(d.arrEstimateCents)} sub="(avg last 3 mo × 12)" />
        <StatCard icon={DollarSign} label="Avg monthly rev" value={money(d.avgMonthlyCents)} sub="last 3 months" />
        <StatCard icon={Building2} label="Paying orgs" value={`${d.payingOrgs} / ${d.totalOrgs}`} sub="active, past_due, or grace" />
        <StatCard icon={AlertCircle} label="Platform AR" value={money(d.arOpenCents)} sub="unpaid SaaS invoices" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revenue · trailing 12 months</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                {/* Auto-scale the revenue axis. The old formatter forced
                    "$Nk" ticks, which collapsed every value under $1,000
                    to "$0k" and made the chart look empty even though the
                    summary cards clearly had non-zero data. Fall back to
                    thousands only when the top value warrants it. */}
                <YAxis
                  yAxisId="l"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) =>
                    v >= 1000
                      ? `$${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`
                      : `$${Math.round(v).toLocaleString()}`
                  }
                />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  formatter={(value: number, name: string) =>
                    name === "revenue"
                      ? [`$${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, "Revenue"]
                      : [value, "New orgs"]
                  }
                />
                <Bar yAxisId="l" dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Line yAxisId="r" type="monotone" dataKey="newOrgs" stroke="hsl(var(--muted-foreground))" strokeWidth={2} dot />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Top orgs · MTD</CardTitle></CardHeader>
          <CardContent>
            {d.topOrgs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No revenue this month yet.</p>
            ) : (
              <ul className="divide-y">
                {d.topOrgs.map((o, i) => (
                  <li key={o.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="w-5 text-right tabular-nums text-muted-foreground">{i + 1}.</span>
                      <Link
                        to="/platform"
                        className="font-medium hover:underline"
                      >
                        {o.name}
                      </Link>
                    </span>
                    <span className="font-semibold tabular-nums">{moneyPrecise(o.revenue_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>MTD revenue by tier</CardTitle></CardHeader>
          <CardContent>
            {d.byTier.length === 0 ? (
              <p className="text-sm text-muted-foreground">No revenue this month yet.</p>
            ) : (
              <ul className="divide-y">
                {d.byTier.map((t) => (
                  <li key={t.tier} className="flex items-center justify-between py-2 text-sm">
                    <span className="capitalize">{t.tier}</span>
                    <span className="font-semibold tabular-nums">{moneyPrecise(t.revenue_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon, label, value, sub,
}: { icon: any; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
