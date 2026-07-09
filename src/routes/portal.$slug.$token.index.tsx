import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarDays, Sparkles, ArrowRight, Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  usePortalCtx, EmptyBox, fmtDay, fmtDayShort, fmtTime, relativeFromToday,
  money,
} from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/$token/")({
  component: PortalHome,
});

function PortalHome() {
  const { token, slug, visitsQ, historyQ, invoicesQ, clientQ } = usePortalCtx();
  const c = clientQ.data as any;
  const nextVisit = (visitsQ.data ?? [])[0];
  const openInvoice = (invoicesQ.data ?? []).find((i) => i.status !== "paid" && i.status !== "void");
  const recent = (historyQ.data ?? []).slice(0, 2);

  return (
    <div className="space-y-6">
      {/* Next visit spotlight */}
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <CalendarDays className="h-4 w-4" /> Next visit
        </h2>
        {nextVisit ? (
          <div className="rounded-lg border bg-card p-4">
            <div className="text-lg font-semibold">{fmtDay(nextVisit.scheduled_on)}</div>
            <div className="mt-1 text-sm text-muted-foreground flex flex-wrap gap-x-3">
              {nextVisit.eta_start && <span>Arriving {fmtTime(nextVisit.eta_start)}–{fmtTime(nextVisit.eta_end)}</span>}
              {relativeFromToday(nextVisit.scheduled_on) && <span>{relativeFromToday(nextVisit.scheduled_on)}</span>}
              {nextVisit.tech_name && <span>with <strong>{nextVisit.tech_name}</strong></span>}
            </div>
            <div className="mt-3">
              <Link to="/portal/$slug/$token/visits" params={{ slug, token }}>
                <Button size="sm" variant="outline" className="gap-1">
                  Manage visits <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <EmptyBox icon={<CalendarDays className="h-6 w-6" />}
            title="No visits scheduled" body="Text us to get on the route." />
        )}
      </section>

      {/* Balance / open invoice */}
      {openInvoice ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Open invoice
          </h2>
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-medium">{money(openInvoice.total_cents)}</div>
                <div className="text-xs text-muted-foreground">
                  {openInvoice.issued_at ? `Issued ${fmtDayShort(openInvoice.issued_at)}` : "Ready to pay"}
                </div>
              </div>
              <Link to="/portal/$slug/$token/billing" params={{ slug, token }}>
                <Button size="sm">Pay now</Button>
              </Link>
            </div>
          </div>
        </section>
      ) : null}

      {/* Recent history preview */}
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Camera className="h-4 w-4" /> Recent service
        </h2>
        {recent.length === 0 ? (
          <EmptyBox icon={<Camera className="h-6 w-6" />}
            title="No completed visits yet"
            body="After your first visit we'll post before/after photos here." />
        ) : (
          <ul className="space-y-2">
            {recent.map((r) => (
              <li key={r.visit_id} className="flex items-center justify-between rounded-md border bg-card p-3 text-sm">
                <div>
                  <div className="font-medium">{fmtDayShort(r.scheduled_on)}</div>
                  <div className="text-xs text-muted-foreground capitalize">{r.status}</div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {(r.photo_paths?.length ?? 0)} photo{(r.photo_paths?.length ?? 0) === 1 ? "" : "s"}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Link to="/portal/$slug/$token/requests" params={{ slug, token }}>
            <Button size="sm" variant="outline" className="gap-1">
              View full history <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </section>

      {c && (
        <p className="text-center text-xs text-muted-foreground">
          Bookmark this page — it's your private portal. Don't share the link.
        </p>
      )}
    </div>
  );
}
