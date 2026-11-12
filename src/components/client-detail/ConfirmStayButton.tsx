import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmStay, getStayContactGaps } from "@/lib/stay-booking.functions";
import { parseDollarsToCents } from "@/lib/services";
import { medLine, stayContactGapsSentence } from "@/lib/stays";

export function ConfirmStayButton({
  stayId,
  clientId,
  canSetDeposit = true,
}: {
  stayId: string;
  clientId: string;
  /** False for a dispatcher (booking without manage_pricing): they confirm
   *  at the service's price, and a deposit is a price decision. */
  canSetDeposit?: boolean;
}) {
  const [deposit, setDeposit] = useState("");
  const cents = canSetDeposit ? parseDollarsToCents(deposit) : null;
  const invalid = Number.isNaN(cents) || (cents != null && cents > 10_000_000);
  const fn = useServerFn(confirmStay);
  const gapsFn = useServerFn(getStayContactGaps);
  const gapsQ = useQuery({
    queryKey: ["stay-contact-gaps", stayId],
    queryFn: () => gapsFn({ data: { stayId } }),
  });
  // Warns, never blocks: the stay can be confirmed without them.
  // But the same read carries the client's care changes (#611), which
  // confirming applies, so Confirm waits for it and stays off if it fails.
  const unseen = !gapsQ.isSuccess;
  const missing = stayContactGapsSentence(gapsQ.data?.gaps);
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => fn({ data: { stayId, ...(cents != null ? { depositCents: cents } : {}) } }),
    onSuccess: (r) => {
      toast.success("Stay confirmed. Visits and the invoice are ready.");
      const after = stayContactGapsSentence(r.gaps);
      if (after) toast.warning(after);
      if (r.clash) toast.warning(r.clash);
      for (const queryKey of [
        ["stays", clientId],
        ["requested-stays"],
        ["subs", clientId],
        ["client-visit-history", clientId],
        ["invoices"],
        ["client-invoices", clientId],
      ])
        qc.invalidateQueries({ queryKey });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex flex-wrap items-end gap-2">
      {canSetDeposit && (
        <div className="min-w-0">
          <Label htmlFor={`stay-deposit-${stayId}`}>Deposit ($), optional</Label>
          <Input
            id={`stay-deposit-${stayId}`}
            className="w-40"
            inputMode="decimal"
            placeholder="0.00"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
            disabled={mut.isPending}
          />
        </div>
      )}
      <Button size="sm" disabled={mut.isPending || invalid || unseen} onClick={() => mut.mutate()}>
        {mut.isPending ? "Confirming…" : gapsQ.isPending ? "Checking…" : "Confirm stay"}
      </Button>
      {invalid && <p className="text-xs text-destructive">Enter a deposit in dollars and cents.</p>}
      {gapsQ.isError && (
        <div
          role="alert"
          data-stay-check-failed={stayId}
          className="flex basis-full flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
        >
          <span className="min-w-0">
            Could not load this request's details, including any care changes from the client. Try
            again before confirming.
          </span>
          <Button size="sm" variant="outline" onClick={() => gapsQ.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {gapsQ.data?.clash && (
        <p
          role="alert"
          className="basis-full rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
        >
          {gapsQ.data.clash}
        </p>
      )}
      {(gapsQ.data?.careChanges?.length ?? 0) > 0 && (
        <div
          data-stay-care-changes={stayId}
          className="basis-full rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs"
        >
          <p className="font-medium">
            The client sent care changes. Confirming puts them on the sitter's card now, including
            for any stay already under way.
          </p>
          <ul className="mt-1 space-y-1">
            {gapsQ.data!.careChanges.map((c) => (
              <li key={c.petId} className="break-words">
                <span className="font-medium">{c.petName}:</span>
                {"feeding" in c && <span> Feeding: {c.feeding || "(cleared)"}.</span>}
                {c.meds && (
                  <span>
                    {" "}
                    Medication: {c.meds.length > 0 ? c.meds.map(medLine).join("; ") : "(none)"}.
                  </span>
                )}
                {"otherCare" in c && <span> Other care: {c.otherCare || "(cleared)"}.</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {missing && (
        <p className="basis-full rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {missing} You can confirm now and add them on the client and pet forms.
        </p>
      )}
    </div>
  );
}
