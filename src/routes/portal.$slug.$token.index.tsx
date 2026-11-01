import { useLaunchCopy } from "@/lib/launch-copy";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, Sparkles, ArrowRight, Camera, Scissors } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TrainingCard } from "@/components/portal/TrainingCard";
import {
  usePortalCtx,
  usePortalTimezone,
  EmptyBox,
  fmtDay,
  fmtDayShort,
  relativeFromToday,
  money,
} from "@/lib/portal-ui";
import { orgLocalTime } from "@/lib/org-day";

export const Route = createFileRoute("/portal/$slug/$token/")({
  component: PortalHome,
});

function PortalHome() {
  const copy = useLaunchCopy();
  const { token, slug, visitsQ, historyQ, invoicesQ, clientQ } = usePortalCtx();
  // ETAs are instants and print on the ORG's clock, not the reader's device.
  const tz = usePortalTimezone();
  const c = clientQ.data as any;
  const visits = (visitsQ.data ?? []) as any[];
  const nextVisit = visits[0];
  // Multi-property clients (#29): label which property the next visit is at.
  const distinctAddrs = new Set(
    visits
      .map((v) => `${v.street ?? ""}|${v.city ?? ""}|${v.postal_code ?? ""}`)
      .filter((s) => s !== "||"),
  );
  const showProperty = distinctAddrs.size > 1;
  const nextAddr = nextVisit
    ? [nextVisit.street, nextVisit.city, nextVisit.postal_code].filter(Boolean).join(", ")
    : "";
  // G1: show the client's full debt picture, not just the first open invoice.
  const billing = invoicesQ.data;
  const openCount = billing?.openCount ?? 0;
  const overdueCount = billing?.overdueCount ?? 0;
  const recent = (historyQ.data ?? []).slice(0, 2);

  return (
    <div className="space-y-6">
      {/* Next visit spotlight */}
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <CalendarDays className="h-4 w-4 shrink-0" /> Next visit
        </h2>
        {nextVisit ? (
          <div className="rounded-lg border bg-card p-4">
            <div className="text-lg font-semibold">{fmtDay(nextVisit.scheduled_on)}</div>
            {showProperty && nextAddr && (
              <div className="mt-0.5 text-sm font-medium text-foreground">{nextAddr}</div>
            )}
            <div className="mt-1 text-sm text-muted-foreground flex flex-wrap gap-x-3">
              {nextVisit.eta_start && (
                <span>
                  Arriving {orgLocalTime(nextVisit.eta_start, tz)}
                  {nextVisit.eta_end ? `–${orgLocalTime(nextVisit.eta_end, tz)}` : ""}
                </span>
              )}
              {relativeFromToday(nextVisit.scheduled_on) && (
                <span>{relativeFromToday(nextVisit.scheduled_on)}</span>
              )}
              {nextVisit.tech_name && (
                <span>
                  with <strong>{nextVisit.tech_name}</strong>
                </span>
              )}
            </div>
            <div className="mt-3">
              <Link to="/portal/$slug/$token/visits" params={{ slug, token }}>
                <Button size="sm" variant="outline" className="gap-1">
                  Manage visits <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <EmptyBox
            icon={<CalendarDays className="h-6 w-6 shrink-0" />}
            title="No visits scheduled"
            body={copy("Call or email us to schedule a visit.")}
          />
        )}
      </section>

      {/* Balance / open invoices (G1: count + total + overdue, never hidden) */}
      {openCount > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 shrink-0" />{" "}
            {openCount === 1 ? "Open invoice" : "Open invoices"}
          </h2>
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">
                  {openCount} open invoice{openCount === 1 ? "" : "s"} ·{" "}
                  {money(billing!.openTotalCents)}
                  {overdueCount > 0 && (
                    <span className="ml-1 text-destructive">· {overdueCount} overdue</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {overdueCount > 0
                    ? "Please pay the overdue balance to keep service on schedule."
                    : billing?.nextDueOn
                      ? `Next due ${fmtDayShort(billing.nextDueOn)}`
                      : "Ready to pay"}
                </div>
              </div>
              <Link to="/portal/$slug/$token/billing" params={{ slug, token }}>
                <Button size="sm">Pay now</Button>
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {/* The way in to Grooming, for a client whose business runs it. */}
      {c?.mobile_grooming && (
        <section className="rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <Scissors className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h2 className="font-semibold">Grooming</h2>
                <p className="text-sm text-muted-foreground">
                  {c?.groom_requests
                    ? "Request a groom and keep your pet's vaccine records up to date."
                    : "Keep your pet's vaccine records up to date."}
                </p>
              </div>
            </div>
            <Link to="/portal/$slug/$token/grooming" params={{ slug, token }}>
              <Button size="sm" variant="outline" className="gap-1">
                Open grooming <ArrowRight className="h-3.5 w-3.5 shrink-0" />
              </Button>
            </Link>
          </div>
        </section>
      )}

      <TrainingCard />

      {/* Recent history preview */}
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Camera className="h-4 w-4 shrink-0" /> Recent service
        </h2>
        {recent.length === 0 ? (
          <EmptyBox
            icon={<Camera className="h-6 w-6 shrink-0" />}
            title="No completed visits yet"
            body="After your first visit, its photos and notes will show here."
          />
        ) : (
          <ul className="space-y-2">
            {recent.map((r) => (
              <li
                key={r.visit_id}
                className="flex items-center justify-between rounded-md border bg-card p-3 text-sm"
              >
                <div>
                  <div className="font-medium">{fmtDayShort(r.scheduled_on)}</div>
                  <div className="text-xs text-muted-foreground capitalize">{r.status}</div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {r.photo_paths?.length ?? 0} photo{(r.photo_paths?.length ?? 0) === 1 ? "" : "s"}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Link to="/portal/$slug/$token/visits" params={{ slug, token }}>
            <Button size="sm" variant="outline" className="gap-1">
              View full history <ArrowRight className="h-3.5 w-3.5 shrink-0" />
            </Button>
          </Link>
        </div>
      </section>

      {c && (
        <p className="text-center text-xs text-muted-foreground">
          Bookmark this page. It's your private portal. Don't share the link.
        </p>
      )}
    </div>
  );
}
