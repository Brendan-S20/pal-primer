// Persistent client header (spec): identity, status, contact, and the
// numbers that matter, with Message / Edit Client / More Actions. Status is
// DERIVED from service states (QA follow-up 4.2) so a manual flag can't
// contradict reality; missing contact info renders as warning chips.
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarOff, MessageSquare, MoreHorizontal, Navigation, Pencil, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  updateClient,
  deleteClientIfNoHistory,
  listClientHolds,
} from "@/lib/clients.functions";
import { pauseSubscription } from "@/lib/subscriptions.functions";
import { isServiceEnded } from "@/lib/subscription-form";
import { getMyOrg } from "@/lib/org.functions";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { VacationHoldDrawer } from "@/components/client-detail/VacationHoldDrawer";
import { StatusChip, MetaChip } from "@/components/client-detail/primitives";
import { formatPhone, formatDay } from "@/lib/format";

/** Active / Partially paused / Paused / Inactive, derived from services. */
export function deriveClientStatus(client: any, subscriptions: any[]): string {
  if (client.active === false) return "inactive";
  const today = new Date().toISOString().slice(0, 10);
  const live = subscriptions.filter((s) => !isServiceEnded(s, today));
  const active = live.filter((s) => s.status === "active").length;
  const paused = live.filter((s) => s.status === "paused").length;
  if (active > 0 && paused > 0) return "partially_paused";
  if (active > 0) return "active";
  if (paused > 0) return "paused";
  return "inactive";
}

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  partially_paused: "Partially paused",
  paused: "Paused",
  inactive: "Inactive",
};

