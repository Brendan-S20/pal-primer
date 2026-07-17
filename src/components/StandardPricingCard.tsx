// Org-wide Standard Price (client detail refactor): the baseline the zone
// comparison is measured against in the service pricing panel. Optional —
// leave blank and the comparison row is hidden.
//
// QA round 3 (C5): moved off the top of the Zones page into Settings >
// Preferences, where the rest of the workspace-wide configuration lives.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getStandardPricing, updateStandardPricing } from "@/lib/subscriptions.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function StandardPricingCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getStandardPricing);
  const updateFn = useServerFn(updateStandardPricing);
  const { data } = useQuery({ queryKey: ["std-pricing"], queryFn: () => getFn() });

  const [base, setBase] = useState<string | null>(null);
  const [perDog, setPerDog] = useState<string | null>(null);
  const baseVal =
    base ?? (data?.basePriceCents != null ? (data.basePriceCents / 100).toFixed(2) : "");
  const perDogVal =
    perDog ?? (data?.perDogAddlCents != null ? (data.perDogAddlCents / 100).toFixed(2) : "");

  const mut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          basePriceCents: baseVal ? Math.round(parseFloat(baseVal) * 100) : null,
          perDogAddlCents: perDogVal ? Math.round(parseFloat(perDogVal) * 100) : null,
        },
      }),
    onSuccess: () => {
      toast.success("Standard pricing saved");
      qc.invalidateQueries({ queryKey: ["std-pricing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Standard pricing</h2>
          <p className="mt-1 max-w-lg text-xs text-muted-foreground">
            Your company-wide baseline per visit. Service pricing shows this next to the zone price
            so nothing gets replaced silently. Leave blank to hide the comparison.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate();
          }}
        >
          <div>
            <Label htmlFor="std-base" className="text-xs">
              Base price ($/visit)
            </Label>
            <Input
              id="std-base"
              type="number"
              min="0"
              step="0.01"
              className="w-32"
              value={baseVal}
              onChange={(e) => setBase(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="std-dog" className="text-xs">
              Per extra dog ($)
            </Label>
            <Input
              id="std-dog"
              type="number"
              min="0"
              step="0.01"
              className="w-32"
              value={perDogVal}
              onChange={(e) => setPerDog(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={mut.isPending}>
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      </div>
    </Card>
  );
}
