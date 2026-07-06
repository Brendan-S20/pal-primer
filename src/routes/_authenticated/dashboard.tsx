import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getMyOrg } from "@/lib/org.functions";
import { getDashboardSummary } from "@/lib/dashboard.functions";
import { getBillingStatus } from "@/lib/billing.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { RouteMap, buildTechGroups, type MapVisit } from "@/components/RouteMap";
import { VisitDetailDrawer } from "@/components/VisitDetailDrawer";
import {
  Users,
  DollarSign,
  Receipt,
  CalendarCheck,
  AlertTriangle,
  CloudRain,
  UserX,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function fmtMoney(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Dashboard() {
  const orgFn = useServerFn(getMyOrg);
  const sumFn = useServerFn(getDashboardSummary);
  const billingFn = useServerFn(getBillingStatus);
  const [detailVisitId, setDetailVisitId] = useState<string | null>(null);

  const { data: orgData, isLoading: orgLoading } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => orgFn(),
  });
  const { data: sum, isLoading: sumLoading } = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => sumFn(),
    refetchInterval: 60_000,
  });
  const { data: billing } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => billingFn(),
    staleTime: 60_000,
    retry: false,
  });

  if (orgLoading) return <p className="text-muted-foreground">Loading…</p>;

  const org = orgData?.organization;
  if (!org) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h1 className="text-xl font-semibold">No organization yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign out and use the Create account tab to finish onboarding.
        </p>
      </div>
    );
  }

  const groups = sum
    ? buildTechGroups(sum.todayVisits as MapVisit[], sum.staff as any)
    : [];

  const alerts: Array<{ icon: any; text: string; to?: string; tone: "warn" | "danger" }> = [];
  if (sum) {
    if (sum.unassignedToday > 0) {
      alerts.push({
        icon: UserX,
        text: `${sum.unassignedToday} unassigned visit${sum.unassignedToday === 1 ? "" : "s"} today`,
        to: "/routes",
        tone: "warn",
      });
    }
    if (sum.weatherFlaggedToday > 0) {
      alerts.push({
        icon: CloudRain,
        text: `${sum.weatherFlaggedToday} weather-flagged visit${sum.weatherFlaggedToday === 1 ? "" : "s"}`,
        to: "/weather",
        tone: "warn",
      });
    }
    if (sum.overdueCount > 0) {
      alerts.push({
        icon: AlertTriangle,
        text: `${sum.overdueCount} overdue invoice${sum.overdueCount === 1 ? "" : "s"}`,
        to: "/invoices",
        tone: "danger",
      });
    }
    if (sum.openConcerns && sum.openConcerns.length > 0) {
      alerts.push({
        icon: AlertTriangle,
        text: `${sum.openConcerns.length} client concern${sum.openConcerns.length === 1 ? "" : "s"} to review`,
        to: "/messages",
        tone: "warn",
      });
    }
  }


  const completed = sum?.visitCounts.completed ?? 0;
  const total = sum?.visitCounts.total ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">Signed in as {org.role}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/routes"><Button variant="outline" size="sm">Today's routes</Button></Link>
          <Link to="/clients"><Button variant="outline" size="sm">Clients</Button></Link>
        </div>
      </div>

      <OnboardingChecklist />

      {alerts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {alerts.map((a, i) => {
            const Icon = a.icon;
            const content = (
              <div
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                  a.tone === "danger"
                    ? "border-destructive/40 bg-destructive/5 text-destructive"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                }`}
              >
                <Icon className="h-4 w-4" />
                {a.text}
              </div>
            );
            return a.to ? (
              <Link key={i} to={a.to}>{content}</Link>
            ) : (
              <div key={i}>{content}</div>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={Users}
          label="Active clients"
          value={sum ? String(sum.activeClients) : "—"}
          hint={billing?.planName ? `${billing.planName} plan` : undefined}
        />
        <KpiCard
          icon={DollarSign}
          label="MTD revenue"
          value={sum ? fmtMoney(sum.mtdRevenueCents) : "—"}
        />
        <KpiCard
          icon={Receipt}
          label="AR open"
          value={sum ? fmtMoney(sum.arOpenCents) : "—"}
          hint={sum && sum.overdueCount > 0 ? `${sum.overdueCount} overdue` : undefined}
          tone={sum && sum.overdueCount > 0 ? "danger" : undefined}
        />
        <KpiCard
          icon={CalendarCheck}
          label="Visits today"
          value={sum ? `${completed} / ${total}` : "—"}
          hint={total > 0 ? `${pct}% done` : "None scheduled"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Today's map</h2>
            <Link to="/routes" className="text-xs text-primary hover:underline">
              Open routes →
            </Link>
          </div>
          {sumLoading ? (
            <div className="flex h-[380px] items-center justify-center text-sm text-muted-foreground">
              Loading map…
            </div>
          ) : groups.length === 0 ? (
            <div className="flex h-[380px] items-center justify-center text-sm text-muted-foreground">
              No visits scheduled today.
            </div>
          ) : (
            <RouteMap
              groups={groups}
              height={380}
              onVisitClick={(id) => setDetailVisitId(id)}
            />
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Techs today</h2>
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground">No routes yet.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {groups.map((g) => {
                  const total = g.visits.length;
                  const done = g.visits.filter((v) => v.status === "completed").length;
                  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                  return (
                    <li key={g.staffId ?? "unassigned"} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 truncate">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ background: g.color }}
                          />
                          <span className="truncate">{g.name}</span>
                        </span>
                        <Badge variant="outline" className="tabular-nums">
                          {done}/{total}
                        </Badge>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, background: g.color }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>

            )}
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Overdue invoices</h2>
              <Link to="/invoices" className="text-xs text-primary hover:underline">
                All →
              </Link>
            </div>
            {sum?.overdueInvoices.length ? (
              <ul className="space-y-2 text-sm">
                {sum.overdueInvoices.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-2">
                    <Link
                      to="/invoices/$invoiceId"
                      params={{ invoiceId: i.id }}
                      className="truncate hover:underline"
                    >
                      {i.clientName}
                    </Link>
                    <span className="tabular-nums text-muted-foreground">
                      {fmtMoney(i.totalCents)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing overdue. 🎉</p>
            )}
          </div>
        </div>
      </div>

      <VisitDetailDrawer
        visitId={detailVisitId}
        onOpenChange={(o) => !o && setDetailVisitId(null)}
      />
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  tone?: "danger";
}) {
  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
      {hint && (
        <div
          className={`mt-1 text-xs ${
            tone === "danger" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
