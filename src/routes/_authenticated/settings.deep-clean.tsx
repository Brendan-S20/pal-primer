import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getDeepCleanSettings, updateDeepCleanSettings } from "@/lib/subscriptions.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { titleHead } from "@/lib/page-title";
import { SettingsLoadGate } from "@/components/settings/SettingsLoadGate";

export const Route = createFileRoute("/_authenticated/settings/deep-clean")({
  head: () => titleHead("Deep clean", "Settings"),
  component: DeepCleanSettings,
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function DeepCleanSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getDeepCleanSettings);
  const updateFn = useServerFn(updateDeepCleanSettings);
  const q = useQuery({ queryKey: ["deep-clean"], queryFn: () => getFn() });

  // Before #945 these started as off, March and October, $49.00, and an
  // effect copied the saved values in once they arrived. Until then (and for
  // good, on a failed load) the form showed those defaults with Save
  // enabled, and Save wrote them over the real surcharge. Now each field is
  // the saved value until the owner changes it, and the form waits for it.
  const [enabledEdit, setEnabled] = useState<boolean | null>(null);
  const [monthsEdit, setMonths] = useState<number[] | null>(null);
  const [dollarsEdit, setDollars] = useState<string | null>(null);
  const enabled = enabledEdit ?? q.data?.enabled ?? false;
  const months = monthsEdit ?? q.data?.months ?? [];
  const dollars = dollarsEdit ?? (q.data ? (q.data.chargeCents / 100).toFixed(2) : "");

  const save = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          enabled,
          months: [...months].sort((a, b) => a - b),
          chargeCents: Math.round(parseFloat(dollars || "0") * 100),
        },
      }),
    onSuccess: () => {
      toast.success("Deep-clean pricing saved");
      setEnabled(null);
      setMonths(null);
      setDollars(null);
      qc.invalidateQueries({ queryKey: ["deep-clean"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });

  const toggleMonth = (m: number) =>
    setMonths(months.includes(m) ? months.filter((x) => x !== m) : [...months, m]);

  return (
    <div className="space-y-6">
      {/* Every other Settings sub-page opens with a heading and a line saying
          what the page is for. Two of them dropped the reader straight into a
          card, so navigating the sidebar made the page start in a different
          place depending on which tab you landed on. */}
      <div>
        <h2 className="text-lg font-semibold">Deep clean</h2>
        <p className="text-sm text-muted-foreground">
          An extra charge added automatically in the months when yards need more work.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Seasonal deep-clean surcharge</CardTitle>
        </CardHeader>
        <CardContent>
          <SettingsLoadGate query={q} what="deep-clean settings" fields={3}>
            <div className="space-y-6">
              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <div className="font-medium">Automatically add a deep-clean charge</div>
                  <div className="text-xs text-muted-foreground">
                    Added to the first invoice of each selected month for every active recurring
                    client.
                  </div>
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} />
              </div>

              <div>
                <Label>Months</Label>
                <div className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {MONTHS.map((label, idx) => {
                    const m = idx + 1;
                    const active = months.includes(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => toggleMonth(m)}
                        disabled={!enabled}
                        className={`touch:min-h-11 rounded-md border px-2 py-1.5 text-sm transition-colors ${
                          active
                            ? "border-primary bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:bg-muted"
                        } ${!enabled ? "opacity-50" : ""}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Common cadence: March (post-winter thaw) and October (leaf drop).
                </div>
              </div>

              <div className="max-w-xs">
                <Label htmlFor="dc-price">Charge amount (USD)</Label>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-muted-foreground">$</span>
                  <Input
                    id="dc-price"
                    type="number"
                    step="0.01"
                    min="0"
                    disabled={!enabled}
                    value={dollars}
                    onChange={(e) => setDollars(e.target.value)}
                  />
                </div>
              </div>

              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </SettingsLoadGate>
        </CardContent>
      </Card>
    </div>
  );
}
