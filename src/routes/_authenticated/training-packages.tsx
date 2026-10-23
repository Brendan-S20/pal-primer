import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  listTrainingPackagesOverview,
  type PackageOverviewRow,
} from "@/lib/training-packages.functions";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDay } from "@/lib/format";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/training-packages")({
  head: () => titleHead("Training packages"),
  component: TrainingPackagesPage,
});

type Filter = "low" | "all";

/** Every running training package in one list, so the office does not have
 *  to open each client to find the ones running low (product review of #476).
 *  Selling, booking and canceling stay on the client's Services tab, which
 *  each row opens. */
function TrainingPackagesPage() {
  const load = useServerFn(listTrainingPackagesOverview);
  const { data, isLoading, error } = useQuery({
    queryKey: ["training-packages-overview"],
    queryFn: () => load(),
  });
  const packages = data?.packages ?? [];
  const low = packages.filter((p) => p.runningLow).length;
  const [filter, setFilter] = useState<Filter | null>(null);
  // Opens on the packages running low when there are any.
  const shownFilter: Filter = filter ?? (low > 0 ? "low" : "all");
  const rows = useMemo(
    () => (shownFilter === "low" ? packages.filter((p) => p.runningLow) : packages),
    [packages, shownFilter],
  );

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Training packages</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Every package that is still running: sessions used, booked and still to book, and when it
          expires. A package is running low with one session left or 14 days to go. Open a client to
          book lessons, extend or cancel.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <FilterTile
          label="Running low"
          value={low}
          active={shownFilter === "low"}
          onClick={() => setFilter("low")}
        />
        <FilterTile
          label="All running"
          value={packages.length}
          active={shownFilter === "all"}
          onClick={() => setFilter("all")}
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      ) : rows.length === 0 ? (
        <Card className="p-6 text-sm text-muted-foreground">
          {shownFilter === "low"
            ? "No package is running low."
            : "No training package is running. Sell one from a client's Services tab."}
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <PackageRow key={p.id} p={p} />
          ))}
        </ul>
      )}
    </>
  );
}

function FilterTile({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 rounded-lg border p-3 text-left ${
        active ? "border-primary bg-primary/5" : "border-border"
      }`}
    >
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </button>
  );
}

function PackageRow({ p }: { p: PackageOverviewRow }) {
  return (
    <li>
      <Link
        to="/clients/$clientId"
        params={{ clientId: p.clientId }}
        search={{ tab: "services" }}
        className="block min-h-11 rounded-lg border p-3 hover:bg-muted/50"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1">
            {/* Each name truncates on its own line: an inline name inside a
                truncating line is clipped with no ellipsis of its own. */}
            <bdi className="block truncate font-medium">{p.clientName}</bdi>
            {p.dogName ? <bdi className="block truncate text-sm">{p.dogName}</bdi> : null}
            <div className="truncate text-sm text-muted-foreground">{p.name}</div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-1">
            {p.runningLow && (
              <Badge className="border-0 bg-amber-100 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Running low
              </Badge>
            )}
            {p.unpaid && <Badge variant="outline">Not paid</Badge>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
          <span>
            {p.used} of {p.sessionsCount} used
          </span>
          <span>{p.booked} booked</span>
          <span className={p.toBook <= 1 ? "font-medium" : undefined}>{p.toBook} to book</span>
          <span className="text-muted-foreground">
            {p.expiresOn ? `Expires ${formatDay(p.expiresOn)}` : "No expiry"}
          </span>
        </div>
      </Link>
    </li>
  );
}
