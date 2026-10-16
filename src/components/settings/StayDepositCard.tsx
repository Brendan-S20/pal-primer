// Settings > Services, for a business that runs pet sitting: how many days
// before a stay its deposit stays refundable (migration 20261017050000).
// Office screen, English.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getStayDepositRule, setStayDepositRule } from "@/lib/stay-deposit.functions";

export function StayDepositCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const get = useServerFn(getStayDepositRule);
  const set = useServerFn(setStayDepositRule);
  const { data } = useQuery({ queryKey: ["stay-deposit-rule"], queryFn: () => get() });
  const [days, setDays] = useState("");
  useEffect(() => {
    if (data) setDays(String(data.refundDays));
  }, [data]);
  const n = Number(days);
  const invalid = days.trim() === "" || !Number.isInteger(n) || n < 0 || n > 365;

  const save = useMutation({
    mutationFn: () => set({ data: { refundDays: n } }),
    onSuccess: () => {
      toast.success("Deposit rule saved");
      qc.invalidateQueries({ queryKey: ["stay-deposit-rule"] });
      qc.invalidateQueries({ queryKey: ["stays"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 sm:p-5">
      <div className="min-w-0">
        <h3 className="font-semibold">Stay deposits</h3>
        <p className="text-sm text-muted-foreground">
          A stay canceled at least this many days before it starts gets its deposit back. Canceled
          later, the deposit is kept as a cancellation fee. You can still refund it when you cancel.
          0 refunds up to the first day.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) save.mutate();
        }}
      >
        <div className="min-w-0">
          <Label htmlFor="stay-deposit-days">Refundable until (days before the stay)</Label>
          <Input
            id="stay-deposit-days"
            className="w-32"
            type="number"
            inputMode="numeric"
            min={0}
            max={365}
            step={1}
            value={days}
            disabled={!canEdit || !data}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        {canEdit && (
          <Button type="submit" disabled={invalid || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        )}
        {invalid && data && (
          <p className="basis-full text-xs text-destructive">Enter a whole number from 0 to 365.</p>
        )}
      </form>
    </section>
  );
}
