import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AiSection, DigestPanel, MarketingPanel } from "@/components/ai/AiPanels";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getMyOrg } from "@/lib/org.functions";
import { getPlatformContext } from "@/lib/platform.functions";
import { getDashboardSummary } from "@/lib/dashboard.functions";
import { getBillingStatus } from "@/lib/billing.functions";
import { hasPermission } from "@/lib/permissions";
import { humanizeRole } from "@/lib/humanize";
import type { AppRole } from "@/hooks/useMyRole";
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
  // Collapsed by default, phones only — see the note by the toggle. Desktop
  // ignores this entirely: the map is always rendered above `md`.
  const [mapOpen, setMapOpen] = useState(false);

  const { data: orgData, isLoading: orgLoading } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => orgFn(),
  });
  const { data: sum, isLoading: sumLoading } = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => sumFn(),
    refetchInterval: 60_000,
  });
  const role = orgData?.organization?.role as AppRole | undefined;
  const { data: billing } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => billingFn(),
    staleTime: 60_000,
    retry: false,
    enabled: hasPermission(role ?? null, "manage_org_billing"),
  });

  // Platform admins have no tenant org by design. If one lands here (bookmark,
  // "Back to app", a stale session) send them to the platform console instead
  // of the broken "No organization yet" screen (H5 #3).
  const orgMissing = !orgLoading && !orgData?.organization;
  const platformFn = useServerFn(getPlatformContext);
  const { data: platformCtx, isLoading: platformLoading } = useQuery({
    queryKey: ["platform", "ctx"],
    queryFn: () => platformFn(),
    staleTime: 60_000,
    enabled: orgMissing,
  });
  const navigate = useNavigate();
  useEffect(() => {
    if (orgMissing && platformCtx?.isPlatformAdmin) {
      navigate({ to: "/platform" });
    }
  }, [orgMissing, platformCtx, navigate]);

  if (orgLoading) return <p className="text-muted-foreground">Loading…</p>;

  const org = orgData?.organization;
  if (!org) {
    if (platformLoading || platformCtx?.isPlatformAdmin) {
      return <p className="text-muted-foreground">Loading…</p>;
    }
    return (
      <div className="rounded-lg border bg-card p-6">
        <h1 className="text-xl font-semibold">No organization yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign out and use the Create account tab to finish onboarding.
        </p>
      </div>
    );
  }

  const groups = sum ? buildTechGroups(sum.todayVisits as MapVisit[], sum.staff as any) : [];

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
        // The Weather page was replaced by the header forecast popover; Routes
        // hosts the day-level weather check + reschedule tools.
        to: "/routes",
        tone: "warn",
      });
    }
    if ((sum.overdueCount ?? 0) > 0) {
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
        to: "/concerns",
        tone: "warn",
      });
    }
  }

  const completed = sum?.visitCounts.completed ?? 0;
  const total = sum?.visitCounts.total ?? 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // ── THE PHONE READS THIS PAGE IN A DIFFERENT ORDER ────────────────────────
  //
  // The DOM below is the desktop order, and it is deliberately still the
  // desktop order: money tiles, map, techs, then the AI panels. Above `md`
  // nothing here applies and the page is exactly the laid-out grid it always
  // was. Below `md` the same markup is re-sequenced so that "what is happening
  // today" — the alert chips, then per-tech progress, then the map — is what
  // you get for the first screenful, and the money tiles and AI panels are
  // scrolled to rather than scrolled past. An owner opening this in a driveway
  // is asking who is where and what went wrong, not what was collected MTD.
  //
  // Two things about how it is done, both of which are easy to undo by
  // accident:
  //
  //   It is `max-md:order-N` and not `order-N md:order-none`. The second form
  //   emits a rule that applies at every width and then a second rule that
  //   takes it back, so any future `md:`-and-up utility that lands in the same
  //   cascade layer can leave a stray order on the desktop grid. `max-md:` is
  //   only ever inside `@media (width < 48rem)`, which is what makes "desktop
  //   is untouched" a property of the CSS rather than of remembering to pair
  //   every order with its reset.
  //
  //   The header, the onboarding card and the alert strip carry no order class
  //   at all. `order` defaults to 0 and every numbered sibling here is
  //   positive, so they sort ahead of all three ordered blocks for free — the
  //   phone order is 0,0,0 → 1 → 2 → 3. Giving one of them an explicit
  //   `max-md:order-N` would silently drop it below the ones that have none.
  //
  // No query, no branch and no formatting changes with width; this is purely
  // where the boxes sit.
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{org.name}</h1>
          <p className="text-sm text-muted-foreground">Signed in as {humanizeRole(org.role)}</p>
        </div>
        {/* `size="sm"` is `h-8` — a 32px target, and on a phone these two are
            the only navigation in the header of the first screen the owner
            sees. `max-md:min-h-11` wins over the variant's fixed `height`
            because used height is max(min-height, height), so the button grows
            to 44px on touch without a second size variant and without moving a
            pixel above `md`. Same lever as `ui/tabs.tsx`. */}
        <div className="flex gap-2">
          <Link to="/routes">
            <Button variant="outline" size="sm" className="max-md:min-h-11">
              Today's routes
            </Button>
          </Link>
          <Link to="/clients">
            <Button variant="outline" size="sm" className="max-md:min-h-11">
              Clients
            </Button>
          </Link>
        </div>
      </div>

      <OnboardingChecklist />

      {alerts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {alerts.map((a, i) => {
            const Icon = a.icon;
            // Almost every alert carries a `to`, so this strip is mostly a row
            // of links — and since the reorder above it is now the first thing
            // under the header on a phone, it is the most-tapped control on the
            // page. `py-1.5` around a 20px line box is 32px. The min-height is
            // on the chip rather than only on the linked ones so a rare
            // unlinked alert does not sit two-thirds the height of its
            // neighbours; `items-center` keeps the glyph and label centred in
            // the taller box, so nothing looks padded.
            const content = (
              <div
                className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm max-md:min-h-11 ${
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
              <Link key={i} to={a.to}>
                {content}
              </Link>
            ) : (
              <div key={i}>{content}</div>
            );
          })}
        </div>
      )}

      <div className="grid gap-4 max-md:order-2 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={Users}
          label="Active clients"
          value={sum ? String(sum.activeClients) : "-"}
          hint={billing?.planName ? `On the ${billing.planName} plan` : undefined}
        />
        {/* Financial KPIs are null for roles without view_financials — the
            server never computes them, so there is nothing to hide client-side. */}
        {(!sum || sum.mtdRevenueCents !== null) && (
          <KpiCard
            icon={DollarSign}
            label="Collected MTD"
            value={sum ? fmtMoney(sum.mtdRevenueCents ?? 0) : "-"}
            // IMP-10: net of this month's refunds and chargebacks. The hint
            // appears only when something came back — an org that has never had
            // a reversal keeps the card it already knows, and when the figure
            // does drop it says why instead of leaving an owner to wonder.
            hint={
              sum && (sum.mtdRefundsCents ?? 0) !== 0
                ? `${fmtMoney(sum.mtdGrossCents ?? 0)} in, ${fmtMoney(sum.mtdRefundsCents ?? 0)} refunded`
                : undefined
            }
          />
        )}
        {(!sum || sum.arOpenCents !== null) && (
          <KpiCard
            icon={Receipt}
            label="AR open"
            value={sum ? fmtMoney(sum.arOpenCents ?? 0) : "-"}
            hint={sum && (sum.overdueCount ?? 0) > 0 ? `${sum.overdueCount} overdue` : undefined}
            tone={sum && (sum.overdueCount ?? 0) > 0 ? "danger" : undefined}
          />
        )}
        <KpiCard
          icon={CalendarCheck}
          label="Visits today"
          value={sum ? `${completed} / ${total}` : "-"}
          hint={total > 0 ? `${pct}% done` : "None scheduled"}
        />
        {sum && sum.mtdRevenueCents === null && (
          <KpiCard
            icon={UserX}
            label="Unassigned today"
            value={String(sum.unassignedToday)}
            hint={sum.unassignedToday > 0 ? "Needs assignment" : "All covered"}
            tone={sum.unassignedToday > 0 ? "danger" : undefined}
          />
        )}
      </div>

      <div className="grid gap-4 max-md:order-1 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4 max-md:order-2 lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Today's map</h2>
            <div className="flex items-center gap-3">
              {/* Phone only. A 380px interactive map in the middle of a
                  scrolling page is a scroll trap on touch: a drag that starts
                  on the map pans the map, so the thumb has to find the narrow
                  margin beside it to get past. On a pointer device the wheel
                  scrolls the page and there is nothing to escape, which is why
                  this is `md:hidden` rather than a control everywhere. */}
              <button
                type="button"
                onClick={() => setMapOpen((v) => !v)}
                className="max-md:min-h-11 text-xs text-primary underline-offset-2 hover:underline md:hidden"
                aria-expanded={mapOpen}
              >
                {mapOpen ? "Hide map" : "Show map"}
              </button>
              <Link to="/routes" className="text-xs text-primary hover:underline">
                Open routes →
              </Link>
            </div>
          </div>
          <div className={mapOpen ? "" : "max-md:hidden"}>
            {sumLoading ? (
              <div className="flex h-[380px] items-center justify-center text-sm text-muted-foreground">
                Loading map…
              </div>
            ) : groups.length === 0 ? (
              <div className="flex h-[380px] items-center justify-center text-sm text-muted-foreground">
                No visits scheduled today.
              </div>
            ) : (
              <RouteMap groups={groups} height={380} onVisitClick={(id) => setDetailVisitId(id)} />
            )}
          </div>
          {/* Not a placeholder for the map: the count is the one thing the map
              was being scrolled past to learn. */}
          <p className={`text-xs text-muted-foreground md:hidden ${mapOpen ? "hidden" : ""}`}>
            {sumLoading
              ? "Loading…"
              : groups.length === 0
                ? "No visits scheduled today."
                : `${groups.reduce((n, g) => n + g.visits.length, 0)} visits across ${groups.length} route${groups.length === 1 ? "" : "s"}.`}
          </p>
        </div>

        <div className="space-y-4 max-md:order-1">
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

          {/* Billing card: overdueInvoices is null (not empty) for roles
              without view_financials (H4 — dispatchers must not see a billing
              card at all, not even an empty one). */}
          {sum?.overdueInvoices !== null && (
            <div className="rounded-lg border bg-card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Overdue invoices</h2>
                <Link to="/invoices" className="text-xs text-primary hover:underline">
                  All →
                </Link>
              </div>
              {sum?.overdueInvoices?.length ? (
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
          )}
        </div>
      </div>

      {/* Owner-facing AI summaries live on the dashboard (punch list #11). */}
      <div className="flex flex-col gap-6 max-md:order-3">
        <AiSection
          title="AI: weekly digest"
          description="Owner-focused summary of the last 7 days."
        >
          <DigestPanel />
        </AiSection>
        <AiSection
          title="AI: marketing content"
          description="Draft posts, captions, and email blasts."
        >
          <MarketingPanel />
        </AiSection>
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
