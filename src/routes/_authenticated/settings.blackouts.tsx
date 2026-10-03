import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listBlackouts, addBlackout, deleteBlackout } from "@/lib/blackouts.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HelpTip } from "@/components/HelpTip";

export const Route = createFileRoute("/_authenticated/settings/blackouts")({
  component: BlackoutsPage,
});

function BlackoutsPage() {
  const list = useServerFn(listBlackouts);
  const add = useServerFn(addBlackout);
  const del = useServerFn(deleteBlackout);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["blackouts"], queryFn: () => list() });
  const [blackoutOn, setBlackoutOn] = useState("");
  const [reason, setReason] = useState("");

  const addMut = useMutation({
    mutationFn: () => add({ data: { blackoutOn, reason: reason || undefined } }),
    onSuccess: () => {
      setBlackoutOn("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["blackouts"] });
    },
  });
  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blackouts"] }),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          Blackout dates <HelpTip article="blackouts" />
        </h2>
        <p className="text-sm text-muted-foreground">
          Holidays and office closures. Visits scheduled on these days will be bumped to the next
          available day (up to 2 weeks).
        </p>
      </div>

      <form
        // Four columns from lg, two below it. At 768 four columns of a
        // 424px form were 97px each, and "Add blackout" is 118 — it ran past
        // the page's right edge.
        className="grid gap-3 rounded-lg border bg-card p-5 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (blackoutOn) addMut.mutate();
        }}
      >
        <div>
          <Label htmlFor="d">Date</Label>
          <Input
            id="d"
            type="date"
            value={blackoutOn}
            onChange={(e) => setBlackoutOn(e.target.value)}
            required
          />
        </div>
        <div className="lg:col-span-2">
          <Label htmlFor="r">Reason</Label>
          <Input
            id="r"
            placeholder="Thanksgiving"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={addMut.isPending || !blackoutOn}>
            {addMut.isPending ? "Adding…" : "Add blackout"}
          </Button>
        </div>
        {addMut.error && (
          <p className="col-span-full text-sm text-destructive">
            {(addMut.error as Error).message}
          </p>
        )}
      </form>

      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">Reason</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.blackouts ?? []).map((b: any) => (
              <tr key={b.id} className="border-b last:border-0">
                <td className="px-4 py-2 font-medium">{b.blackout_on}</td>
                <td className="px-4 py-2 text-muted-foreground">{b.reason ?? "-"}</td>
                <td className="px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => delMut.mutate(b.id)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
            {data && data.blackouts.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                  No blackout dates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
