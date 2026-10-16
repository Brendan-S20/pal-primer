import { PortalStayRequest } from "@/components/portal/Stays";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarPlus, MessageCircleWarning } from "lucide-react";
import { OneOffBookingCard } from "@/components/portal/OneOffBookingCard";
import {
  usePortalCtx, RequestsList, ReportGeneralConcern,
} from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/$token/requests")({
  component: PortalRequests,
});

function PortalRequests() {
  const { requestsQ, concernMut } = usePortalCtx();

  return (
    <div className="space-y-6">
      <PortalStayRequest />
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <MessageCircleWarning className="h-4 w-4 shrink-0" /> Your requests
        </h2>
        <RequestsList rows={requestsQ.data ?? []} />
      </section>

      {/* Above "Report a concern" on purpose: asking for an extra visit is a
          request, not a complaint, and it should not read as one. */}
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <CalendarPlus className="h-4 w-4 shrink-0" /> Book an extra visit
        </h2>
        <OneOffBookingCard />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Report a concern</h2>
        <ReportGeneralConcern onSubmit={(cat, msg) =>
          concernMut.mutate({ visitId: null, category: cat as any, message: msg })
        } pending={concernMut.isPending} />
      </section>
    </div>
  );
}
