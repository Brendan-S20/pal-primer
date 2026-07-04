import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getFranchiseContext,
  getFranchiseRollup,
  getFranchiseTrend,
  markSelfAsFranchiseParent,
  type FranchiseRow,
} from "@/lib/franchise.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, ArrowUp, ArrowDown } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";

export const Route = createFileRoute("/_authenticated/franchise")({
  component: FranchisePage,
});

const money = (c: number) =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LINE_COLORS = [
  "hsl(217 91% 60%)", "hsl(0 84% 60%)", "hsl(142 71% 45%)", "hsl(35 92% 55%)",
  "hsl(262 83% 62%)", "hsl(190 91% 45%)", "hsl(330 81% 60%)", "hsl(82 76% 45%)",
];

type SortKey = keyof FranchiseRow;

function FranchisePage() {
  const ctxFn = useServerFn(getFranchiseContext);
  const rollupFn = useServerFn(getFranchiseRollup);
  const trendFn = useServerFn(getFranchiseTrend);
  const ctx = useQuery({ queryKey: ["franchise", "ctx"], queryFn: () => ctxFn() });
  const rollup = useQuery({
    queryKey: ["franchise", "rollup"],
    queryFn: () => rollupFn(),
    enabled: !!ctx.data?.isParent,
  });
  const trend = useQuery({
    queryKey: ["franchise", "trend"],
    queryFn: () => trendFn(),
    enabled: !!ctx.data?.isParent,
  });

  const [sortBy, setSortBy] = useState<SortKey>("revenue_mtd_cents");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const markFn = useServerFn(markSelfAsFranchiseParent);
  const mark = useMutation({
    mutationFn: () => markFn(),
    onSuccess: () => { toast.success("Marked as franchise parent"); ctx.refetch(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(() => {
    const src: FranchiseRow[] = rollup.data?.rows ?? [];
    return [...src].sort((a, b) => {
      const av = a[sortBy];
      const bv = b[sortBy];
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
  }, [rollup.data, sortBy, sortDir]);

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

  if (ctx.isLoading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!ctx.data?.isParent) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" /> Franchise rollup</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>This organization is not configured as a franchise parent yet.</p>
            <p>Once you enable it, any organization whose <code>parent_organization_id</code> points at this one will roll up its clients, revenue, and open AR here.</p>
            <Button onClick={() => mark.mutate()} disabled={mark.isPending}>
              {mark.isPending ? "Marking…" : "Mark this org as a franchise parent"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortBy(key); setSortDir("desc"); }
  };

  const locations = trend.data?.locations ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-semibold">Franchise rollup</h1>
          <p className="text-sm text-muted-foreground">
            {ctx.data.org?.name} — {rows.length} location{rows.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Active clients" value={totals.clients.toLocaleString()} />
        <StatCard label="Visits today" value={`${totals.done}/${totals.visits}`} />
        <StatCard label="Revenue MTD" value={money(totals.rev)} />
        <StatCard label="AR open" value={money(totals.ar)} />
      </div>

      <Card>
        <CardHeader><CardTitle>Revenue trend — last 8 weeks</CardTitle></CardHeader>
        <CardContent>
          {trend.isLoading ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground">Loading…</div>
          ) : (trend.data?.weeks ?? []).length === 0 ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
              No child locations linked yet.
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend.data?.weeks ?? []}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                  <Tooltip formatter={(v: any) => `$${Number(v).toLocaleString()}`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {locations.map((loc, i) => (
                    <Line
                      key={loc.id}
                      type="monotone"
                      dataKey={loc.id}
                      name={loc.name}
                      stroke={LINE_COLORS[i % LINE_COLORS.length]}
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>By location</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead label="Location" col="organization_name" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} />
                <SortableHead label="Techs" col="tech_count" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortableHead label="Active clients" col="active_clients" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortableHead label="Today" col="visits_today" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortableHead label="Revenue MTD" col="revenue_mtd_cents" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortableHead label="AR open" col="ar_open_cents" sortBy={sortBy} sortDir={sortDir} onClick={toggleSort} align="right" />
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

function SortableHead({
  label, col, sortBy, sortDir, onClick, align,
}: {
  label: string; col: SortKey; sortBy: SortKey; sortDir: "asc" | "desc";
  onClick: (k: SortKey) => void; align?: "right";
}) {
  const active = sortBy === col;
  return (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button
        className={`inline-flex items-center gap-1 ${align === "right" ? "ml-auto" : ""} hover:text-foreground transition`}
        onClick={() => onClick(col)}
      >
        {label}
        {active && (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </TableHead>
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
