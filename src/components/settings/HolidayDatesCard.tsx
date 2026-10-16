// Settings > Services, for a business that runs pet sitting: the dates a
// sitting visit takes its service's holiday surcharge (holiday_dates,
// migration 20261017040000). These are not closures. Office screen, English.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addHoliday, deleteHoliday, listHolidays } from "@/lib/holidays.functions";
import { holidayDateLabel, holidayNightLabel } from "@/lib/stays";

export function HolidayDatesCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const list = useServerFn(listHolidays);
  const add = useServerFn(addHoliday);
  const del = useServerFn(deleteHoliday);
  const { data } = useQuery({ queryKey: ["holidays"], queryFn: () => list() });
  const [holidayOn, setHolidayOn] = useState("");
  const [name, setName] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["holidays"] });

  const addMut = useMutation({
    mutationFn: () => add({ data: { holidayOn, name: name || undefined } }),
    onSuccess: () => {
      setHolidayOn("");
      setName("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const holidays = data?.holidays ?? [];

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 sm:p-5">
      <div className="min-w-0">
        <h3 className="font-semibold">Holiday dates</h3>
        <p className="text-sm text-muted-foreground">
          Sitting visits on these dates are charged the service's holiday surcharge. You stay open:
          nothing is skipped or moved. For an overnight, the night that starts on the date counts.
          The night of Dec 24 starts on the 24th.
        </p>
      </div>

      {canEdit && (
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (holidayOn) addMut.mutate();
          }}
        >
          <div>
            <Label htmlFor="holiday-on">Date</Label>
            <Input
              id="holiday-on"
              type="date"
              value={holidayOn}
              onChange={(e) => setHolidayOn(e.target.value)}
              required
            />
          </div>
          <div className="lg:col-span-2">
            <Label htmlFor="holiday-name">Name</Label>
            <Input
              id="holiday-name"
              placeholder="Christmas Eve"
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={addMut.isPending || !holidayOn}>
              {addMut.isPending ? "Adding…" : "Add holiday"}
            </Button>
          </div>
        </form>
      )}

      {holidays.length === 0 ? (
        <p className="text-sm text-muted-foreground">No holiday dates yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {holidays.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {holidayDateLabel(h.holiday_on)}
                  {h.name && (
                    <span className="font-normal text-muted-foreground">
                      {" · "}
                      <bdi>{h.name}</bdi>
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">{holidayNightLabel(h.holiday_on)}</p>
              </div>
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={delMut.isPending}
                  onClick={() => delMut.mutate(h.id)}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
