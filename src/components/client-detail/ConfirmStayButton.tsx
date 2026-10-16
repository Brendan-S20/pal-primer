import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmStay, getStayContactGaps } from "@/lib/stay-booking.functions";
import { parseDollarsToCents } from "@/lib/services";
import { stayContactGapsSentence } from "@/lib/stays";

export function ConfirmStayButton({ stayId, clientId }: { stayId: string; clientId: string }) {
  const [deposit, setDeposit] = useState("");
  const cents = parseDollarsToCents(deposit);
  const invalid = Number.isNaN(cents) || (cents != null && cents > 10_000_000);
  const fn = useServerFn(confirmStay);
  const gapsFn = useServerFn(getStayContactGaps);
  const gapsQ = useQuery({
    queryKey: ["stay-contact-gaps", stayId],
    queryFn: () => gapsFn({ data: { stayId } }),
  });
  // Warns, never blocks: the stay can be confirmed without them.
  const missing = stayContactGapsSentence(gapsQ.data?.gaps);
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => fn({ data: { stayId, ...(cents != null ? { depositCents: cents } : {}) } }),
    onSuccess: (r) => {
      toast.success("Stay confirmed. Visits and the invoice are ready.");
      const after = stayContactGapsSentence(r.gaps);
      if (after) toast.warning(after);
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
      <Button size="sm" disabled={mut.isPending || invalid} onClick={() => mut.mutate()}>
        {mut.isPending ? "Confirming…" : "Confirm stay"}
      </Button>
      {invalid && <p className="text-xs text-destructive">Enter a deposit in dollars and cents.</p>}
      {missing && (
        <p className="basis-full rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {missing} You can confirm now and add them on the client and pet forms.
        </p>
      )}
    </div>
  );
}
