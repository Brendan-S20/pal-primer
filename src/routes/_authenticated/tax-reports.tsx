import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Download, FileSpreadsheet, Info, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { downloadCsv } from "@/lib/csv";
import { reportFileName, type ReportId } from "@/lib/cpa-reports";
import {
  getTaxReport,
  getTaxReportIndex,
  type ReportResult,
  type ReportRow,
} from "@/lib/cpa-reports.functions";

// BUILD-13 — one screen an owner can send to their accountant.
//
// The owner's framing was about not putting a strain on the accountant: "we
// don't have to put a strain on them to try to find numbers that are needed and
// are not available or hard to calculate."
//
// Two things follow from that, and they shape this page more than the layout
// does.
//
// First, EVERY sheet carries its own definition. The basis, the date range, the
// timezone, the caveats — all of it goes into the CSV as well as onto the
// screen. A spreadsheet that arrives without saying what it counted generates
// the exact email the owner is trying to avoid.
//
// Second, what is NOT here is stated as plainly as what is. Sales tax and
// expenses cannot be produced from this data. An accountant who knows that in
// the first thirty seconds stops looking; one who doesn't spends an hour and
// then asks.

export const Route = createFileRoute("/_authenticated/tax-reports")({
  head: () => ({ meta: [{ title: "Tax & accountant reports · HoundStack" }] }),
  component: TaxReportsPage,
});

function fmtMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

/** Accountants ask for periods, not for date pickers. Every one of these is a
 *  filing boundary somebody actually works to. */