export function ClientHeader({
  client,
  clientId,
  subscriptions,
  properties = [],
  propertyCount,
  activeServiceCount,
  outstandingCents,
  canBill,
  onEditClient,
}: {
  client: any;
  clientId: string;
  subscriptions: any[];
  /** Active properties; the first one drives the Navigate action. */
  properties?: any[];
  propertyCount: number;
  activeServiceCount: number;
  /** null = caller can't see billing; hide the stat rather than show 0. */
  outstandingCents: number | null;
  canBill: boolean;
  onEditClient: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const updateFn = useServerFn(updateClient);
  const deleteFn = useServerFn(deleteClientIfNoHistory);
  const pauseFn = useServerFn(pauseSubscription);
  const orgFn = useServerFn(getMyOrg);
  const { data: orgData } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => orgFn(),
    staleTime: 60_000,
  });

  // Vacation holds (QA round 8): the ••• menu opens a small drawer; an
  // active or upcoming hold shows as a chip next to the status.
  const [holdDrawerOpen, setHoldDrawerOpen] = useState(false);
  const listHoldsFn = useServerFn(listClientHolds);
  const { data: holdsData } = useQuery({
    queryKey: ["client-holds", clientId],
    queryFn: () => listHoldsFn({ data: { clientId } }),
  });
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentHold =
    (((holdsData as any)?.holds ?? []) as any[])
      .filter((h) => h.ends_on >= todayIso)
      .sort((a, b) => (a.starts_on < b.starts_on ? -1 : 1))[0] ?? null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["client", clientId] });
    qc.invalidateQueries({ queryKey: ["subs", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };

  const statusMut = useMutation({
    mutationFn: (active: boolean) => updateFn({ data: { clientId, active } }),
    onSuccess: () => {
      invalidate();
      toast.success("Client updated");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteFn({ data: { clientId } }),
    onSuccess: () => {
      toast.success("Client deleted");
      window.location.href = "/clients";
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // Import comms hold (office toggle): imported clients start with automated
  // communications paused; lifting the hold re-enables invoice emails,
  // reminders, visit texts, and review requests for this client.
  const commsHoldMut = useMutation({
    mutationFn: (paused: boolean) => updateFn({ data: { clientId, commsPaused: paused } }),
    onSuccess: (_d, paused) => {
      invalidate();
      toast.success(paused ? "Automated communications paused" : "Communications hold lifted");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const today = new Date().toISOString().slice(0, 10);
  const pausableSubs = subscriptions.filter(
    (s) => s.status === "active" && !isServiceEnded(s, today),
  );
  const pauseAllMut = useMutation({
    mutationFn: async () => {
      for (const s of pausableSubs) {
        await pauseFn({ data: { subscriptionId: s.id } });
      }
    },
    onSuccess: () => toast.success("Services paused"),
    onError: (e) =>
      toast.error(`Some services may not have paused: ${(e as Error).message}. Check the Services tab.`),
    onSettled: () => {
      // Partial failures still changed state; always refresh.
      invalidate();
      qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
    },
  });

  const slug = (orgData?.organization as any)?.portal_slug as string | undefined;
  const portalUrl =
    typeof window !== "undefined" && client.portal_token
      ? `${window.location.origin}${slug ? `/portal/${slug}/${client.portal_token}` : `/portal/${client.portal_token}`}`
      : null;

  const derivedStatus = deriveClientStatus(client, subscriptions);
  const navProperty = properties.find((p: any) => !p.archived_at) ?? null;

  const initials = (client.display_name ?? "?")
    .split(/\s+/)
    .map((w: string) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="rounded-xl border bg-card px-5 py-4 shadow-sm">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-semibold text-primary">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{client.display_name}</h1>
              <StatusChip status={derivedStatus} label={STATUS_LABELS[derivedStatus]} />
              {currentHold && (
                <StatusChip
                  status="paused"
                  label={
                    currentHold.starts_on > todayIso
                      ? `On hold from ${formatDay(currentHold.starts_on)}`
                      : `On hold until ${formatDay(currentHold.ends_on)}`
                  }
                />
              )}
              {client.comms_paused && (
                <StatusChip status="warning" label="Communications paused (imported)" />
              )}
              <MetaChip>{client.account_type === "commercial" ? "Commercial" : "Residential"}</MetaChip>
              {(client.churn_score ?? 0) >= 60 && <StatusChip status="overdue" label="At risk" />}
              {(client.tags ?? []).map((t: string) => (
                <MetaChip key={t}>{t}</MetaChip>
              ))}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {client.primary_phone ? (
                <a href={`tel:${client.primary_phone}`} className="hover:text-foreground hover:underline">
                  {formatPhone(client.primary_phone)}
                </a>
              ) : (
                <StatusChip status="warning" label="No phone" />
              )}
              {client.primary_email ? (
                // The name above truncates because it is the page's title and is
                // repeated everywhere; this is the only place the address is
                // shown, so it wraps instead. `min-w-0` is what lets it: the
                // `min-w-0` chain above means the address overflows the header
                // visibly rather than being clipped by it.
                <a
                  href={`mailto:${client.primary_email}`}
                  className="min-w-0 break-words hover:text-foreground hover:underline"
                >
                  {client.primary_email}
                </a>
              ) : (
                <StatusChip status="warning" label="No email" />
              )}
            </div>
          </div>
        </div>

        {/* MEASURED 2026-08-19: this row was laid out 485px wide inside a 286px
            parent at 360px, which is what made the whole page 585px and pushed
            nine controls off the side. Five buttons in a row that cannot wrap
            and cannot shrink; the outer row already wraps, so the overflow was
            entirely inside this one.
            `flex-wrap` rather than hiding anything below md: Call and Navigate
            are the two most useful things on this page from a driveway, so
            collapsing them into the More menu would take the phone's best
            actions away in the name of fitting the phone. */}
        <div className="flex flex-wrap items-center gap-2">
          {client.primary_phone && (
            <a href={`tel:${client.primary_phone}`}>
              <Button variant="outline" size="sm">
                <Phone className="mr-1.5 h-3.5 w-3.5" /> Call
              </Button>
            </a>
          )}
          {navProperty && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Directions to the pin when we have one, else the address.
                const dest =
                  navProperty.latitude != null && navProperty.longitude != null
                    ? `${navProperty.latitude},${navProperty.longitude}`
                    : encodeURIComponent(
                        `${navProperty.street}, ${navProperty.city} ${navProperty.postal_code}`,
                      );
                window.open(
                  `https://www.google.com/maps/dir/?api=1&destination=${dest}`,
                  "_blank",
                  "noopener",
                );
              }}
            >
              <Navigation className="mr-1.5 h-3.5 w-3.5" /> Navigate
            </Button>
          )}
          <Link to="/messages/$clientId" params={{ clientId }}>
            <Button variant="outline" size="sm">
              <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Message
            </Button>
          </Link>
          <Button size="sm" onClick={onEditClient}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit Client
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                // 40px, four short of the floor. The glyph is unchanged.
                className="h-11 w-11 p-0"
                aria-label="More actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>More actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {pausableSubs.length > 0 && (
                <DropdownMenuItem
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Pause all services?",
                        description: `${pausableSubs.length} active service${pausableSubs.length === 1 ? "" : "s"} will pause and future scheduled visits will be removed. Resume anytime from the Services tab.`,
                        confirmLabel: "Pause services",
                      })
                    )
                      pauseAllMut.mutate();
                  }}
                >
                  Pause services ({pausableSubs.length})
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setHoldDrawerOpen(true)}>
                <CalendarOff className="mr-2 h-3.5 w-3.5" /> Vacation hold…
              </DropdownMenuItem>
              {client.comms_paused ? (
                <DropdownMenuItem
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Resume automated communications?",
                        description:
                          "This imported client currently receives no automated emails or texts (invoices, reminders, visit updates, review requests). Lifting the hold turns them back on.",
                        confirmLabel: "Resume communications",
                      })
                    )
                      commsHoldMut.mutate(false);
                  }}
                >
                  Resume communications
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => commsHoldMut.mutate(true)}>
                  Pause automated communications
                </DropdownMenuItem>
              )}
              {portalUrl && (
                <>
                  <DropdownMenuItem onClick={() => window.open(portalUrl, "_blank", "noopener")}>
                    Open portal
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      navigator.clipboard.writeText(portalUrl).then(
                        () => toast.success("Portal link copied"),
                        () => toast.error("Copy failed"),
                      )
                    }
                  >
                    Copy portal link
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              {client.active === false ? (
                <DropdownMenuItem onClick={() => statusMut.mutate(true)}>
                  Reactivate client
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Archive this client?",
                        description:
                          "They disappear from active lists but keep all history. Reactivate anytime.",
                        confirmLabel: "Archive client",
                      })
                    )
                      statusMut.mutate(false);
                  }}
                >
                  Archive client
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Delete this client?",
                      description:
                        "Only allowed when they have no visits, services, or invoices. Clients with history are archived instead.",
                      confirmLabel: "Delete client",
                      destructive: true,
                    })
                  )
                    deleteMut.mutate();
                }}
              >
                Delete client
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-foreground/70">Properties</dt>
          <dd className="text-lg font-semibold">{propertyCount}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-foreground/70">Active services</dt>
          <dd className="text-lg font-semibold">{activeServiceCount}</dd>
        </div>
        {canBill && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-foreground/70">Outstanding</dt>
            <dd
              className={`text-lg font-semibold ${(outstandingCents ?? 0) > 0 ? "text-destructive" : ""}`}
            >
              ${(((outstandingCents ?? 0) as number) / 100).toFixed(2)}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs uppercase tracking-wide text-foreground/70">Client since</dt>
          <dd className="text-lg font-semibold">
            {client.created_at ? formatDay(client.created_at) : "-"}
          </dd>
        </div>
      </dl>

      <VacationHoldDrawer
        open={holdDrawerOpen}
        onClose={() => setHoldDrawerOpen(false)}
        clientId={clientId}
      />
    </header>
  );
}
