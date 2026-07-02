import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getFranchiseContext, getFranchiseRollup, type FranchiseRow } from "@/lib/franchise.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Building2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/franchise")({
  component: FranchisePage,
});

const money = (c: number) => `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function FranchisePage() {
  const ctxFn = useServerFn(getFranchiseContext);
  const rollupFn = useServerFn(getFranchiseRollup);
  const ctx = useQuery({ queryKey: ["franchise", "ctx"], queryFn: () => ctxFn() });
  const rollup = useQuery({
    queryKey: ["franchise", "rollup"],
    queryFn: () => rollupFn(),
    enabled: !!ctx.data?.isParent,
  });

  if (ctx.isLoading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!ctx.data?.isParent) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" /> Franchise rollup</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>This organization is not configured as a franchise parent.</p>
            <p>Mark it as a parent and link child organizations by setting <code>parent_organization_id</code> on each child org.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const rows: FranchiseRow[] = rollup.data?.rows ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      clients: acc.clients + r.active_clients,
      visits: acc.visits + r.visits_today,
      done: acc.done + r.visits_completed_today,
      rev: acc.rev + Number(r.revenue_mtd_cents),
      ar: acc.ar + Number(r.ar_open_cents),
      techs: acc.techs + r.tech_count,
    }),
    { clients: 0, visits: 0, done: 0, rev: 0, ar: 0, techs: 0 },
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-semibold">Franchise rollup</h1>
          <p className="text-sm text-muted-foreground">{ctx.data.org?.name} — {rows.length} location{rows.length === 1 ? "" : "s"}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Active clients" value={totals.clients.toLocaleString()} />
        <StatCard label="Visits today" value={`${totals.done}/${totals.visits}`} />
        <StatCard label="Revenue MTD" value={money(totals.rev)} />
        <StatCard label="AR open" value={money(totals.ar)} />
      </div>

      <Card>
        <CardHeader><CardTitle>By location</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Techs</TableHead>
                <TableHead className="text-right">Active clients</TableHead>
                <TableHead className="text-right">Today</TableHead>
                <TableHead className="text-right">Revenue MTD</TableHead>
                <TableHead className="text-right">AR open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rollup.isLoading && (<TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">Loading…</TableCell></TableRow>)}
              {!rollup.isLoading && rows.length === 0 && (<TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No child organizations linked yet.</TableCell></TableRow>)}
              {rows.map((r) => {
                const pct = r.visits_today > 0 ? Math.round((r.visits_completed_today / r.visits_today) * 100) : 0;
                return (
                  <TableRow key={r.organization_id}>
                    <TableCell className="font-medium">{r.organization_name}</TableCell>
                    <TableCell className="text-right">{r.tech_count}</TableCell>
                    <TableCell className="text-right">{r.active_clients}</TableCell>
                    <TableCell className="text-right">
                      {r.visits_completed_today}/{r.visits_today}
                      {r.visits_today > 0 && <Badge variant="secondary" className="ml-2">{pct}%</Badge>}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(r.revenue_mtd_cents))}</TableCell>
                    <TableCell className="text-right">{money(Number(r.ar_open_cents))}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}
