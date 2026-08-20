import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  getFranchiseAdjustments,
  type FranchiseRow,
} from "@/lib/franchise.functions";
import { FranchiseAdjustmentTrail } from "@/components/FranchiseAdjustmentTrail";
import {
  FranchiseSettlementStatements,
  type SettlementStatementRow,
} from "@/components/FranchiseSettlementStatements";
import { FranchiseLocationDrawer } from "@/components/FranchiseLocationDrawer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Building2, ArrowUp, ArrowDown } from "lucide-react";
import { PaymentRouting } from "@/components/PaymentRouting";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { HelpTip } from "@/components/HelpTip";
import { PlanGate } from "@/components/PlanGate";
import { FranchiseLinkCodes } from "@/components/FranchiseLinkCodes";
import { ProvisionLocation } from "@/components/ProvisionLocation";

export const Route = createFileRoute("/_authenticated/franchise")({
  // BUILD-1: the whole surface is Enterprise. The pricing page sells "Parent
  // and child organization structure with full rollup" and "Franchise
  // management, royalty billing, and regional dashboards" there and nowhere
  // else; every function on this page was reachable from a $79 Launch org.
  // Unlike Analytics there is no partial split — nothing on this route belongs
  // to a lower tier. The server functions enforce it independently.
  component: () => (
    <PlanGate entitlement="franchise_structure">
      <FranchisePage />
    </PlanGate>
  ),
});

