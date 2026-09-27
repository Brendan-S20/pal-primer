import { createFileRoute } from "@tanstack/react-router";
import { MessageCircleWarning } from "lucide-react";
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
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <MessageCircleWarning className="h-4 w-4 shrink-0" /> Your requests
        </h2>
        <RequestsList rows={requestsQ.data ?? []} />
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
