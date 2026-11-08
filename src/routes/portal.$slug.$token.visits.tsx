import { PortalStayTimeline } from "@/components/portal/Stays";
import { useLaunchCopy } from "@/lib/launch-copy";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { CalendarDays } from "lucide-react";
import {
  usePortalCtx,
  UpcomingVisitsList,
  PlanRow,
  VacationHoldCard,
  EmptyBox,
  ServiceHistorySection,
} from "@/lib/portal-ui";
import { usePortalWalks, WalkReportsSection } from "@/components/portal/WalkReports";
import { TrainingCard } from "@/components/portal/TrainingCard";

export const Route = createFileRoute("/portal/$slug/$token/visits")({
  component: PortalVisits,
});

function PortalVisits() {
  const copy = useLaunchCopy();
  const {
    clientQ,
    visitsQ,
    subsQ,
    token,
    historyQ,
    signPhotosFn,
    concernMut,
    skipMut,
    rescheduleMut,
    withdrawChangeMut,
    freqMut,
    vacationMut,
    recleanMut,
    requestsQ,
  } = usePortalCtx();
  const c = clientQ.data as any;
  // Walks (#410): reports below, and each upcoming walk's window.
  const walks = usePortalWalks();
  const isCommercial = c?.account_type === "commercial";
  // A visit whose re-clean is already asked for shows that instead of the
  // button. Read from the customer's own request list, so it survives a reload
  // and a second device; the database would hand back the same ticket anyway.
  const requestedVisitIds = useMemo(
    () =>
      new Set(
        (requestsQ.data ?? [])
          .filter((t) => t.category === "reclean_request" && t.status !== "resolved" && t.visit_id)
          .map((t) => t.visit_id as string),
      ),
    [requestsQ.data],
  );

  return (
    <div className="space-y-6">
      <PortalStayTimeline />
      <TrainingCard />
      <PortalStayTimeline />
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <CalendarDays className="h-4 w-4 shrink-0" /> Upcoming visits
        </h2>
        {(visitsQ.data ?? []).length === 0 ? (
          <EmptyBox
            icon={<CalendarDays className="h-6 w-6 shrink-0" />}
            title="No visits scheduled yet"
            body={copy("Your next visit will show here once it is scheduled.")}
          />
        ) : (
          <UpcomingVisitsList
            rows={(visitsQ.data ?? []).map((v: any) => ({
              ...v,
              walk_window: walks.upcomingWindows[v.visit_id],
            }))}
            // No cutoff prop: each row carries `changes_allowed_until` from
            // the server, computed in the org's timezone by the same function
            // the reschedule and skip RPCs refuse against.
            allowReschedule={!!c?.allow_self_reschedule}
            // Defaults to 0 — no charge — because that is what the database
            // does when the org has never configured a skip rule, and because
            // a missing field must not invent a charge on screen.
            skipBillablePct={Number(c?.skip_billable_pct ?? 0)}
            onSkip={(id, reason, acceptedFeeCents, idempotencyKey) =>
              skipMut.mutate({ visitId: id, reason, acceptedFeeCents, idempotencyKey })
            }
            onReschedule={(id, newDate, acceptedFeeCents, idempotencyKey) =>
              rescheduleMut.mutate({ visitId: id, newDate, acceptedFeeCents, idempotencyKey })
            }
            onWithdraw={(requestId) => withdrawChangeMut.mutate(requestId)}
          />
        )}
      </section>

      {(subsQ.data ?? []).length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Your plan</h2>
          <ul className="space-y-2">
            {subsQ.data!.map((s) => (
              <PlanRow
                key={s.subscription_id}
                s={s}
                isCommercial={isCommercial}
                allowChange={!!c?.allow_frequency_change}
                autoApply={!!c?.auto_apply_changes}
                onChange={(f) =>
                  freqMut.mutate({ subscriptionId: s.subscription_id, frequency: f })
                }
                pending={freqMut.isPending}
              />
            ))}
          </ul>
        </section>
      )}

      {/* Outside the plan block on purpose. `subsQ` is
          portal_list_prepaid_subscriptions — it filters billing_cadence =
          'prepaid' — so nesting the hold inside it meant a POSTPAID customer
          saw no vacation hold on this tab at all, however the org had set
          allow_vacation_hold. The permission is the gate; having prepaid a
          balance is not. */}
      {c?.allow_vacation_hold && (
        <section>
          <VacationHoldCard
            autoApply={!!c?.auto_apply_changes}
            onSubmit={(v) => vacationMut.mutate(v)}
            pending={vacationMut.isPending}
          />
        </section>
      )}

      <WalkReportsSection reports={walks.reports} />

      {/* Past visits belong with visits, not under Requests (G4). */}
      <ServiceHistorySection
        rows={historyQ.data ?? []}
        signPhotos={signPhotosFn}
        token={token}
        onReport={(visitId, category, message) =>
          concernMut.mutate({ visitId, category: category as any, message })
        }
        reporting={concernMut.isPending}
        petWaste={(c as { pet_waste?: boolean } | undefined)?.pet_waste !== false}
        // The window comes from portalGetClient, read from the same column
        // portal_request_reclean refuses against. 0 means the owner switched
        // the guarantee off, and then nothing is offered.
        reclean={
          Number(c?.reclean_window_hours ?? 0) > 0
            ? {
                windowHours: Number(c.reclean_window_hours),
                businessName: c?.org_name || "The team",
                requestedVisitIds,
                onRequest: (visitId, message) => recleanMut.mutateAsync({ visitId, message }),
              }
            : undefined
        }
      />
    </div>
  );
}
