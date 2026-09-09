import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getPricingDrift } from "@/lib/pricing-drift.functions";
import { describePriceProvenance } from "@/lib/price-provenance";
import type { DriftOutcome, DriftRow } from "@/lib/pricing-drift";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/pricing-drift")({
  component: PricingDriftPage,
});

type Filter = "all" | DriftOutcome;

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format(cents / 100);
}

/** Signed, so a reader can tell "collects $17.50 less" from "collects more". */
function signedMoney(cents: number, currency: string): string {
  return `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money(Math.abs(cents), currency)}`;
}

const OUTCOME_LABEL: Record<DriftOutcome, string> = {
  no_zone: "No zone",
  on_rate: "On the card",
  under: "Below the card",
  over: "Above the card",
};

function OutcomeBadge({ outcome }: { outcome: DriftOutcome }) {
  const tone =
    outcome === "on_rate"
      ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
      : outcome === "no_zone"
        ? "bg-muted text-muted-foreground"
        : outcome === "under"
          ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
          : "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200";
  return <Badge className={`${tone} border-0 font-medium`}>{OUTCOME_LABEL[outcome]}</Badge>;
}

function Stat({
  label,
  value,
  hint,
  active,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[44px] rounded-lg border p-3 text-left transition-colors ${
        active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
      }`}
    >
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </button>
  );
}

function ratioText(r: number | null): string {
  if (r == null) return "";
  if (r >= 1) return `${r.toFixed(r >= 10 ? 0 : 1)}x the card`;
  return `${(1 / r).toFixed(1 / r >= 10 ? 0 : 1)}x the card`;
}

function PricingDriftPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isLoading, error } = useQuery({
    queryKey: ["pricing-drift"],
    queryFn: () => getPricingDrift(),
  });

  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => filter === "all" || r.outcome === filter),
    [data, filter],
  );

  const currency = data?.currency ?? "usd";
  const s = data?.summary;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Who is off the rate card</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every active service, compared against what its zone charges today. This page
          changes nothing. It is here so the gap can be looked at before anybody decides
          what to do about it.
        </p>
      </div>

      {isLoading ? <Card className="p-6 text-sm text-muted-foreground">Working it out.</Card> : null}

      {error ? (
        <Card className="border-destructive/40 p-6 text-sm">
          The report could not be built: {(error as Error).message}
        </Card>
      ) : null}

      {s ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat
              label="Active services"
              value={String(s.total)}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <Stat
              label="On the card"
              value={String(s.onRate)}
              active={filter === "on_rate"}
              onClick={() => setFilter("on_rate")}
            />
            <Stat
              label="Below the card"
              value={String(s.under)}
              hint={`${signedMoney(s.underSumCents, currency)} per visit`}
              active={filter === "under"}
              onClick={() => setFilter("under")}
            />
            <Stat
              label="Above the card"
              value={String(s.over)}
              hint={`${signedMoney(s.overSumCents, currency)} per visit`}
              active={filter === "over"}
              onClick={() => setFilter("over")}
            />
            <Stat
              label="No zone at all"
              value={String(s.noZone)}
              hint="no rate to compare"
              active={filter === "no_zone"}
              onClick={() => setFilter("no_zone")}
            />
          </div>

          {s.noZone > 0 ? (
            <Card className="border-amber-300/60 bg-amber-50/50 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/20">
              <p>
                <strong>
                  {s.noZone} of {s.total} active services sit in no zone at all
                </strong>
                , so the rate card has no opinion about them and this report cannot say
                whether their price is right. Any bulk repricing built on zones would skip
                them silently. They need a zone before they can be priced from one.
              </p>
            </Card>
          ) : null}

          <p className="max-w-3xl text-xs text-muted-foreground">
            The per-visit totals above are the sum of the gaps, not money anybody is owed.
            A service below the card is not a debt; it is a price that was agreed when the
            card said something else. Sorted worst first by ratio rather than by dollars,
            so a service paying $26 against a card price of $489 outranks one paying $90
            against $108.
          </p>

          {/* Phones get cards. A nine-column table does not become usable by
              getting smaller, and this one carries two money columns that have
              to stay readable side by side. */}
          <div className="space-y-3 md:hidden">
            {rows.map((r) => (
              <DriftCard key={r.subscriptionId} row={r} currency={currency} />
            ))}
          </div>

          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead className="text-right">Pays</TableHead>
                  <TableHead className="text-right">Card today</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Where the price came from</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.subscriptionId}>
                    <TableCell className="max-w-[16rem]">
                      <Link
                        to="/clients/$clientId"
                        params={{ clientId: r.clientId }}
                        className="block truncate font-medium hover:underline"
                      >
                        {r.clientName}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-[12rem] truncate text-muted-foreground">
                      {r.zoneName ?? "None"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.frequency.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(r.paidCents, currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.todayCents == null ? (
                        <span className="text-muted-foreground">n/a</span>
                      ) : (
                        <>
                          {money(r.todayCents, currency)}
                          {r.areaCapped ? (
                            <span className="ml-1 text-xs text-muted-foreground">capped</span>
                          ) : null}
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.diffCents == null ? (
                        <span className="text-muted-foreground">n/a</span>
                      ) : (
                        <div>
                          <div>{signedMoney(r.diffCents, currency)}</div>
                          <div className="text-xs text-muted-foreground">
                            {ratioText(r.ratio)}
                          </div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        <OutcomeBadge outcome={r.outcome} />
                        {r.handPriced ? (
                          <Badge variant="outline" className="font-normal">
                            By hand
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[18rem] truncate text-xs text-muted-foreground">
                      {describePriceProvenance(
                        {
                          priced_at: r.pricedAt,
                          priced_from_zone_id: r.pricedFromZoneId,
                          price_overridden_at: r.priceOverriddenAt,
                        },
                        () => r.zoneName ?? undefined,
                      ).text}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {rows.length === 0 ? (
            <Card className="p-6 text-sm text-muted-foreground">
              Nothing in this group.{" "}
              <Button variant="link" className="h-auto p-0" onClick={() => setFilter("all")}>
                Show every service
              </Button>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function DriftCard({ row: r, currency }: { row: DriftRow; currency: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to="/clients/$clientId"
            params={{ clientId: r.clientId }}
            className="block truncate font-medium hover:underline"
          >
            {r.clientName}
          </Link>
          <div className="truncate text-xs text-muted-foreground">
            {r.zoneName ?? "No zone"} - {r.frequency.replace(/_/g, " ")}
          </div>
        </div>
        <div className="shrink-0">
          <OutcomeBadge outcome={r.outcome} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Pays</div>
          <div className="tabular-nums">{money(r.paidCents, currency)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Card today</div>
          <div className="tabular-nums">
            {r.todayCents == null ? "n/a" : money(r.todayCents, currency)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Gap</div>
          <div className="tabular-nums">
            {r.diffCents == null ? "n/a" : signedMoney(r.diffCents, currency)}
          </div>
        </div>
      </div>

      {r.ratio != null ? (
        <div className="mt-2 text-xs text-muted-foreground">{ratioText(r.ratio)}</div>
      ) : null}
      {r.handPriced ? (
        <Badge variant="outline" className="mt-2 font-normal">
          By hand
        </Badge>
      ) : null}
    </Card>
  );
}
