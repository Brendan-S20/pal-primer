import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { TrendingUp, Lightbulb, ListChecks, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  getAdvisorMetrics,
  getAdvisorInsights,
  type AdvisorInsightsResult,
} from "@/lib/advisor.functions";

// Business Advisor (BUILD-8). The analysis engine already existed but was
// only reachable as a weekly email: advice on our schedule, over our window,
// with no way to see what it was based on.
//
// Two deliberate choices:
//
// 1. The numbers load on their own; the commentary is a button. That began as
//    a cost decision, when the commentary was a model call against the org's
//    AI allowance. Since 2026-10-03 it is rules over the same numbers
//    (digest-insights.ts) and costs nothing, but it still reads better as data
//    first, interpretation on request.
//
// 2. Insights and recommendations sit NEXT TO the metrics they came from, never
//    behind a toggle. Advice with nothing to check it against is a horoscope.
//    Putting "chase your overdue invoices" beside the actual A/R figure lets an
//    owner see exactly which number the advice is reading.

const WINDOWS = [
  { days: 7 as const, label: "7 days" },
  { days: 30 as const, label: "30 days" },
  { days: 90 as const, label: "90 days" },
];

export function BusinessAdvisor() {
  const metricsFn = useServerFn(getAdvisorMetrics);
  const insightsFn = useServerFn(getAdvisorInsights);
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(7);
  // Keyed by window so switching to 30 days doesn't show the 7-day commentary
  // beside 30-day numbers — the exact mismatch that would make the evidence
  // column actively misleading rather than merely absent.
  const [reports, setReports] = useState<Record<number, AdvisorInsightsResult>>({});

  const metricsQ = useQuery({
    queryKey: ["advisor", "metrics", windowDays],
    queryFn: () => metricsFn({ data: { windowDays } }),
    staleTime: 5 * 60_000,
  });

  const analyze = useMutation({
    mutationFn: () => insightsFn({ data: { windowDays } }),
    onSuccess: (r) => {
      if (r) setReports((prev) => ({ ...prev, [r.windowDays]: r }));
    },
  });

  const report = reports[windowDays];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary shrink-0" />
          <h2 className="text-base font-semibold">Business advisor</h2>
        </div>
        <div className="flex rounded-md border p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setWindowDays(w.days)}
              className={`touch:min-h-11 rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                windowDays === w.days
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {metricsQ.isLoading ? (
        <Card>
          <CardContent className="p-(--card-pad) text-sm text-muted-foreground">
            Reading the last {windowDays} days…
          </CardContent>
        </Card>
      ) : metricsQ.isError ? (
        <Card>
          <CardContent className="p-(--card-pad) text-sm text-destructive">
            {(metricsQ.error as Error).message}
          </CardContent>
        </Card>
      ) : !metricsQ.data ? (
        <Card>
          <CardContent className="p-(--card-pad) text-sm text-muted-foreground">
            Nothing to analyze yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            {!report ? (
              <Card>
                <CardContent className="space-y-3 p-(--card-pad)">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    {metricsQ.data.metrics.weekLabel}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your numbers for this window are on the right. Run an analysis to get a read on
                    what they mean and what to do about them.
                  </p>
                  <Button onClick={() => analyze.mutate()} disabled={analyze.isPending}>
                    {analyze.isPending ? "Analyzing…" : "Analyze this period"}
                  </Button>
                  {analyze.isError && (
                    <p className="text-xs text-destructive">
                      {(analyze.error as Error).message}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Worked out from the figures beside it, the same way every time.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <>
                <Card>
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        {metricsQ.data.metrics.weekLabel}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-mt-1 h-7 text-xs"
                        onClick={() => analyze.mutate()}
                        disabled={analyze.isPending}
                      >
                        {analyze.isPending ? "Analyzing…" : "Re-run"}
                      </Button>
                    </div>
                    <p className="mt-2 text-lg font-medium leading-snug">
                      {report.insights.headline}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Lightbulb className="h-4 w-4 shrink-0" /> What stands out
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="space-y-2 text-sm">
                      {report.insights.insights.map((s, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="text-muted-foreground">•</span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <ListChecks className="h-4 w-4 shrink-0" /> What to do next
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="space-y-2 text-sm">
                      {report.insights.recommendations.map((s, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="font-medium text-primary">{i + 1}.</span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </>
            )}
          </div>

          {/* The evidence column. Always present, whether or not an analysis has
              been run — the data is the product; the commentary is a layer on
              top of it. */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  {report ? "The numbers behind this" : "Your numbers"}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <dl className="space-y-2 text-sm">
                  {metricsQ.data.metrics.stats.map((s) => (
                    <div key={s.label} className="flex items-baseline justify-between gap-3">
                      <dt className="text-muted-foreground">{s.label}</dt>
                      <dd className="flex items-baseline gap-2 text-right">
                        <span className="font-medium tabular-nums">{s.value}</span>
                        {s.delta && <span className="text-xs text-muted-foreground">{s.delta}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>

            {metricsQ.data.metrics.alerts.length > 0 && (
              <Card className="border-amber-300 dark:border-amber-500/40">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" /> Needs attention
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="space-y-2 text-sm">
                    {metricsQ.data.metrics.alerts.map((a, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-amber-600">•</span>
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            <p className="text-xs text-muted-foreground">
              Computed from your own data over the selected window, in your organization&apos;s time
              zone.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
