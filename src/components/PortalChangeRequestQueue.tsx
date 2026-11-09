// The owner's approval queue for portal reschedules and skips (#730, D6;
// audit F-18: "office Requests tab empty").
//
// Anyone who can see client names sees what is waiting, so the office knows
// a visit may move. Only an owner approves or denies; for everybody else the
// buttons are replaced by a sentence, and the server and the database refuse
// them anyway.
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { usePermissions } from "@/hooks/useMyRole";
import { formatDay } from "@/lib/format";
import { humanizeEnum } from "@/lib/humanize";
import { formatCents } from "@/lib/portal-change";
import {
  decidePortalChangeRequest,
  listPortalChangeRequests,
  type PortalChangeRequestRow,
} from "@/lib/portal-change.functions";

export function PortalChangeRequestQueue() {
  const { can } = usePermissions();
  const listFn = useServerFn(listPortalChangeRequests);
  const q = useQuery({
    queryKey: ["portal-change-requests", "pending"],
    queryFn: () => listFn({ data: { status: "pending" } }),
    enabled: can("view_client_directory"),
  });
  if (q.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Reschedule and skip requests could not be loaded.
      </p>
    );
  const rows = q.data?.rows ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="portal-change-queue-heading">
      <h2 id="portal-change-queue-heading" className="text-lg font-semibold">
        Reschedules and skips waiting for approval
      </h2>
      <ul className="space-y-3">
        {rows.map((r) => (
          <RequestRow key={r.id} r={r} canDecide={!!q.data?.canDecide} />
        ))}
      </ul>
    </section>
  );
}

function RequestRow({ r, canDecide }: { r: PortalChangeRequestRow; canDecide: boolean }) {
  const qc = useQueryClient();
  const decideFn = useServerFn(decidePortalChangeRequest);
  const [note, setNote] = useState("");
  const mut = useMutation({
    mutationFn: (approve: boolean) => decideFn({ data: { requestId: r.id, approve, note } }),
    onSuccess: (out) => {
      toast.success(out.status === "approved" ? "Approved. The schedule is updated." : "Denied");
      qc.invalidateQueries({ queryKey: ["portal-change-requests"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const client = Array.isArray(r.clients) ? r.clients[0] : r.clients;
  return (
    <li className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 break-words">
            <Link
              to="/clients/$clientId"
              params={{ clientId: r.client_id }}
              className="inline-flex min-h-11 items-center font-medium text-primary underline"
            >
              {client?.display_name ?? "Client"}
            </Link>
            <p className="text-sm">
              {r.kind === "reschedule"
                ? `Move the ${formatDay(r.original_date)} visit to ${formatDay(r.requested_date ?? "")}`
                : `Skip the ${formatDay(r.original_date)} visit`}
            </p>
            <p className="text-xs text-muted-foreground">
              {humanizeEnum(r.service_line)}
              {r.fee_cents > 0 ? ` · late, ${formatCents(r.fee_cents)} fee if approved` : ""}
            </p>
            {r.fee_disclosed_cents != null && r.fee_disclosed_cents > 0 && (
              <p className="text-xs text-muted-foreground">
                The client was shown and accepted a {formatCents(r.fee_disclosed_cents)} late-change
                fee.
              </p>
            )}
          </div>
        </div>
        <Badge variant="outline" className="shrink-0">
          Waiting
        </Badge>
      </div>
      {r.reason && <p className="whitespace-pre-wrap break-words text-sm">“{r.reason}”</p>}
      {canDecide ? (
        <div className="space-y-2">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 500))}
            placeholder="Note (optional, kept with the request)"
            aria-label="Note for this decision"
            rows={2}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={mut.isPending} onClick={() => mut.mutate(true)}>
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={mut.isPending}
              onClick={() => mut.mutate(false)}
            >
              Deny
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Waiting for the owner to approve or deny.</p>
      )}
    </li>
  );
}
