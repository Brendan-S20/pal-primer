import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, MailWarning, CalendarClock, PhoneOff, Activity, DollarSign, Clock } from "lucide-react";
import { getPlatformHealth } from "@/lib/platform.functions";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/platform/health")({
  head: () => ({ meta: [{ title: pageTitle("Health", "Platform admin") }, { name: "robots", content: "noindex" }] }),
  component: HealthPage,
});

const money = (c: number | null | undefined) =>
  `$${((c ?? 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function HealthPage() {
  const fn = useServerFn(getPlatformHealth);
  const q = useQuery({
    queryKey: ["platform", "health"],
    queryFn: () => fn(),
    refetchInterval: 60_000,
  });

  if (q.isLoading) return <div className="text-sm text-muted-foreground">Loading health…</div>;
  if (q.isError) return <div className="text-sm text-destructive">{(q.error as Error).message}</div>;
  const h = q.data!;

  const cards: Array<{
    label: string;
    value: string;
    sub?: string;
    icon: any;
    tone?: "ok" | "warn" | "bad";
  }> = [
    {
      // First, because it is the only card with a date attached. An expired
      // trial already loses AI and already loses "add a customer" (the
      // clients_enforce_plan_limit trigger), and no expiry email exists to warn
      // the tenant -- so this card is currently the only thing standing between
      // us and finding out from the customer.
      label: "Trials expiring \u2264 14d",
      value: String(h.trials_expiring_14d + h.trials_already_expired),
      // Two facts, not one. "A trial is expiring" is only half of what an
      // operator can act on; the half they can act on is whether we told the
      // tenant. An un-notified expiry is the state this card exists to prevent.
      sub:
        h.trials_not_notified > 0
          ? `${h.trials_not_notified} due a notice, not emailed${h.trials_already_expired > 0 ? ` \u00b7 ${h.trials_already_expired} already expired` : ""}`
          : h.trials_already_expired > 0
            ? `${h.trials_already_expired} already expired \u00b7 all emailed`
            : h.next_trial_expiry_at
              ? `${h.trials_notified > 0 ? "notice sent" : "none due a notice yet"} \u00b7 next: ${h.next_trial_expiry_org ?? "unnamed org"} on ${new Date(h.next_trial_expiry_at).toISOString().slice(0, 10)}`
              : "none in the next 14 days",
      icon: CalendarClock,
      tone:
        h.trials_already_expired > 0 || h.trials_not_notified > 0
          ? "bad"
          : h.trials_expiring_14d > 0
            ? "warn"
            : "ok",
    },
    {
      label: "Open SaaS invoices",
      value: String(h.open_invoices_count),
      sub: money(h.open_invoices_total) + " outstanding",
      icon: DollarSign,
      tone: h.open_invoices_count > 0 ? "warn" : "ok",
    },
    {
      label: "SaaS overdue > 30d",
      value: String(h.overdue_invoices_count),
      sub: money(h.overdue_invoices_total),
      icon: Clock,
      tone: h.overdue_invoices_count > 0 ? "bad" : "ok",
    },
    {
      label: "Stuck visits",
      value: String(h.stuck_visits),
      sub: "scheduled in the past & still open",
      icon: CalendarClock,
      tone: h.stuck_visits > 0 ? "bad" : "ok",
    },
    {
      label: "AI receptionist · 24h",
      value: `${h.ai_errors_24h} / ${h.ai_calls_24h}`,
      sub: "errors / total calls",
      icon: PhoneOff,
      tone: h.ai_errors_24h > 0 ? "warn" : "ok",
    },
    {
      label: "Suppressed emails",
      value: String(h.suppressed_emails),
      sub: "bounces + unsubscribes",
      icon: MailWarning,
      tone: "ok",
    },
    {
      label: "Admin actions · 24h",
      value: String(h.admin_actions_24h),
      sub: "impersonations, plan edits, etc.",
      icon: Activity,
      tone: "ok",
    },
  ];

  const anyBad = cards.some((c) => c.tone === "bad");
  const anyWarn = cards.some((c) => c.tone === "warn");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between">
            <span>System health</span>
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs font-medium " +
                (anyBad
                  ? "bg-destructive/15 text-destructive"
                  : anyWarn
                  ? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
                  : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400")
              }
            >
              {anyBad ? "Attention" : anyWarn ? "Watch" : "All clear"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => <HealthTile key={c.label} {...c} />)}
          </div>
          <p className="mt-4 flex items-center gap-1 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Refreshes every 60 seconds.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function HealthTile({
  label, value, sub, icon: Icon, tone = "ok",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: any;
  tone?: "ok" | "warn" | "bad";
}) {
  const toneClass =
    tone === "bad"
      ? "border-destructive/40 bg-destructive/5"
      : tone === "warn"
      ? "border-yellow-500/40 bg-yellow-500/5"
      : "border-border bg-card";
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
