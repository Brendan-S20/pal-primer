// Summary tab (spec): operational information only — upcoming visit, recent
// visits, active services, property snapshot, alerts, notes (all three
// systems), and client communication.
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatFrequency } from "@/lib/subscription-form";
import { NotesPanel } from "@/components/client-detail/NotesPanel";
import {
  MessageComposer,
  PortalLinkPanel,
  ReviewsReferralPanel,
} from "@/components/client-detail/comms-panels";

const STATUS_TONE: Record<string, string> = {
  completed: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  scheduled: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  in_progress: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  skipped: "bg-muted text-muted-foreground",
  canceled: "bg-destructive/10 text-destructive",
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function SummaryTab({
  client,
  clientId,
  properties,
  subscriptions,
  visits,
  canBill,
  onGoToTab,
}: {
  client: any;
  clientId: string;
  properties: any[];
  subscriptions: any[];
  visits: any[];
  canBill: boolean;
  onGoToTab: (tab: string) => void;
}) {
  const today = todayISO();
  const activeProps = properties.filter((p: any) => !p.archived_at);
  const activeSubs = subscriptions.filter(
    (s: any) => s.status === "active" && (!s.ends_on || s.ends_on >= today),
  );
  const upcoming = [...visits]
    .filter((v: any) => v.status === "scheduled" && v.scheduled_on >= today)
    .sort((a: any, b: any) => (a.scheduled_on < b.scheduled_on ? -1 : 1))[0];
  const recent = [...visits]
    .filter((v: any) => v.scheduled_on <= today && v.status !== "scheduled")
    .slice(0, 6);

  // Operational alerts, in one place instead of scattered badges.
  const alerts: string[] = [];
  if (client.autopay_paused) alerts.push("Autopay is paused after repeated failures.");
  if ((client.churn_score ?? 0) >= 60) alerts.push("High churn risk score.");
  if (activeProps.some((p: any) => !p.boundary))
    alerts.push("A property has no boundary drawn, so yard size and time estimates are incomplete.");
  const hazardCount = activeProps.reduce(
    (n: number, p: any) =>
      n +
      [
        p.do_not_enter_if_dog_out,
        p.aggressive_dog,
        p.escape_risk,
        p.invisible_fence,
        p.dog_in_yard_during_service,
        p.bees_wasps,
        p.sharp_objects,
        p.slippery_surfaces,
      ].filter(Boolean).length,
    0,
  );
  if (hazardCount > 0) alerts.push(`${hazardCount} safety hazard${hazardCount > 1 ? "s" : ""} flagged across properties.`);
  if (client.sms_opt_out) alerts.push("Client has opted out of SMS.");

  return (
    <div className="space-y-6">
      {alerts.length > 0 && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> Alerts
          </h2>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
            {alerts.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Visits */}
        <section className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-medium">Visits</h2>
          <div className="mt-2 rounded-md border bg-muted/20 p-3 text-sm">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" /> Next visit
            </div>
            {upcoming ? (
              <div className="mt-1">
                {upcoming.scheduled_on}
                {upcoming.properties?.street && (
                  <span className="text-muted-foreground"> at {upcoming.properties.street}</span>
                )}
                {upcoming.staff?.display_name && (
                  <span className="text-muted-foreground"> · {upcoming.staff.display_name}</span>
                )}
              </div>
            ) : (
              <div className="mt-1 text-muted-foreground">Nothing scheduled.</div>
            )}
          </div>
          <ul className="mt-3 space-y-1.5 text-sm">
            {recent.map((v: any) => (
              <li key={v.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {v.scheduled_on}
                  {v.properties?.street ? ` · ${v.properties.street}` : ""}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[v.status] ?? "bg-muted"}`}
                >
                  {String(v.status).replace("_", " ")}
                </span>
              </li>
            ))}
            {recent.length === 0 && (
              <li className="text-sm text-muted-foreground">No past visits yet.</li>
            )}
          </ul>
          <button
            type="button"
            onClick={() => onGoToTab("visits")}
            className="mt-2 text-xs text-primary hover:underline"
          >
            View all visits
          </button>
        </section>

        {/* Services + properties snapshot */}
        <section className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-medium">Active services</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {activeSubs.map((s: any) => {
              const street = properties.find((p: any) => p.id === s.property_id)?.street;
              return (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <span>
                    {formatFrequency(s)}
                    {street && <span className="text-muted-foreground"> at {street}</span>}
                  </span>
                  <span className="font-medium">${(s.price_cents / 100).toFixed(2)}</span>
                </li>
              );
            })}
            {activeSubs.length === 0 && (
              <li className="text-sm text-muted-foreground">No active services.</li>
            )}
          </ul>
          <button
            type="button"
            onClick={() => onGoToTab("services")}
            className="mt-2 text-xs text-primary hover:underline"
          >
            Manage services
          </button>

          <h2 className="mt-5 text-sm font-medium">Properties</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {activeProps.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {p.street}, {p.city}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  {p.boundary ? (
                    <Badge variant="secondary" className="text-[10px]">
                      Boundary
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      No boundary
                    </Badge>
                  )}
                  {p.gate_code && <span>Gate {p.gate_code}</span>}
                </span>
              </li>
            ))}
            {activeProps.length === 0 && (
              <li className="text-sm text-muted-foreground">No properties yet.</li>
            )}
          </ul>
          <button
            type="button"
            onClick={() => onGoToTab("properties")}
            className="mt-2 text-xs text-primary hover:underline"
          >
            View properties
          </button>
        </section>
      </div>

      <NotesPanel clientId={clientId} />

      <MessageComposer client={client} />

      {canBill && client.portal_token && (
        <section className="rounded-lg border bg-card p-5">
          <PortalLinkPanel clientId={clientId} portalToken={client.portal_token} />
        </section>
      )}

      <ReviewsReferralPanel client={client} />
    </div>
  );
}
