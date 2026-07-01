import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listVisitsForDay, generateVisits, assignRoute, listStaff } from "@/lib/visits.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/routes")({
  component: RoutesPage,
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function RoutesPage() {
  const [day, setDay] = useState(todayISO());
  const [through, setThrough] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });
  const [staffId, setStaffId] = useState<string>("");

  const listV = useServerFn(listVisitsForDay);
  const listS = useServerFn(listStaff);
  const gen = useServerFn(generateVisits);
  const assign = useServerFn(assignRoute);
  const qc = useQueryClient();

  const { data: visits } = useQuery({
    queryKey: ["visits", day],
    queryFn: () => listV({ data: { day } }),
  });
  const { data: staff } = useQuery({ queryKey: ["staff"], queryFn: () => listS() });

  const genMut = useMutation({
    mutationFn: () => gen({ data: { through } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visits"] }),
  });
  const assignMut = useMutation({
    mutationFn: () => assign({ data: { staffId, day, reassign: false } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["visits", day] }),
  });

  const rows = visits?.visits ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Routes</h1>
        <p className="text-sm text-muted-foreground">
          Generate recurring visits from active subscriptions and assign a day to a tech in
          naive zone-ordered sequence.
        </p>
      </div>

      <div className="grid gap-4 rounded-lg border bg-card p-5 sm:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Generate visits</h2>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="through">Through date</Label>
              <Input id="through" type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
            </div>
            <Button onClick={() => genMut.mutate()} disabled={genMut.isPending}>
              {genMut.isPending ? "Generating…" : "Generate"}
            </Button>
          </div>
          {genMut.data && (
            <p className="text-sm text-muted-foreground">Inserted {genMut.data.inserted} visits.</p>
          )}
          {genMut.error && <p className="text-sm text-destructive">{(genMut.error as Error).message}</p>}
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-medium">Assign day to tech</h2>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="day">Day</Label>
              <Input id="day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </div>
            <div className="flex-1">
              <Label htmlFor="tech">Tech</Label>
              <select
                id="tech"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Select…</option>
                {(staff?.staff ?? []).map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name} ({s.role})
                  </option>
                ))}
              </select>
            </div>
            <Button onClick={() => assignMut.mutate()} disabled={!staffId || assignMut.isPending}>
              {assignMut.isPending ? "Assigning…" : "Assign"}
            </Button>
          </div>
          {assignMut.data && (
            <p className="text-sm text-muted-foreground">Assigned {assignMut.data.assigned} visits.</p>
          )}
          {assignMut.error && (
            <p className="text-sm text-destructive">{(assignMut.error as Error).message}</p>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-medium">Visits on {day}</h2>
          <span className="text-xs text-muted-foreground">{rows.length} total</span>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2">#</th>
              <th className="px-4 py-2">Tech</th>
              <th className="px-4 py-2">Client</th>
              <th className="px-4 py-2">Address</th>
              <th className="px-4 py-2">Zone</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v: any) => (
              <tr key={v.id} className="border-t">
                <td className="px-4 py-2">{v.sequence ?? "—"}</td>
                <td className="px-4 py-2">{v.staff?.display_name ?? <span className="text-muted-foreground">Unassigned</span>}</td>
                <td className="px-4 py-2">{v.clients?.display_name ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {v.properties ? `${v.properties.street}, ${v.properties.city} ${v.properties.postal_code}` : "—"}
                </td>
                <td className="px-4 py-2">{v.zones?.name ?? "—"}</td>
                <td className="px-4 py-2">
                  <Badge variant="secondary">{v.status}</Badge>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                  No visits scheduled for this day. Generate some, or add a subscription.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
