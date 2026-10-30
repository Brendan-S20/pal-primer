// Reopen and Mark missed on a completed visit (#532).
//
// Two popups show a completed visit to the office: the shared drawer on the
// dashboard and the schedule board, and the client's Visits tab. Only the
// first had these two actions, so a visit opened from a client's page could
// not be put back. Both now draw this one component, so the role rule, the
// confirm text and the billing refusal cannot drift apart again.
//
// Every visit type comes through here (walks, stays, grooms, lessons, drop
// ins, cleanups), so the words say "visit" and nothing service specific.
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RotateCcw, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useConfirmDialog, type ConfirmOptions } from "@/components/ConfirmDialog";
import { usePermissions, type AppRole } from "@/hooks/useMyRole";
import { markVisitMissedFromOffice, reopenVisitFromOffice } from "@/lib/visits.functions";
import { BUSINESS_REASONS } from "@/lib/training-packages";
import { InvoiceThisVisit } from "@/components/InvoiceThisVisit";

export type CompletedVisitAction = "reopen" | "missed";
type MissedCode = (typeof BUSINESS_REASONS)[number];

const MISSED_REASON_LABELS: Record<MissedCode, string> = {
  our_fault: "Our fault",
  weather: "Weather",
  unsafe_conditions: "Unsafe conditions",
};

/** What each action asks first. Both say what happens to billing, because
 *  that is the question an owner has before taking a visit off completed. */
export const COMPLETED_VISIT_CONFIRM: Record<CompletedVisitAction, ConfirmOptions> = {
  reopen: {
    title: "Reopen this visit?",
    description:
      "It goes back to scheduled, or in progress if it was started, and its completion time is cleared. A reopened visit is not billed unless it is completed again.",
    confirmLabel: "Reopen visit",
  },
  missed: {
    title: "Mark this visit missed?",
    description:
      "It is recorded as missed and its completion time is cleared. A missed visit is not billed unless it is completed again. You can still mark it completed or reschedule it from here.",
    confirmLabel: "Mark missed",
  },
};

export const COMPLETED_VISIT_DONE: Record<CompletedVisitAction, string> = {
  reopen: "Visit reopened",
  missed: "Visit marked missed",
};

/** The same rule as the server's loadVisitForDispatchAction: owner, office
 *  manager and dispatcher. The UI gate is cosmetic; the server is the gate. */
export function canChangeCompletedVisit(role: AppRole | null, canBill: boolean): boolean {
  return canBill || role === "dispatcher";
}

export type CompletedVisitResult =
  | { status: "canceled" }
  | { status: "done"; message: string }
  | { status: "refused"; message: string };

/** Ask, then call the server. A refusal (the visit is already on an invoice
 *  or has a prepaid debit, from visit_completion_billing_blocker) comes back
 *  as the server's own words, so the popup can say what to fix. */
export async function runCompletedVisitAction({
  action,
  visitId,
  code,
  confirm,
  reopen,
  markMissed,
}: {
  action: CompletedVisitAction;
  visitId: string;
  code: MissedCode | null;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  reopen: (args: { data: { visitId: string } }) => Promise<unknown>;
  markMissed: (args: { data: { visitId: string; code: MissedCode | null } }) => Promise<unknown>;
}): Promise<CompletedVisitResult> {
  if (!(await confirm(COMPLETED_VISIT_CONFIRM[action]))) return { status: "canceled" };
  try {
    if (action === "reopen") await reopen({ data: { visitId } });
    else await markMissed({ data: { visitId, code } });
    return { status: "done", message: COMPLETED_VISIT_DONE[action] };
  } catch (e) {
    return {
      status: "refused",
      message: (e as Error).message || "The visit could not be changed.",
    };
  }
}

export function CompletedVisitActions({
  visit,
  onChanged,
}: {
  visit: { id: string; status: string; client_package_id?: string | null };
  /** After the server accepted the change, for the popup's own refresh. */
  onChanged?: (action: CompletedVisitAction) => void;
}) {
  const qc = useQueryClient();
  const { can, role } = usePermissions();
  const { confirm, dialog } = useConfirmDialog();
  const reopen = useServerFn(reopenVisitFromOffice);
  const markMissed = useServerFn(markVisitMissedFromOffice);
  const [pending, setPending] = useState<CompletedVisitAction | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // On a training package lesson, why it was missed. The business's own
  // reasons use no session.
  const [missedCode, setMissedCode] = useState<"" | MissedCode>("");
  useEffect(() => {
    setMissedCode("");
    setRefusal(null);
  }, [visit.id]);

  if (visit.status !== "completed") return null;

  if (!canChangeCompletedVisit(role, can("manage_client_billing"))) {
    return (
      <p className="text-xs text-muted-foreground">
        You do not have permission to change this completed visit.
      </p>
    );
  }

  async function act(action: CompletedVisitAction) {
    setRefusal(null);
    setPending(action);
    try {
      const r = await runCompletedVisitAction({
        action,
        visitId: visit.id,
        code: missedCode || null,
        confirm,
        reopen,
        markMissed,
      });
      if (r.status === "refused") {
        setRefusal(r.message);
        toast.error(r.message);
      } else if (r.status === "done") {
        toast.success(r.message);
        // Everything that draws this visit: the board, the dashboard, the
        // shared drawer, the client's Visits list and activity feed.
        qc.invalidateQueries({ queryKey: ["visits"] });
        qc.invalidateQueries({ queryKey: ["visit-detail", visit.id] });
        qc.invalidateQueries({ queryKey: ["client-visit-history"] });
        qc.invalidateQueries({ queryKey: ["client-activity"] });
        qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
        onChanged?.(action);
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-2">
      {dialog}
      {/* Invoice at completion (#605): the office bills a visit from the visit. */}
      <InvoiceThisVisit visitId={visit.id} />
      <div className="flex flex-wrap gap-2">
        {visit.client_package_id && (
          <div className="w-full space-y-1">
            <Label htmlFor={`missed-reason-${visit.id}`} className="text-xs">
              If it was missed, why
            </Label>
            <select
              id={`missed-reason-${visit.id}`}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm touch:min-h-11"
              value={missedCode}
              onChange={(e) => setMissedCode(e.target.value as typeof missedCode)}
            >
              <option value="">Client no-show</option>
              {BUSINESS_REASONS.map((code) => (
                <option key={code} value={code}>
                  {MISSED_REASON_LABELS[code]} (no session used)
                </option>
              ))}
            </select>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => act("reopen")}
          disabled={pending !== null}
        >
          <RotateCcw className="mr-1.5 h-4 w-4 shrink-0" />
          {pending === "reopen" ? "Reopening…" : "Reopen"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => act("missed")}
          disabled={pending !== null}
        >
          <SkipForward className="mr-1.5 h-4 w-4 shrink-0" />
          {pending === "missed" ? "Marking…" : "Mark missed"}
        </Button>
      </div>
      {refusal && (
        <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {refusal}
        </p>
      )}
    </div>
  );
}