function presets(today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const lastMonthStart = new Date(Date.UTC(y, m - 1, 1));
  const lastMonthEnd = new Date(Date.UTC(y, m, 0));
  const q = Math.floor(m / 3);
  const lastQStart = new Date(Date.UTC(q === 0 ? y - 1 : y, q === 0 ? 9 : (q - 1) * 3, 1));
  const lastQEnd = new Date(Date.UTC(q === 0 ? y - 1 : y, q === 0 ? 12 : q * 3, 0));
  return [
    { label: "Last month", from: iso(lastMonthStart), to: iso(lastMonthEnd) },
    { label: "Last quarter", from: iso(lastQStart), to: iso(lastQEnd) },
    { label: "Year to date", from: `${y}-01-01`, to: iso(today) },
    { label: `${y - 1} tax year`, from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
}

function TaxReportsPage() {
  const indexFn = useServerFn(getTaxReportIndex);
  const reportFn = useServerFn(getTaxReport);

  const quick = useMemo(() => presets(), []);
  const [from, setFrom] = useState(quick[2].from);
  const [to, setTo] = useState(quick[2].to);
  const [selected, setSelected] = useState<ReportId>("income_cash");
  const [bulk, setBulk] = useState(false);

  const index = useQuery({
    queryKey: ["tax-reports", "index"],
    queryFn: () => indexFn(),
    staleTime: 60_000,
  });

  const report = useQuery({
    queryKey: ["tax-reports", selected, from, to],
    queryFn: () => reportFn({ data: { reportId: selected, from, to } }),
    enabled: !!index.data,
  });

  const download = (r: ReportResult) => {
    const headers = r.columns.map((c) => c.label);
    const body: Array<Array<unknown>> = r.rows.map((row) =>
      r.columns.map((c) => cellFor(row, c.key, c.type, true)),
    );
    if (r.totals) body.push(r.columns.map((c) => cellFor(r.totals!, c.key, c.type, true)));
    // The definition travels WITH the numbers. A CSV that outlives this screen
    // still has to be able to say what it counted.
    body.push([], [`${r.title}`], [r.purpose]);
    body.push([`Period: ${r.range.from} to ${r.range.to} (${r.timezone})`]);
    body.push([`Basis: ${r.basis === "none" ? "reconciliation" : r.basis}`]);
    if (r.note) body.push([r.note]);
    for (const c of r.caveats) body.push([c]);
    downloadCsv(reportFileName(r.id, r.range.from, r.range.to, r.orgName), headers, body);
  };

  const downloadAll = useMutation({
    mutationFn: async () => {
      const ids = (index.data?.reports ?? []).map((d) => d.id);
      for (const id of ids) {
        const r = await reportFn({ data: { reportId: id, from, to } });
        download(r);
        // Browsers throttle rapid programmatic downloads; a short gap keeps a
        // ten-sheet pack from arriving as three files and a shrug.
        await new Promise((res) => setTimeout(res, 350));
      }
      return ids.length;
    },
    onMutate: () => setBulk(true),
    onSettled: () => setBulk(false),
    onSuccess: (n) => toast.success(`Downloaded ${n} reports`),
    onError: (e: Error) => toast.error(e.message),
  });

  const defs = index.data?.reports ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Tax &amp; accountant reports</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Everything your accountant normally has to ask you for. Each sheet states what it
            counted, so it can be sent on without a covering email.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => downloadAll.mutate()}
          disabled={bulk || !index.data}
        >
          {bulk ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="mr-2 h-4 w-4" />
          )}
          Download every report
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div>
            <Label htmlFor="tax-from" className="text-xs">
              From
            </Label>
            <Input
              id="tax-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tax-to" className="text-xs">
              To
            </Label>
            <Input id="tax-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            {quick.map((p) => (
              <Button
                key={p.label}
                size="sm"
                variant={from === p.from && to === p.to ? "secondary" : "ghost"}
                onClick={() => {
                  setFrom(p.from);
                  setTo(p.to);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {index.data && (
            <p className="ml-auto text-xs text-muted-foreground">Dates in {index.data.timezone}</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-1">
          {defs.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelected(d.id)}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                selected === d.id
                  ? "border-primary bg-muted"
                  : "border-transparent hover:bg-muted/60"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{d.title}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {d.basis === "none" ? "Reconciliation" : `${d.basis} basis`}
              </div>
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {report.isPending ? (
            <p className="text-sm text-muted-foreground">Building the report…</p>
          ) : report.error ? (
            <p className="text-sm text-destructive">{(report.error as Error).message}</p>
          ) : report.data ? (
            <ReportView data={report.data} onDownload={() => download(report.data)} />
          ) : null}

          {index.data && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Info className="h-4 w-4" /> Stripe&apos;s 1099-K
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="font-medium">{index.data.routing.headline}</p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  {index.data.routing.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {index.data && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">What these reports can&apos;t tell you</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {index.data.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ReportView({ data, onDownload }: { data: ReportResult; onDownload: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div>
          <CardTitle className="text-base">{data.title}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{data.purpose}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">
              {data.basis === "none" ? "Reconciliation" : `${data.basis} basis`}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {data.range.from} → {data.range.to}
            </span>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onDownload}>
          <Download className="mr-2 h-4 w-4" /> CSV
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.note && <p className="text-xs text-muted-foreground">{data.note}</p>}

        {data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  {data.columns.map((c) => (
                    <th
                      key={c.key}
                      className={`py-1 ${c.type === "money" || c.type === "number" ? "text-right" : ""}`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i} className="border-t">
                    {data.columns.map((c) => (
                      <td
                        key={c.key}
                        className={`py-1 ${
                          c.type === "money" || c.type === "number" ? "text-right tabular-nums" : ""
                        }`}
                      >
                        {cellFor(row, c.key, c.type, false)}
                      </td>
                    ))}
                  </tr>
                ))}
                {data.totals && (
                  <tr className="border-t-2 font-medium">
                    {data.columns.map((c) => (
                      <td
                        key={c.key}
                        className={`py-1.5 ${
                          c.type === "money" || c.type === "number" ? "text-right tabular-nums" : ""
                        }`}
                      >
                        {cellFor(data.totals!, c.key, c.type, false)}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {data.caveats.length > 0 && (
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Notes for your accountant
            </div>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {data.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** One renderer for screen and CSV.
 *
 *  Money goes to the CSV as a plain decimal, not "$1,234.56" — a currency
 *  string imports as text and every downstream formula silently returns zero.
 *  On screen it is formatted, because a column of raw cents is unreadable. */
function cellFor(row: ReportRow, key: string, type: string, forCsv: boolean): string | number {
  const v = row[key];
  if (v == null || v === "") return "";
  if (type === "money") {
    const cents = Number(v);
    return forCsv ? (cents / 100).toFixed(2) : fmtMoney(cents);
  }
  if (type === "number") return Number(v);
  return String(v);
}
