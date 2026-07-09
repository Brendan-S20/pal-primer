import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";
import {
  usePortalCtx, UpcomingVisitsList, PlanRow, VacationHoldCard, EmptyBox,
} from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/$token/visits")({
  component: PortalVisits,
});

function PortalVisits() {
  const {
    clientQ, visitsQ, subsQ,
    skipMut, rescheduleMut, freqMut, vacationMut,
  } = usePortalCtx();
  const c = clientQ.data as any;
  const isCommercial = c?.account_type === "commercial";

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <CalendarDays className="h-4 w-4" /> Upcoming visits
        </h2>
        {(visitsQ.data ?? []).length === 0 ? (
          <EmptyBox icon={<CalendarDays className="h-6 w-6" />}
            title="No visits scheduled yet"
            body="We'll text you when the next one is on the calendar." />
        ) : (
          <UpcomingVisitsList
            rows={visitsQ.data ?? []}
            cutoffHours={c?.reschedule_cutoff_hours ?? 18}
            allowReschedule={!!c?.allow_self_reschedule}
            onSkip={(id, reason) => skipMut.mutate({ visitId: id, reason })}
            onReschedule={(id, newDate) => rescheduleMut.mutate({ visitId: id, newDate })}
          />
        )}
      </section>

      {(subsQ.data ?? []).length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Your plan</h2>
          <ul className="space-y-2">
            {subsQ.data!.map((s) => (
              <PlanRow key={s.subscription_id} s={s} isCommercial={isCommercial}
                allowChange={!!c?.allow_frequency_change}
                autoApply={!!c?.auto_apply_changes}
                onChange={(f) => freqMut.mutate({ subscriptionId: s.subscription_id, frequency: f })}
                pending={freqMut.isPending} />
            ))}
          </ul>
          {c?.allow_vacation_hold && (
            <div className="mt-3">
              <VacationHoldCard autoApply={!!c?.auto_apply_changes}
                onSubmit={(v) => vacationMut.mutate(v)}
                pending={vacationMut.isPending} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
