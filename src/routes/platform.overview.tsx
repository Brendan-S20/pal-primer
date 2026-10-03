import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  getPlatformOverview,
  getRoutingHealth,
  type PlatformOverviewKpis,
  type RoutingHealth,
} from "@/lib/platform-overview.functions";
import type { RoadLegProblem } from "@/lib/road-legs.server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Building2, TrendingUp, AlertTriangle, PauseCircle, Sparkles, ArrowRightCircle,
  CalendarPlus, DollarSign, Route as RouteIcon, Database, MapPinOff,
} from "lucide-react";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/platform/overview")({
  head: () => titleHead("Overview", "Platform admin"),
  component: OverviewPage,
});

const money = (c: number) =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function Kpi({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warn" | "danger" | "good";
}) {
  const toneClass =
    tone === "warn"
      ? "text-amber-600"
      : tone === "danger"
        ? "text-destructive"
        : tone === "good"
          ? "text-emerald-600"
          : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <Icon className={`h-4 w-4 shrink-0 ${toneClass}`} />
      </div>
      <div className={`mt-2 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/**
 * Why a day was planned on estimates, for whoever runs the platform.
 *
 * Shorter and more technical than the dispatcher's sentences in
 * AutoRoutingPanel: this reader is the one who can act on a cause. Keyed on
 * RoadLegProblem so a new cause fails to compile here until it has a label --
 * and a reason this build has never heard of (written by a newer deploy) is
 * shown as its raw code rather than dropped.
 */
const ROUTING_REASON: Record<RoadLegProblem, string> = {
  router_busy: "Free router busy (429, then 429 again)",
  router_unreachable: "Router could not be reached",
  router_error: "Router returned an error",
  wrong_region: "Router has no map for those addresses",
  too_many_points: "Day too big for one router request",
  nothing_usable: "Router answer had nothing usable",
  save_failed: "Measured legs could not be saved",
};
const reasonLabel = (code: string) =>
  (ROUTING_REASON as Record<string, string | undefined>)[code] ?? code;

function RoutingHealthSection() {
  const fn = useServerFn(getRoutingHealth);
  const q = useQuery<RoutingHealth>({
    queryKey: ["platform", "routing-health"],
    queryFn: () => fn(),
  });
  const h = q.data;
  const n = (v: number | undefined) => (v == null ? "-" : v.toLocaleString());

  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Routing health (last {h?.days ?? 7} days)
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi
          icon={RouteIcon}
          label="Measured"
          value={n(h?.measured)}
          tone="good"
          hint={
            h && h.partlyMeasured > 0
              ? `${h.partlyMeasured.toLocaleString()} partly estimated: stops outside the map`
              : "Days the router measured"
          }
        />
        <Kpi
          icon={Database}
          label="Cached"
          value={n(h?.cached)}
          hint="Every leg already measured; router not asked"
        />
        <Kpi
          icon={MapPinOff}
          label="Estimated"
          value={n(h?.estimated)}
          tone={h && h.estimated > 0 ? "warn" : "default"}
          hint="Planned on straight lines"
        />
      </div>

      {h && h.estimatedByReason.length > 0 ? (
        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
              <span className="min-w-0">Why days were estimated</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {h.estimatedByReason.map((r) => (
                <li key={r.reason} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm [overflow-wrap:anywhere]">{reasonLabel(r.reason)}</div>
                    <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      <span className="font-mono">{r.reason}</span>
                      {" · "}
                      {r.workspaces === 1
                        ? "1 workspace"
                        : `${r.workspaces.toLocaleString()} workspaces`}
                    </div>
                  </div>
                  <div className="shrink-0 text-sm font-semibold tabular-nums">
                    {r.runs.toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {q.error ? (
        <div className="mt-2 text-sm text-destructive">{(q.error as Error).message}</div>
      ) : null}
    </section>
  );
}

function OverviewPage() {
  const fn = useServerFn(getPlatformOverview);
  const q = useQuery<PlatformOverviewKpis>({
    queryKey: ["platform", "overview"],
    queryFn: () => fn(),
  });

  const k = q.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Health of the SaaS at a glance. Free-to-paid conversion is the business event on
          this model. It lives right up top.
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Revenue &amp; activity
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi
            icon={DollarSign}
            label="MRR"
            value={k ? money(k.mrr_cents) : "-"}
            hint="From active tenant subscriptions"
          />
          <Kpi
            icon={Building2}
            label="Paying tenants"
            value={k ? String(k.active_tenants) : "-"}
            hint="active + grace + past due"
          />
          <Kpi
            icon={Sparkles}
            label="Free tenants"
            value={k ? String(k.free_tenants) : "-"}
          />
          <Kpi
            icon={CalendarPlus}
            label="New signups (7d)"
            value={k ? String(k.new_signups_week) : "-"}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Conversion pipeline
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <ArrowRightCircle className="h-4 w-4 text-emerald-600 shrink-0" />
                At the threshold
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tabular-nums text-emerald-600">
                {k?.at_threshold ?? "-"}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Free orgs with exactly 3 active clients. One more client and they cross into paid.
              </p>
              <Link
                to="/platform/tenants"
                className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
              >
                View tenants →
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <TrendingUp className="h-4 w-4 text-emerald-600 shrink-0" />
                Converted this month
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tabular-nums">
                {k?.converted_this_month ?? "-"}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Orgs that moved from free to paid since the 1st of this month.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Risk
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi
            icon={AlertTriangle}
            label="At risk"
            value={k ? String(k.at_risk) : "-"}
            tone={k && k.at_risk > 0 ? "warn" : "default"}
            hint="past due + grace"
          />
          <Kpi
            icon={AlertTriangle}
            label="Past due"
            value={k ? String(k.past_due_tenants) : "-"}
            tone={k && k.past_due_tenants > 0 ? "danger" : "default"}
          />
          <Kpi
            icon={AlertTriangle}
            label="In grace"
            value={k ? String(k.grace_tenants) : "-"}
            tone={k && k.grace_tenants > 0 ? "warn" : "default"}
          />
          <Kpi
            icon={PauseCircle}
            label="Suspended"
            value={k ? String(k.suspended_tenants) : "-"}
          />
        </div>
      </section>

      <RoutingHealthSection />

      {q.error ? (
        <div className="text-sm text-destructive">{(q.error as Error).message}</div>
      ) : null}
    </div>
  );
}
