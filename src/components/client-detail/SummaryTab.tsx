// Summary tab (spec 3.1): a 2-column desktop grid. LEFT (operational):
// alerts, visits (next + recent), active services, property snapshot.
// RIGHT (secondary): notes and the compact communication preview.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CalendarClock, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatFrequency, isServiceEnded } from "@/lib/subscription-form";
import { computeZoneVisitPrice } from "@/lib/pricing";
import { formatDay, formatDateTime, formatPhone } from "@/lib/format";
import { listClientMessages } from "@/lib/messages.functions";
import { NotesPanel } from "@/components/client-detail/NotesPanel";
import { MetaChip, SectionLabel, StatusChip } from "@/components/client-detail/primitives";

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
  dogs = [],
  zones = [],
  creditCents = null,
  billingClient = null,
  visitsLoading = false,
  creditLoading = false,
  canBill,
  onGoToTab,
}: {
  client: any;
  clientId: string;
  properties: any[];
  subscriptions: any[];
  visits: any[];
  dogs?: any[];
  zones?: any[];
  creditCents?: number | null;
  billingClient?: any | null;
  visitsLoading?: boolean;
  creditLoading?: boolean;
  canBill: boolean;
  onGoToTab: (tab: string) => void;
}) {
  const today = todayISO();
  const activeProps = properties.filter((p: any) => !p.archived_at);
  const activeSubs = subscriptions.filter(
    (s: any) => s.status === "active" && !isServiceEnded(s, today),
  );
  const upcoming = [...visits]
    .filter((v: any) => v.status === "scheduled" && v.scheduled_on >= today)
    .sort((a: any, b: any) => (a.scheduled_on < b.scheduled_on ? -1 : 1))[0];
  const recent = [...visits]
    .filter((v: any) => v.scheduled_on <= today && v.status !== "scheduled")
    .slice(0, 6);

  // Severity-tiered attention area (QA follow-up 4.1). Everything actionable
  // in one place, worst first.
  type Alert = { severity: "critical" | "warning" | "info"; text: string; tab?: string };
  const alerts: Alert[] = [];

  const futureScheduled = new Set(
    visits
      .filter((v: any) => v.status === "scheduled" && v.scheduled_on >= today)
      .map((v: any) => v.subscription_id)
      .filter(Boolean),
  );
  const stuckSubs = activeSubs.filter(
    (s: any) =>
      !futureScheduled.has(s.id) &&
      !(s.started_on && s.started_on > today) &&
      // Completed one-time services legitimately have no future visit.
      !(s.frequency === "one_time" && s.started_on && s.started_on <= today),
  );
  if (!visitsLoading && stuckSubs.length > 0)
    alerts.push({
      severity: "critical",
      text: `${stuckSubs.length} active service${stuckSubs.length === 1 ? " has" : "s have"} no scheduled visits.`,
      tab: "services",
    });

  const prepaidActive = activeSubs.some((s: any) => s.billing_cadence === "prepaid");
  if (canBill && !creditLoading && prepaidActive && (creditCents ?? 0) <= 0)
    alerts.push({
      severity: "critical",
      text: `Prepaid service with a $${(((creditCents ?? 0) as number) / 100).toFixed(2)} credit balance.`,
      tab: "billing",
    });
  if (client.autopay_paused)
    alerts.push({ severity: "critical", text: "Autopay is paused after repeated failures.", tab: "billing" });

  if (client.email_opt_out === false && !client.primary_email)
    alerts.push({
      severity: "warning",
      text: "Email notifications are enabled but there's no email address on file.",
    });
  if (client.sms_opt_out === false && !client.primary_phone)
    alerts.push({
      severity: "warning",
      text: "SMS notifications are enabled but there's no phone number on file.",
    });
  if (canBill && billingClient && !billingClient.default_payment_method_id)
    alerts.push({ severity: "warning", text: "No payment method on file.", tab: "billing" });

  // Price far below the zone's weekly baseline is suspicious even before
  // frequency multipliers (which only raise the reference).
  for (const sub of activeSubs) {
    const zone = zones.find((z: any) => z.id === sub.zone_id);
    if (!zone || !sub.price_cents) continue;
    const ref = computeZoneVisitPrice(
      {
        base_price_cents: zone.base_price_cents,
        per_dog_addl_cents: zone.per_dog_addl_cents,
        pricing_mode: (zone.pricing_mode ?? "flat") as "flat" | "per_sqft" | "per_acre",
        price_per_sqft_cents: Number(zone.price_per_sqft_cents ?? 0),
        price_per_acre_cents: zone.price_per_acre_cents,
        area_min_charge_cents: zone.area_min_charge_cents,
      },
      { dogCount: sub.dog_count ?? 1 },
    ).perVisitCents;
    if (ref > 0 && sub.price_cents < ref * 0.5) {
      alerts.push({
        severity: "warning",
        text: `A service is priced $${(sub.price_cents / 100).toFixed(2)} per visit, ${Math.round((1 - sub.price_cents / ref) * 100)}% below the ${zone.name} zone baseline.`,
        tab: "services",
      });
      break;
    }
  }

  const activeDogTotal = dogs.filter((d: any) => d.active !== false).length;
  const billedDogs = activeSubs.some(
    (s: any) => s.account_type === "residential" && (s.dog_count ?? 0) > 0,
  );
  if (billedDogs && activeDogTotal === 0)
    alerts.push({
      severity: "warning",
      text: "Services bill for dogs but no dog records exist on the properties.",
      tab: "properties",
    });

  // The arrival window lives on the service (UX round 4); legacy property
  // windows still count so migrated clients aren't nagged.
  if (
    activeSubs.length > 0 &&
    activeSubs.every((s: any) => !s.earliest_time && !s.latest_time) &&
    activeProps.every((p: any) => !p.earliest_service_time && !p.latest_service_time)
  )
    alerts.push({ severity: "info", text: "No arrival window configured (visits can happen anytime).", tab: "services" });
  if (activeProps.some((p: any) => !p.boundary))
    alerts.push({
      severity: "info",
      text: "A property has no boundary drawn, so yard size and time estimates are incomplete.",
      tab: "properties",
    });
  if (client.sms_opt_out) alerts.push({ severity: "info", text: "Client has opted out of SMS." });
  if ((client.churn_score ?? 0) >= 60)
    alerts.push({ severity: "info", text: "High churn risk score." });

  const order = { critical: 0, warning: 1, info: 2 } as const;
  alerts.sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
      {/* LEFT: operational */}
      <div className="space-y-6">
        {alerts.length > 0 && (
          <section className="rounded-lg border p-4">
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" /> Needs attention
            </h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {alerts.map((a) => (
                <li key={a.text} className="flex items-start gap-2">
                  <StatusChip
                    status={a.severity === "critical" ? "overdue" : a.severity === "warning" ? "warning" : "scheduled"}
                    label={a.severity === "critical" ? "Critical" : a.severity === "warning" ? "Warning" : "Info"}
                    className="mt-0.5 shrink-0"
                  />
                  <span>
                    {a.text}
                    {a.tab && (
                      <button
                        type="button"
                        onClick={() => onGoToTab(a.tab!)}
                        className="ml-1.5 text-primary underline underline-offset-2 hover:no-underline"
                      >
                        Review
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Visits */}
        <section className="rounded-lg border bg-card shadow-sm p-5">
          <h2 className="text-sm font-medium">Visits</h2>
          <div className="mt-2 rounded-md border bg-muted/20 p-3 text-sm">
            <SectionLabel className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" /> Next visit
            </SectionLabel>
            {upcoming ? (
              <div className="mt-1">
                {formatDay(upcoming.scheduled_on)}
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
                  {formatDay(v.scheduled_on)}
                  {v.properties?.street ? ` · ${v.properties.street}` : ""}
                </span>
                <StatusChip status={v.status} />
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

        {/* Active services */}
        <section className="rounded-lg border bg-card shadow-sm p-5">
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
        </section>

        {/* Properties snapshot */}
        <section className="rounded-lg border bg-card shadow-sm p-5">
          <h2 className="text-sm font-medium">Properties</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {activeProps.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {p.street}, {p.city}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <MetaChip>{p.boundary ? "Boundary" : "No boundary"}</MetaChip>
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

      {/* RIGHT: secondary */}
      <div className="space-y-6">
        <NotesPanel clientId={clientId} />
        <CommunicationCard client={client} onGoToTab={onGoToTab} />
      </div>
    </div>
  );
}

// Compact preview only (QA follow-up 2.1): the full thread, portal panel,
// reviews, and referrals live on the Communication tab.
function CommunicationCard({ client, onGoToTab }: { client: any; onGoToTab: (t: string) => void }) {
  const listFn = useServerFn(listClientMessages);
  const { data } = useQuery({
    queryKey: ["client-messages", client.id],
    queryFn: () => listFn({ data: { clientId: client.id } }),
  });
  const messages: any[] = (data as any)?.messages ?? [];
  const last = messages[messages.length - 1];

  return (
    <section className="rounded-lg border bg-card shadow-sm p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <MessageSquare className="h-4 w-4 text-muted-foreground" /> Communication
        </h2>
        <Button size="sm" variant="outline" onClick={() => onGoToTab("communication")}>
          Message
        </Button>
      </div>
      {last ? (
        <div className="mt-2 text-sm">
          <p className="truncate text-muted-foreground">
            {last.direction === "inbound" ? "From client: " : "Sent: "}
            {last.body}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Last contact {formatDateTime(last.created_at)}
            {client.primary_phone ? ` · ${formatPhone(client.primary_phone)}` : ""}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          No messages yet.
          {client.primary_phone ? "" : " Add a phone number to text this client."}
        </p>
      )}
    </section>
  );
}
