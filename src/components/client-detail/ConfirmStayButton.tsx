import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmStay } from "@/lib/stay-booking.functions";
import { parseDollarsToCents } from "@/lib/services";

export function ConfirmStayButton({ stayId, clientId }: { stayId: string; clientId: string }) {
  const [deposit, setDeposit] = useState("");
  const cents = parseDollarsToCents(deposit);
  const invalid = Number.isNaN(cents) || (cents != null && cents > 10_000_000);
  const fn = useServerFn(confirmStay);
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => fn({ data: { stayId, ...(cents != null ? { depositCents: cents } : {}) } }),
    onSuccess: () => {
      toast.success("Stay confirmed. Visits and the invoice are ready.");
      for (const queryKey of [["stays", clientId], ["requested-stays"], ["subs", clientId], ["client-visit-history", clientId], ["invoices"], ["client-invoices", clientId]]) qc.invalidateQueries({ queryKey });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return <div className="flex flex-wrap items-end gap-2">
    <div className="min-w-0"><Label htmlFor={`stay-deposit-${stayId}`}>Deposit ($), optional</Label><Input id={`stay-deposit-${stayId}`} className="w-40" inputMode="decimal" placeholder="0.00" value={deposit} onChange={(e) => setDeposit(e.target.value)} disabled={mut.isPending} /></div>
    <Button size="sm" disabled={mut.isPending || invalid} onClick={() => mut.mutate()}>{mut.isPending ? "Confirming…" : "Confirm stay"}</Button>
    {invalid && <p className="text-xs text-destructive">Enter a deposit in dollars and cents.</p>}
  </div>;
}