const money = (c: number) =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const LINE_COLORS = [
  "hsl(217 91% 60%)",
  "hsl(0 84% 60%)",
  "hsl(142 71% 45%)",
  "hsl(35 92% 55%)",
  "hsl(262 83% 62%)",
  "hsl(190 91% 45%)",
  "hsl(330 81% 60%)",
  "hsl(82 76% 45%)",
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
  const [drillInto, setDrillInto] = useState<FranchiseRow | null>(null);

  // The drill-down reads the SAME query keys the panels below already use, so
  // this adds no fetch and — more to the point — cannot show a figure that
  // disagrees with the one further down the page. Re-querying per location
  // would put two answers to one question on the same screen.
  const qc = useQueryClient();
  const listFn = useServerFn(listRoyaltyInvoices);
  const adjustmentsFn = useServerFn(getFranchiseAdjustments);
  const royaltySettingsFn = useServerFn(getFranchiseRoyaltySettings);
  const statusFn = useServerFn(setRoyaltyInvoiceStatus);
  const invoicesQ = useQuery({
    queryKey: ["franchise", "royalty-invoices"],
    queryFn: () => listFn(),
    enabled: !!ctx.data?.isParent,
  });
  const adjustmentsQ = useQuery({
    queryKey: ["franchise", "adjustments"],
    queryFn: () => adjustmentsFn(),
    enabled: !!ctx.data?.isParent,
  });
  const royaltySettingsQ = useQuery({
    queryKey: ["franchise", "royalty-settings"],
    queryFn: () => royaltySettingsFn(),
    enabled: !!ctx.data?.isParent,
  });
  const drillStatus = useMutation({
    mutationFn: (v: { invoiceId: string; status: "draft" | "issued" | "paid" | "void" }) =>
      statusFn({ data: v }),
    onSuccess: () => {
      toast.success("Updated");
      qc.invalidateQueries({ queryKey: ["franchise", "royalty-invoices"] });
      qc.invalidateQueries({ queryKey: ["franchise", "adjustments"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markFn = useServerFn(markSelfAsFranchiseParent);
  const mark = useMutation({
    mutationFn: () => markFn(),
    onSuccess: () => {
      toast.success("Marked as franchise parent");
      ctx.refetch();
    },
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
      gross: acc.gross + Number(r.revenue_mtd_gross_cents),
      refunds: acc.refunds + Number(r.refunds_mtd_cents),
      ar: acc.ar + Number(r.ar_open_cents),
      techs: acc.techs + r.tech_count,
    }),
    { clients: 0, visits: 0, done: 0, gross: 0, refunds: 0, rev: 0, ar: 0, techs: 0 },
  );

  // Revenue MTD is NET of this month's refunds and chargebacks. Showing only
  // the net would hand a franchise owner a figure that cannot be reconciled
  // against the location's settlement statement, which itemises gross, refunds
  // and net — they would be looking at two numbers that disagree with no way to
  // tell which is wrong. So the components appear alongside it.
  //
  // Only when there is a refund, following /reports: an org that has never had
  // one keeps exactly the table it already knows, and the extra columns are a
  // signal in themselves when they do appear.
  const hasRefunds = totals.refunds > 0;
  const columnCount = hasRefunds ? 8 : 6;

  if (ctx.isLoading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!ctx.data?.isParent) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" /> Royalties &amp; multi-org rollup
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-3">
            <p>This organization is not set up as a franchise yet.</p>
            <p>
              This page rolls up active clients, visits, revenue, and open balances from the
              locations in your franchise. Each location runs as its own organization with its own
              users and client records — you see their totals, not their customers.
            </p>
            {/* BUILD-6: this used to say "any organization whose
                parent_organization_id points at this one will roll up here",
                which described editing a database column by hand — the only way
                to link anything, because no linking flow existed. It does now,
                two ways, and which one is right depends on whether the location
                already exists. */}
            <p>
              There are two ways to add one. If you&apos;re <strong>starting</strong> a location,
              open it below — we create it, link it, and email the people who work there. If the
              location is an <strong>existing business</strong> already running on HoundStack, set
              this organization up as the franchise and send its owner an invitation code instead,
              so their clients and history come across with them.
            </p>
            <Button onClick={() => mark.mutate()} disabled={mark.isPending} variant="outline">
              {mark.isPending ? "Marking…" : "Set up as a franchise (for invitation codes)"}
            </Button>
          </CardContent>
        </Card>

        {/* Opening a location marks this organization as the franchise on its
            own — provision_franchise_location sets is_franchise_parent — so
            there is no reason to make someone press a button first and then do
            the thing they came here to do. */}
        <div className="mt-6">
          <ProvisionLocation />
        </div>
      </div>
    );
  }

  const toggleSort = (key: SortKey) => {
    if (sortBy === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortBy(key);
      setSortDir("desc");
    }
  };

  const locations = trend.data?.locations ?? [];

  type RoyaltyChild = { id: string; franchise_royalty_percent: number | null };
  const royaltyChildren = (royaltySettingsQ.data?.children ?? []) as RoyaltyChild[];
  const drillRoyaltyPercent = drillInto
    ? (royaltyChildren.find((c) => c.id === drillInto.organization_id)?.franchise_royalty_percent ??
      null)
    : null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6" />
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            Royalties &amp; rollup <HelpTip article="royalties" />
          </h1>
          <p className="text-sm text-muted-foreground">
            {ctx.data.org?.name}: {rows.length} location{rows.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {/* Opening a location comes first: it is the common case (a franchise
          starting a location) and the one that needs no coordination with
          anyone. Codes are for the rarer acquisition case. */}
      <ProvisionLocation />
      <FranchiseLinkCodes />

      <div
        className={`grid gap-4 ${hasRefunds ? "md:grid-cols-3 xl:grid-cols-6" : "md:grid-cols-4"}`}
      >
        <StatCard label="Active clients" value={totals.clients.toLocaleString()} />
        <StatCard label="Visits today" value={`${totals.done}/${totals.visits}`} />
        {hasRefunds && <StatCard label="Collected MTD" value={money(totals.gross)} />}
        {hasRefunds && (
          <StatCard
            label="Refunds MTD"
            value={`-${money(totals.refunds)}`}
            valueClass="text-destructive"
          />
        )}
        <StatCard
          label={hasRefunds ? "Net revenue MTD" : "Revenue MTD"}
          value={money(totals.rev)}
        />
        <StatCard label="AR open" value={money(totals.ar)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Revenue trend: last 8 weeks</CardTitle>
        </CardHeader>
        <CardContent>
          {trend.isLoading ? (
            <div className="h-64 flex items-center justify-center text-muted-foreground">
              Loading…
            </div>
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
        <CardHeader>
          <CardTitle>By location</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead
                  label="Location"
                  col="organization_name"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onClick={toggleSort}
                />
                <SortableHead
                  label="Techs"
                  col="tech_count"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onClick={toggleSort}
                  align="right"
                />
                <SortableHead
                  label="Active clients"
                  col="active_clients"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onClick={toggleSort}
                  align="right"
                />
                <SortableHead
                  label="Today"
                  col="visits_today"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onClick={toggleSort}
                  align="right"
                />
                {hasRefunds && (
                  <SortableHead
                    label="Collected"
                    col="revenue_mtd_gross_cents"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onClick={toggleSort}
                    align="right"
                  />
                )}
                {hasRefunds && (
                  <SortableHead
                    label="Refunds"
                    col="refunds_mtd_cents"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onClick={toggleSort}
                    align="right"
                  />
                )}
                <SortableHead
                  label={hasRefunds ? "Net revenue MTD" : "Revenue MTD"}
                  col="revenue_mtd_cents"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onClick={toggleSort}
                  align="right"
                />
                <SortableHead
                  label="AR open"
                  col="ar_open_cents"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onClick={toggleSort}
                  align="right"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rollup.isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={columnCount}
                    className="text-center text-muted-foreground py-6"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!rollup.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={columnCount}
                    className="text-center text-muted-foreground py-6"
                  >
                    No child organizations linked yet.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                const pct =
                  r.visits_today > 0
                    ? Math.round((r.visits_completed_today / r.visits_today) * 100)
                    : 0;
                return (
                  <TableRow key={r.organization_id}>
                    <TableCell className="font-medium">
                      {/* A button rather than a clickable row: a row that opens
                          something on click has no keyboard or screen-reader
                          affordance, and on touch it makes every cell in the
                          row — including the numbers people scroll past — a
                          hit target for a drawer they did not ask for. */}
                      <button
                        type="button"
                        className="max-w-full truncate text-left underline-offset-4 hover:underline max-md:min-h-11"
                        onClick={() => setDrillInto(r)}
                      >
                        {r.organization_name}
                      </button>
                    </TableCell>
                    <TableCell className="text-right">{r.tech_count}</TableCell>
                    <TableCell className="text-right">{r.active_clients}</TableCell>
                    <TableCell className="text-right">
                      {r.visits_completed_today}/{r.visits_today}
                      {r.visits_today > 0 && (
                        <Badge variant="secondary" className="ml-2">
                          {pct}%
                        </Badge>
                      )}
                    </TableCell>
                    {hasRefunds && (
                      <TableCell className="text-right text-muted-foreground">
                        {money(Number(r.revenue_mtd_gross_cents))}
                      </TableCell>
                    )}
                    {hasRefunds && (
                      <TableCell
                        className={`text-right ${
                          Number(r.refunds_mtd_cents) > 0
                            ? "text-destructive"
                            : "text-muted-foreground"
                        }`}
                      >
                        {Number(r.refunds_mtd_cents) === 0
                          ? "-"
                          : `-${money(Number(r.refunds_mtd_cents))}`}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      {money(Number(r.revenue_mtd_cents))}
                    </TableCell>
                    <TableCell className="text-right">{money(Number(r.ar_open_cents))}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* BUILD-6: routing sits ABOVE royalty billing on purpose. Who collects
          decides what a settlement even means, so it is the first decision, not
          a detail buried under the invoice list. */}
      <PaymentRouting />

      <RoyaltyBilling />

      {/* Directly under the statements it explains. Each statement shows a net
          figure per period; this is where the refunds and chargebacks inside
          that figure are itemised, and where a credit from a won dispute says
          which deduction it gives back.
          (This comment used to claim the royalty TABLE showed the net figure.
          It did not — it showed the gross royalty and never read `direction` or
          `net_due_cents` at all, so the trail below was explaining a number
          that was not on the screen.) */}
      <AdjustmentTrail />

      <FranchiseLocationDrawer
        row={drillInto}
        statements={(invoicesQ.data?.invoices ?? []) as SettlementStatementRow[]}
        adjustments={adjustmentsQ.data?.rows ?? []}
        royaltyPercent={drillRoyaltyPercent}
        onOpenChange={(open) => !open && setDrillInto(null)}
        onSetStatus={(invoiceId, status) => drillStatus.mutate({ invoiceId, status })}
        onReopenAsDraft={(invoiceId) => drillStatus.mutate({ invoiceId, status: "draft" })}
        isUpdating={drillStatus.isPending}
      />
    </div>
  );
}

function AdjustmentTrail() {
  const fn = useServerFn(getFranchiseAdjustments);
  const q = useQuery({ queryKey: ["franchise", "adjustments"], queryFn: () => fn() });
  return (
    <FranchiseAdjustmentTrail
      rows={q.data?.rows ?? []}
      audience="franchise"
      isLoading={q.isLoading}
      error={q.error ? (q.error as Error).message : null}
    />
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

  const settings = useQuery({
    queryKey: ["franchise", "royalty-settings"],
    queryFn: () => settingsFn(),
  });
  const invoices = useQuery({
    queryKey: ["franchise", "royalty-invoices"],
    queryFn: () => listFn(),
  });

  const setRate = useMutation({
    mutationFn: (v: { childOrgId: string; percent: number }) => setRateFn({ data: v }),
    onSuccess: () => {
      toast.success("Royalty rate saved");
      settings.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const generate = useMutation({
    mutationFn: () => genFn({ data: {} }),
    onSuccess: (r: any) => {
      // `generated` is now what the routine actually wrote, and zero is a real
      // outcome: once a period's statements are issued they are frozen, so a
      // rate change made afterwards does NOT reach them. Reporting "Generated
      // 0" as a success is how an owner walks away believing it did.
      const n = Number(r.generated ?? 0);
      if (n === 0) {
        // The old sentence ended "Void an issued statement to recalculate it",
        // which was an instruction for something impossible: voiding leaves the
        // row at `status = 'void'`, still holding the unique key for that
        // period, and the upsert only writes over a DRAFT — so the owner who
        // followed the advice got zero again, with the statement's adjustments
        // now loose and heading for whatever period was generated next. Reopen
        // as draft is the act that actually recovers a period, and it is now a
        // button on the statement itself.
        toast.info(
          `Nothing generated for ${r.periodStart} → ${r.periodEnd}. Statements for that period have already left draft, or there are no locations. Reopen one as a draft to recalculate it.`,
        );
      } else {
        toast.success(
          `Generated ${n} royalty invoice${n === 1 ? "" : "s"} for ${r.periodStart} → ${r.periodEnd}`,
        );
      }
      invoices.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const setStatus = useMutation({
    mutationFn: (v: { invoiceId: string; status: "draft" | "issued" | "paid" | "void" }) =>
      statusFn({ data: v }),
    onSuccess: () => {
      toast.success("Updated");
      invoices.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const children: any[] = (settings.data as any)?.children ?? [];
  const rows: any[] = (invoices.data as any)?.invoices ?? [];

  return (
    <>
      <Card>
        {/* Wraps below sm. The title and a button reading "Generate last
            month's royalties" do not fit one 360px row, and a header that
            refuses to wrap pushes the button off the right edge. */}
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">Royalty billing</CardTitle>
          <Button
            size="sm"
            className="max-md:min-h-11 sm:w-auto"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
          >
            {generate.isPending ? "Generating…" : "Generate last month's royalties"}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="mb-2 text-xs font-medium uppercase text-muted-foreground">
            Royalty rate per location
          </div>
          {/* ── WHAT THE PERCENTAGE IS A PERCENTAGE OF ──────────────────────
              Owner decision, 2026-08-19: the royalty stays on GROSS, and the
              product says so.

              The royalty is round(collected × pct / 100) over
              payments.amount_cents. That base excludes the card surcharge —
              right, it was fee recovery and never revenue — and includes
              Stripe's processing fee and HoundStack's 0.5% platform fee, both
              of which come out of the location's side. So a location billed
              7% of collected revenue pays 7% of a number larger than the one
              that reached its bank.

              No arithmetic changes. What changes is that the person choosing
              the percentage is told what it multiplies, at the moment they
              choose it, rather than discovering it from a franchisee's
              reconciliation months later. "% of collected revenue" is kept
              verbatim: it is the same phrase the settlement statement and the
              rollup use, and a fourth wording for one figure is how the last
              round of this went wrong. */}
          <p className="mb-3 text-xs text-muted-foreground">
            The percentage applies to collected revenue before fees. Stripe&apos;s processing fee
            and HoundStack&apos;s 0.5% platform fee are deducted from what the location receives and
            are not taken off the royalty base, so a location keeps less than the figure the royalty
            is calculated on. The card surcharge is already excluded — it was never revenue.
          </p>
          <div className="space-y-2">
            {children.map((c) => (
              // The name gets its own line below sm: a location name, a number
              // box and "% of collected revenue" is far more than 360px of row,
              // and the trailing label was the part going over the edge.
              <div
                key={c.id}
                className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-3"
              >
                <span className="min-w-0 flex-1 truncate sm:min-w-40">{c.name}</span>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.25}
                    className="w-24 max-md:min-h-11"
                    aria-label={`Royalty percentage for ${c.name}`}
                    defaultValue={Number(c.franchise_royalty_percent ?? 0)}
                    onBlur={(e) => {
                      const percent = Number(e.target.value);
                      if (
                        !Number.isNaN(percent) &&
                        percent !== Number(c.franchise_royalty_percent ?? 0)
                      ) {
                        setRate.mutate({ childOrgId: c.id, percent });
                      }
                    }}
                  />
                  <span className="text-muted-foreground">% of collected revenue</span>
                </div>
              </div>
            ))}
            {children.length === 0 && (
              <p className="text-sm text-muted-foreground">No child locations yet.</p>
            )}
          </div>
        </CardContent>
      </Card>

      <FranchiseSettlementStatements
        rows={rows.map((r) => ({
          ...r,
          counterpartyName:
            (Array.isArray(r.organizations) ? r.organizations[0] : r.organizations)?.name ?? null,
        }))}
        audience="franchise"
        isLoading={invoices.isLoading}
        error={invoices.error ? (invoices.error as Error).message : null}
        isUpdating={setStatus.isPending}
        onSetStatus={(invoiceId, status) => setStatus.mutate({ invoiceId, status })}
        onReopenAsDraft={(invoiceId) => setStatus.mutate({ invoiceId, status: "draft" })}
      />
    </>
  );
}

function SortableHead({
  label,
  col,
  sortBy,
  sortDir,
  onClick,
  align,
}: {
  label: string;
  col: SortKey;
  sortBy: SortKey;
  sortDir: "asc" | "desc";
  onClick: (k: SortKey) => void;
  align?: "right";
}) {
  const active = sortBy === col;
  return (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button
        className={`inline-flex items-center gap-1 ${align === "right" ? "ml-auto" : ""} hover:text-foreground transition`}
        onClick={() => onClick(col)}
      >
        {label}
        {active &&
          (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </button>
    </TableHead>
  );
}

function StatCard({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold mt-1 ${valueClass ?? ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
