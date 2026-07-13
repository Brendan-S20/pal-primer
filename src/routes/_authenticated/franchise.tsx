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
  getFranchiseRoyaltySettings,
  setChildRoyaltyRate,
  generateRoyaltyInvoices,
  listRoyaltyInvoices,
  setRoyaltyInvoiceStatus,
  type FranchiseRow,
} from "@/lib/franchise.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
            <CardTitle className="flex items-center gap-2"><Building2 className="h-5 w-5" /> Royalties &amp; multi-org rollup</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>This organization is not configured as a royalty parent yet.</p>
            <p>
              This page rolls up clients, revenue, and open AR from other HoundStack
              organizations that bill you royalties — each location runs as its own separate
              organization with its own users and data. Full multi-location management
              (shared branches, per-location user scoping) is on the roadmap.
            </p>
            <p>Once you enable it, any organization whose <code>parent_organization_id</code> points at this one will roll up here.</p>
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
          <h1 className="text-2xl font-semibold">Royalties &amp; rollup</h1>
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

      <RoyaltyBilling />
    </div>
  );
}

// Finding #16: real royalty billing (rate per child + generated royalty
// invoices against rolled-up revenue), matching the marketed capability.
function RoyaltyBilling() {
  const settingsFn = useServerFn(getFranchiseRoyaltySettings);
  const setRateFn = useServerFn(setChildRoyaltyRate);
  const genFn = useServerFn(generateRoyaltyInvoices);
  const listFn = useServerFn(listRoyaltyInvoices);
  const statusFn = useServerFn(setRoyaltyInvoiceStatus);

  const settings = useQuery({ queryKey: ["franchise", "royalty-settings"], queryFn: () => settingsFn() });
  const invoices = useQuery({ queryKey: ["franchise", "royalty-invoices"], queryFn: () => listFn() });

  const setRate = useMutation({
    mutationFn: (v: { childOrgId: string; percent: number }) => setRateFn({ data: v }),
    onSuccess: () => { toast.success("Royalty rate saved"); settings.refetch(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const generate = useMutation({
    mutationFn: () => genFn({ data: {} }),
    onSuccess: (r: any) => {
      toast.success(`Generated ${r.generated} royalty invoice(s) for ${r.periodStart} → ${r.periodEnd}`);
      invoices.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (v: { invoiceId: string; status: "draft" | "issued" | "paid" | "void" }) => statusFn({ data: v }),
    onSuccess: () => { toast.success("Updated"); invoices.refetch(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const children: any[] = (settings.data as any)?.children ?? [];
  const rows: any[] = (invoices.data as any)?.invoices ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Royalty billing</CardTitle>
        <Button size="sm" onClick={() => generate.mutate()} disabled={generate.isPending}>
          {generate.isPending ? "Generating…" : "Generate last month's royalties"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Royalty rate per location</div>
          <div className="space-y-2">
            {children.map((c) => (
              <div key={c.id} className="flex items-center gap-3 text-sm">
                <span className="min-w-40 flex-1">{c.name}</span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.25}
                  className="w-24"
                  defaultValue={Number(c.franchise_royalty_percent ?? 0)}
                  onBlur={(e) => {
                    const percent = Number(e.target.value);
                    if (!Number.isNaN(percent) && percent !== Number(c.franchise_royalty_percent ?? 0)) {
                      setRate.mutate({ childOrgId: c.id, percent });
                    }
                  }}
                />
                <span className="text-muted-foreground">% of collected revenue</span>
              </div>
            ))}
            {children.length === 0 && (
              <p className="text-sm text-muted-foreground">No child locations yet.</p>
            )}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">Royalty invoices</div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Revenue</TableHead>
                  <TableHead>Rate</TableHead>
                  <TableHead>Royalty</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const child = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>{child?.name ?? "Location"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.period_start} → {r.period_end}</TableCell>
                      <TableCell>{money(Number(r.revenue_cents))}</TableCell>
                      <TableCell>{Number(r.royalty_percent)}%</TableCell>
                      <TableCell className="font-medium">{money(Number(r.amount_cents))}</TableCell>
                      <TableCell><Badge variant={r.status === "paid" ? "secondary" : r.status === "issued" ? "default" : "outline"}>{r.status}</Badge></TableCell>
                      <TableCell className="text-right">
                        {r.status === "draft" && (
                          <button className="text-xs text-primary underline" onClick={() => setStatus.mutate({ invoiceId: r.id, status: "issued" })}>Issue</button>
                        )}
                        {r.status === "issued" && (
                          <button className="text-xs text-primary underline" onClick={() => setStatus.mutate({ invoiceId: r.id, status: "paid" })}>Mark paid</button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No royalty invoices yet — set rates and click Generate.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </CardContent>
    </Card>
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
