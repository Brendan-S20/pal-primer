import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getCohortRetention,
  getClientLtv,
  getZoneProfitability,
  getChurnDrivers,
} from "@/lib/analytics.functions";
import { scoreChurnHeuristic, listAtRiskClients, sendWinBack } from "@/lib/churn.functions";
import {
  previewWeeklyDigest,
  sendWeeklyDigestNow,
  getDigestSettings,
  updateDigestSettings,
} from "@/lib/digest.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import { PlanGate } from "@/components/PlanGate";
import { BusinessAdvisor } from "@/components/BusinessAdvisor";

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

function pct(n: number, d: number) {
  if (!d) return "-";
  return `${Math.round((n / d) * 100)}%`;
}

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Advanced analytics · HoundStack" }] }),
  component: AnalyticsPage,
});

function AnalyticsPage() {
  return (
    <div className="mx-auto max-w-6xl p-6 space-y-6 overflow-x-hidden max-w-full">
      <div>
        <h1 className="text-2xl font-semibold">Advanced analytics</h1>
        <p className="text-sm text-muted-foreground">
          Cohort retention, lifetime value, zone profitability, and churn drivers.
        </p>
      </div>
      <Tabs defaultValue="advisor" className="space-y-4">
        <TabsList>
          <TabsTrigger value="advisor">Advisor</TabsTrigger>
          <TabsTrigger value="retention">Cohort retention</TabsTrigger>
          <TabsTrigger value="ltv">LTV</TabsTrigger>
          <TabsTrigger value="zones">Zone profitability</TabsTrigger>
          <TabsTrigger value="churn">Churn drivers</TabsTrigger>
          <TabsTrigger value="winback">Win-back</TabsTrigger>
          <TabsTrigger value="digest">Weekly digest</TabsTrigger>
        </TabsList>
        {/* BUILD-8: the advisor is NOT plan-gated. It isn't one of the four
            functions the pricing page sells as "Advanced analytics", and it was
            removed from the site as a phantom add-on SKU (MKT-1) rather than
            sold. Gating it would invent a commitment nobody made. */}
        <TabsContent value="advisor">
          <BusinessAdvisor />
        </TabsContent>

        {/* BUILD-1: these four are the "Advanced analytics: cohort retention,
            zone profitability, churn drivers" the pricing page sells on Growth
            and above, and they map one-to-one onto analytics.functions.ts.
            Win-back and the weekly digest are NOT part of that SKU — they come
            from churn.functions and digest.functions — so they stay open on
            every plan. Gating the whole route would have been easier and would
            have taken away something we never said was paid. */}
        <TabsContent value="retention">
          <PlanGate entitlement="advanced_analytics">
            <CohortTab />
          </PlanGate>
        </TabsContent>
        <TabsContent value="ltv">
          <PlanGate entitlement="advanced_analytics">
            <LtvTab />
          </PlanGate>
        </TabsContent>
        <TabsContent value="zones">
          <PlanGate entitlement="advanced_analytics">
            <ZoneTab />
          </PlanGate>
        </TabsContent>
        <TabsContent value="churn">
          <PlanGate entitlement="advanced_analytics">
            <ChurnTab />
          </PlanGate>
        </TabsContent>
        <TabsContent value="winback">
          <WinBackTab />
        </TabsContent>
        <TabsContent value="digest">
          <DigestTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CohortTab() {
  const [months, setMonths] = useState(12);
  const call = useServerFn(getCohortRetention);
  const q = useQuery({
    queryKey: ["analytics", "cohort", months],
    queryFn: () => call({ data: { monthsBack: months } }),
  });

  const grid = useMemo(() => {
    const rows = q.data?.rows ?? [];
    const byCohort = new Map<string, { size: number; retained: Map<number, number> }>();
    for (const r of rows) {
      const key = r.cohort_month.slice(0, 7);
      const entry = byCohort.get(key) ?? { size: r.cohort_size, retained: new Map() };
      entry.size = r.cohort_size;
      entry.retained.set(r.months_since, r.retained);
      byCohort.set(key, entry);
    }
    return Array.from(byCohort.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [q.data]);

  return (
    <Card>
      <CardHeader className="flex-row items-end gap-4">
        <div>
          <CardTitle>Cohort retention</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            % of each signup cohort with a completed visit N months later.
          </p>
        </div>
        <div className="ml-auto flex items-end gap-2">
          <div>
            <Label htmlFor="months" className="text-xs">
              Months back
            </Label>
            <Input
              id="months"
              type="number"
              min={1}
              max={24}
              value={months}
              onChange={(e) => setMonths(Math.max(1, Math.min(24, Number(e.target.value) || 12)))}
              className="w-24"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-auto">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : grid.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cohorts in window.</p>
        ) : (
          <table className="text-xs">
            <thead>
              <tr className="text-left">
                <th className="p-2">Cohort</th>
                <th className="p-2">Size</th>
                {Array.from({ length: months + 1 }).map((_, i) => (
                  <th key={i} className="p-2 text-center">
                    M{i}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map(([cohort, entry]) => (
                <tr key={cohort} className="border-t">
                  <td className="p-2 font-mono">{cohort}</td>
                  <td className="p-2">{entry.size}</td>
                  {Array.from({ length: months + 1 }).map((_, i) => {
                    const r = entry.retained.get(i) ?? 0;
                    const p = entry.size ? r / entry.size : 0;
                    const bg =
                      p > 0
                        ? `rgba(34,197,94,${Math.min(0.85, 0.15 + p * 0.7).toFixed(2)})`
                        : "transparent";
                    return (
                      <td key={i} className="p-2 text-center" style={{ background: bg }}>
                        {r > 0 ? pct(r, entry.size) : "-"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function LtvTab() {
  const [limit, setLimit] = useState(25);
  const call = useServerFn(getClientLtv);
  const q = useQuery({
    queryKey: ["analytics", "ltv", limit],
    queryFn: () => call({ data: { limit } }),
  });
  const rows = q.data?.rows ?? [];
  const totalRev = rows.reduce(
    (s, r) => s + Number(r.net_revenue_cents ?? r.revenue_cents ?? 0),
    0,
  );
  const totalRefunds = rows.reduce((s, r) => s + Number(r.refunds_cents ?? 0), 0);
  const avgMonthly = rows.length
    ? rows.reduce((s, r) => s + Number(r.net_monthly_avg_cents ?? r.monthly_avg_cents ?? 0), 0) /
      rows.length
    : 0;
  // The refund column only appears when there is something in it, so an org
  // that has never had one keeps the table it already knows.
  const anyRefunds = totalRefunds !== 0;

  return (
    <Card>
      <CardHeader className="flex-row items-end gap-4">
        <div>
          <CardTitle>Client lifetime value</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Paid revenue by client, net of refunds and chargebacks. Monthly avg = net revenue ÷
            tenure × 30.
          </p>
        </div>
        <div className="ml-auto flex items-end gap-2">
          <div>
            <Label htmlFor="limit" className="text-xs">
              Top N
            </Label>
            <Input
              id="limit"
              type="number"
              min={1}
              max={200}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(200, Number(e.target.value) || 25)))}
              className="w-24"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className={`grid gap-4 mb-4 text-sm ${anyRefunds ? "grid-cols-4" : "grid-cols-3"}`}>
          <Stat label="Clients shown" value={String(rows.length)} />
          {anyRefunds && <Stat label="Refunded" value={`-${fmt(totalRefunds)}`} />}
          <Stat label="Net paid revenue" value={fmt(totalRev)} />
          <Stat label="Avg monthly / client" value={fmt(avgMonthly)} />
        </div>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <table className="w-full text-sm [&_th]:px-3 [&_td]:px-3 [&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Client</th>
                <th className="py-2">Tenure</th>
                {anyRefunds && <th className="py-2 text-right">Billed</th>}
                {anyRefunds && <th className="py-2 text-right">Refunded</th>}
                <th className="py-2 text-right">{anyRefunds ? "Net revenue" : "Revenue"}</th>
                <th className="py-2 text-right">Monthly avg</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.client_id} className="border-t">
                  <td className="py-2">{r.display_name}</td>
                  <td className="py-2 text-muted-foreground">{r.tenure_days}d</td>
                  {anyRefunds && (
                    <td className="py-2 text-right text-muted-foreground">
                      {fmt(Number(r.revenue_cents))}
                    </td>
                  )}
                  {anyRefunds && (
                    <td
                      className={`py-2 text-right ${
                        Number(r.refunds_cents) > 0 ? "text-destructive" : "text-muted-foreground"
                      }`}
                    >
                      {Number(r.refunds_cents) === 0 ? "-" : `-${fmt(Number(r.refunds_cents))}`}
                    </td>
                  )}
                  <td className="py-2 text-right">{fmt(Number(r.net_revenue_cents))}</td>
                  <td className="py-2 text-right">{fmt(Number(r.net_monthly_avg_cents))}</td>
                  <td className="py-2">
                    {r.active ? <Badge>Active</Badge> : <Badge variant="secondary">Inactive</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function ZoneTab() {
  const today = new Date();
  const past = new Date();
  past.setDate(past.getDate() - 89);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [from, setFrom] = useState(iso(past));
  const [to, setTo] = useState(iso(today));
  const [applied, setApplied] = useState({ from, to });
  const call = useServerFn(getZoneProfitability);
  const q = useQuery({
    queryKey: ["analytics", "zones", applied.from, applied.to],
    queryFn: () => call({ data: applied }),
  });
  const rows = q.data?.rows ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-end gap-4">
        <div>
          <CardTitle>Zone workload &amp; booked value</CardTitle>
          {/* IMP-10: renamed from "Zone profitability / Revenue". This sums the
              subscription LIST PRICE of completed visits — it has never known
              about payment, discounts, credits, write-offs or refunds, so
              calling it revenue overstated both its accuracy and its authority.
              A refunds line was deliberately NOT added: deducting money from a
              figure that never tracked money would make it look more reliable
              than it is. */}
          <p className="text-xs text-muted-foreground mt-1">
            Booked service value of completed visits per zone, at list price. This is what the work
            was worth, not what was collected — see Reports for money actually received.
          </p>
        </div>
        <div className="ml-auto flex items-end gap-2">
          <div>
            <Label className="text-xs">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button onClick={() => setApplied({ from, to })}>Apply</Button>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Zone</th>
                <th className="py-2 text-right">Visits</th>
                <th className="py-2 text-right">Completed</th>
                <th className="py-2 text-right">Booked value</th>
                <th className="py-2 text-right">Avg / visit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.zone_id} className="border-t">
                  <td className="py-2">{r.zone_name}</td>
                  <td className="py-2 text-right">{r.visit_count}</td>
                  <td className="py-2 text-right">{r.completed_count}</td>
                  <td className="py-2 text-right">{fmt(Number(r.revenue_cents))}</td>
                  <td className="py-2 text-right">{fmt(Number(r.avg_revenue_per_visit_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function ChurnTab() {
  const call = useServerFn(getChurnDrivers);
  const q = useQuery({ queryKey: ["analytics", "churn"], queryFn: () => call() });
  const rows = q.data?.rows ?? [];
  const totalAtRisk = rows.reduce((s, r) => s + Number(r.revenue_at_risk_cents ?? 0), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Churn drivers</CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Grouped by AI-scored churn reason. Revenue at risk = paid revenue from these clients in
          the last 180 days, <span className="font-medium">before refunds</span> — this is an
          estimate for prioritising outreach, not a reported figure. Score churn from the{" "}
          <Link to="/clients" className="font-medium underline underline-offset-2">
            Clients
          </Link>{" "}
          list.
        </p>
      </CardHeader>
      <CardContent>
        <div className="mb-4 text-sm">
          <Stat label="Total revenue at risk (180d)" value={fmt(totalAtRisk)} />
        </div>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No churn-scored clients yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Reason</th>
                <th className="py-2 text-right">Clients</th>
                <th className="py-2 text-right">Avg score</th>
                <th className="py-2 text-right">Revenue at risk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.reason} className="border-t">
                  <td className="py-2">{r.reason}</td>
                  <td className="py-2 text-right">{r.client_count}</td>
                  <td className="py-2 text-right">{Number(r.avg_score).toFixed(2)}</td>
                  <td className="py-2 text-right">{fmt(Number(r.revenue_at_risk_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function WinBackTab() {
  const listFn = useServerFn(listAtRiskClients);
  const scoreFn = useServerFn(scoreChurnHeuristic);
  const sendFn = useServerFn(sendWinBack);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["churn", "at-risk"], queryFn: () => listFn() });
  // Dollars, not percent. A percentage offer had no base to compute from and
  // produced a code the customer portal refuses — see sendWinBack.
  const [discountDollars, setDiscountDollars] = useState(15);

  const score = useMutation({
    mutationFn: () => scoreFn(),
    onSuccess: (r) => {
      toast.success(`Scored ${r.scored} client${r.scored === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["churn", "at-risk"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const send = useMutation({
    mutationFn: (clientId: string) =>
      sendFn({
        data: { clientId, discountCents: Math.round(discountDollars * 100), expiresDays: 30 },
      }),
    onSuccess: (r) => {
      toast.success(`Win-back sent (code ${r.promoCode})`);
      qc.invalidateQueries({ queryKey: ["churn", "at-risk"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = q.data?.rows ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">At-risk clients</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border bg-muted/30 p-3">
          <div>
            <p className="text-sm">
              Heuristic score based on recent visit gaps, skips, complaints, and payment failures.
              Score ≥ 60 shows here.
            </p>
            <p className="text-xs text-muted-foreground">
              Prefer the AI churn scorer in AI Tools when you want reason-with-context.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Sending a win-back emails a single-use code worth the credit below. The customer
              enters it in their portal and it lands on their account as credit.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <Label htmlFor="wd">Credit offered</Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="wd"
                  type="number"
                  min={1}
                  max={200}
                  step={1}
                  value={discountDollars}
                  onChange={(e) => setDiscountDollars(Number(e.target.value))}
                  className="w-24 pl-5"
                />
              </div>
            </div>
            <Button variant="outline" onClick={() => score.mutate()} disabled={score.isPending}>
              {score.isPending ? "Scoring…" : "Re-score all"}
            </Button>
          </div>
        </div>

        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No at-risk clients right now. Run "Re-score all" to refresh.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-3 py-2">Score</th>
                  <th className="px-3 py-2">Why</th>
                  <th className="px-3 py-2">Last visit</th>
                  <th className="px-3 py-2">Win-back</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tone =
                    r.churn_score >= 85
                      ? "destructive"
                      : r.churn_score >= 70
                        ? "default"
                        : "secondary";
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{r.display_name}</td>
                      <td className="px-3 py-2">
                        <Badge variant={tone as any}>{r.churn_score}</Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.churn_reason ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.last_visit_date ? new Date(r.last_visit_date).toLocaleDateString() : "-"}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {r.last_winback_sent_at
                          ? `sent ${new Date(r.last_winback_sent_at).toLocaleDateString()}`
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          onClick={() => send.mutate(r.id)}
                          disabled={send.isPending}
                        >
                          Send ${discountDollars} offer
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DigestTab() {
  const previewFn = useServerFn(previewWeeklyDigest);
  const sendFn = useServerFn(sendWeeklyDigestNow);
  const settingsFn = useServerFn(getDigestSettings);
  const updateFn = useServerFn(updateDigestSettings);
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ["digest", "settings"],
    queryFn: () => settingsFn(),
  });

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [recipient, setRecipient] = useState<string>("");
  const initialized = useMemo(() => settings.data != null, [settings.data]);
  if (initialized && enabled === null) {
    setEnabled(settings.data!.enabled);
    setRecipient(settings.data!.recipientEmail ?? "");
  }

  // What is SAVED, not what is typed. A half-entered address in the box does
  // not make the Monday job able to send — only the stored value does, so the
  // warning has to key off that or it would disappear as soon as someone
  // started typing and stop telling the truth.
  const savedRecipient = (settings.data?.recipientEmail ?? "").trim();

  const preview = useMutation({
    mutationFn: () => previewFn(),
    onError: (e: Error) => toast.error(e.message),
  });

  const send = useMutation({
    mutationFn: () => sendFn({ data: recipient ? { recipientOverride: recipient } : {} }),
    onSuccess: (r) => toast.success(`Digest queued to ${r.recipient}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: () =>
      updateFn({
        data: { enabled: enabled ?? true, recipientEmail: recipient.trim() || null },
      }),
    onSuccess: () => {
      toast.success("Digest settings saved");
      qc.invalidateQueries({ queryKey: ["digest", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const p = preview.data;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Weekly AI digest</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Every Monday morning, we email a plain-language summary of the past week: revenue,
            visits, new clients, at-risk accounts, and 2-3 AI-generated recommendations.
          </p>

          {/* This panel promised a Monday email from the day it shipped, and for
              months nothing was ever sent — no scheduler existed, and no
              organization had a recipient. The schedule exists now; the second
              half is this. A checkbox reading "Enabled" beside a promise the
              product cannot keep is how a feature stays broken without anyone
              filing a bug: the owner believes it is on, and the absence of an
              email is indistinguishable from a quiet week. */}
          {initialized && (enabled ?? true) && !savedRecipient && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">No digest will be sent yet.</p>
                <p className="mt-0.5 text-muted-foreground">
                  This is switched on, but there is no address to send to. Add one below and save,
                  and the first digest goes out on the next Monday.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div>
              <Label htmlFor="digest-email">Send to</Label>
              <Input
                id="digest-email"
                type="email"
                placeholder="owner@yourbusiness.com"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="digest-enabled"
                type="checkbox"
                checked={enabled ?? true}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4"
              />
              <Label htmlFor="digest-enabled" className="text-sm">
                Enabled
              </Label>
            </div>
            <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>

          {settings.data?.lastSentAt ? (
            <p className="text-xs text-muted-foreground">
              Last sent {new Date(settings.data.lastSentAt).toLocaleString()}.
            </p>
          ) : savedRecipient ? (
            <p className="text-xs text-muted-foreground">
              Not sent yet — the first one goes out on the next Monday.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => preview.mutate()} disabled={preview.isPending}>
              {preview.isPending ? "Generating preview…" : "Preview this week"}
            </Button>
            <Button
              variant="outline"
              onClick={() => send.mutate()}
              disabled={send.isPending || (!recipient && !settings.data?.recipientEmail)}
            >
              {send.isPending ? "Sending…" : "Send now"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {p && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Preview: {p.metrics.orgName} · {p.metrics.weekLabel}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-medium">{p.insights.headline}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {p.metrics.stats.map((s) => (
                <div key={s.label} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                  <div className="text-lg font-semibold">{s.value}</div>
                  {s.delta && <div className="text-xs text-emerald-600">{s.delta}</div>}
                </div>
              ))}
            </div>

            {p.insights.insights.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold">What stood out</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {p.insights.insights.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            )}

            {p.insights.recommendations.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold">Suggested next steps</h4>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {p.insights.recommendations.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ol>
              </div>
            )}

            {p.metrics.alerts.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-semibold text-amber-700">Needs attention</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
                  {p.metrics.alerts.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
