import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { getImportBatch, commitImport, cancelImport, retryImport } from "@/lib/imports.functions";
import { commitRefusal, IMPORT_NOT_FOUND, refusalMessage } from "@/lib/import-commit-guard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { importStatusLabel } from "@/lib/import-status";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/imports/$batchId")({
  head: () => titleHead("Import"),
  component: BatchDetail,
});

function BatchDetail() {
  const { batchId } = Route.useParams();
  const navigate = useNavigate();
  const getFn = useServerFn(getImportBatch);
  const commitFn = useServerFn(commitImport);
  const cancelFn = useServerFn(cancelImport);
  const retryFn = useServerFn(retryImport);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "create" | "update" | "skip" | "error">("all");

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["import-batch", batchId],
    // A batch that is gone stays gone: no point polling it.
    refetchInterval: (q) => (q.state.data && !q.state.data.batch ? false : 30_000),
    retry: 1,
    queryFn: () => getFn({ data: { batchId } }),
  });

  // Every way out of "Loading…" is a sentence and a way back (#434). A
  // removed preview used to spin here for good.
  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (isError || !data?.batch) {
    return (
      <div role="alert" className="space-y-3 rounded border bg-muted/40 p-4 text-sm">
        <p className="font-medium">
          {isError ? "This import could not be loaded." : IMPORT_NOT_FOUND}
        </p>
        {isError && (
          <p className="break-words text-muted-foreground">
            {(error as Error)?.message ?? "Something went wrong."}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/imports">Back to Imports</Link>
          </Button>
          {isError && (
            <Button variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { batch, rows } = data;
  const blocked = data.commitBlock?.reason ?? commitRefusal(batch);
  const stats = (batch.stats ?? {}) as Record<string, number>;
  const planOrBalance = batch.entity === "services" || batch.entity === "balances";
  const shown = filter === "all" ? rows : rows.filter((r: any) => r.action === filter);

  // Group the per-row failure reasons so a batch that failed every row (the
  // Jobber 281/281 case, G8) tells the user WHY at a glance instead of making
  // them scroll a 281-row table. The reasons are already computed at
  // preview/commit and stored on each row.
  const errorReasons = new Map<string, number>();
  for (const r of rows as any[]) {
    if (r.action === "error" && r.error) {
      errorReasons.set(r.error, (errorReasons.get(r.error) ?? 0) + 1);
    }
  }
  const errorSummary = Array.from(errorReasons.entries()).sort((a, b) => b[1] - a[1]);

  const doCommit = async () => {
    setBusy(true);
    try {
      const s = await commitFn({ data: { batchId } });
      toast.success(
        `Committed. ${s.created} created, ${s.updated} updated, ${s.skipped} skipped, ${s.failed} failed.`,
      );
      refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Commit failed");
      refetch();
    } finally {
      setBusy(false);
    }
  };

  // Reopens the batch, then commits it again. A second failure lands back
  // here with its own reason.
  const doRetry = async () => {
    setBusy(true);
    try {
      await retryFn({ data: { batchId } });
      const s = await commitFn({ data: { batchId } });
      toast.success(
        `Committed. ${s.created} created, ${s.updated} updated, ${s.skipped} skipped, ${s.failed} failed.`,
      );
    } catch (e) {
      toast.error((e as Error)?.message ?? "The import did not finish");
    } finally {
      refetch();
      setBusy(false);
    }
  };

  const doCancel = async () => {
    setBusy(true);
    try {
      await cancelFn({ data: { batchId } });
      toast.success("Import canceled");
      navigate({ to: "/imports" });
    } catch (e: any) {
      toast.error(e?.message ?? "Cancel failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/imports" className="text-sm text-muted-foreground hover:underline">
            ← All imports
          </Link>
          <h1 className="break-words text-2xl font-semibold">
            {batch.source} · {batch.filename ?? "import"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Created {formatDateTime(batch.created_at)}
          </p>
        </div>
        <ImportStatusBadge status={blocked ?? batch.status} />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5 max-sm:[&>*:last-child:nth-child(odd)]:col-span-2">
        <StatCard label="Rows" value={stats.total ?? rows.length} />
        <StatCard label="Create" value={stats.create ?? 0} tone="emerald" />
        <StatCard label="Update" value={stats.update ?? 0} tone="blue" />
        <StatCard label="Skip" value={stats.skip ?? 0} />
        <StatCard label="Errors" value={stats.errors ?? 0} tone="red" />
      </div>

      {blocked === "failed" && (
        <div
          role="alert"
          className="space-y-3 rounded border border-destructive/30 bg-destructive/5 p-4 text-sm"
        >
          <p className="font-medium text-destructive">{refusalMessage("failed")}</p>
          <p className="break-words">
            {batch.error ??
              (batch.commit_started_at && !batch.committed_at
                ? "It stopped without a result. Nothing is still running."
                : "Every row was refused. The reasons are below.")}
          </p>
          {data.retryBlock && <p className="text-muted-foreground">{data.retryBlock}</p>}
          <div className="flex flex-wrap gap-2">
            {!data.retryBlock && (
              <Button onClick={doRetry} disabled={busy}>
                {busy ? "Trying again…" : "Try again"}
              </Button>
            )}
            <Button asChild variant={data.retryBlock ? "default" : "outline"}>
              <Link to="/imports">Start a fresh import</Link>
            </Button>
          </div>
        </div>
      )}

      {blocked && blocked !== "committed" && blocked !== "failed" && (
        <div role="status" className="space-y-3 rounded border bg-muted/40 p-4 text-sm">
          <p>{refusalMessage(blocked)}</p>
          {blocked !== "committing" && (
            <Button asChild>
              <Link to="/imports">Start a fresh import</Link>
            </Button>
          )}
        </div>
      )}

      {batch.status === "previewing" && !blocked && (
        <div className="flex gap-2">
          <Button onClick={doCommit} disabled={busy}>
            {busy ? "Committing…" : `Commit import (${(stats.create ?? 0) + (stats.update ?? 0)} rows)`}
          </Button>
          <Button variant="outline" onClick={doCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      )}

      {batch.status === "committed" && stats.created !== undefined && (
        <div className="rounded border bg-emerald-50 p-4 text-sm text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-300">
          Import committed: {stats.created} created, {stats.updated} updated, {stats.skipped ?? 0}{" "}
          skipped, {stats.failed} failed. Imported clients won't receive automated messages until
          you resume communications or reach out. Lift the hold from each client's page, or select
          clients on the Clients list and use "Resume communications".
        </div>
      )}

      {errorSummary.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-destructive">
              Why {errorSummary.reduce((n, [, c]) => n + c, 0)} row
              {errorSummary.reduce((n, [, c]) => n + c, 0) === 1 ? "" : "s"} couldn't import
            </h2>
            {filter !== "error" && (
              <Button variant="outline" size="sm" onClick={() => setFilter("error")}>
                Show only errors
              </Button>
            )}
          </div>
          <ul className="space-y-1 text-sm">
            {errorSummary.map(([reason, count]) => (
              <li key={reason} className="flex items-start justify-between gap-3">
                <span className="text-foreground">{reason}</span>
                <span className="shrink-0 font-medium text-destructive">
                  {count} row{count === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium">Rows</h2>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
            className="rounded border bg-background px-2 py-1 text-sm"
          >
            <option value="all">All</option>
            <option value="create">Create</option>
            <option value="update">Update</option>
            <option value="skip">Skip (duplicate)</option>
            <option value="error">Errors</option>
          </select>
        </div>
        <div className="overflow-auto rounded border bg-card">
          <table className="w-full text-sm min-w-[810px]">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Action</th>
                {planOrBalance ? (
                  <>
                    <th className="px-3 py-2">Client</th>
                    {batch.entity === "services" ? (
                      <>
                        <th className="px-3 py-2">How often</th>
                        <th className="px-3 py-2">Price per visit</th>
                        <th className="px-3 py-2">Day</th>
                        <th className="px-3 py-2">Starts</th>
                      </>
                    ) : (
                      <>
                        <th className="px-3 py-2">Amount owed</th>
                        <th className="px-3 py-2">Due</th>
                        <th className="px-3 py-2">Note</th>
                        <th className="px-3 py-2" />
                      </>
                    )}
                    <th className="px-3 py-2">Issue</th>
                  </>
                ) : (
                  <>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Service address</th>
                    <th className="px-3 py-2">External ID</th>
                    <th className="px-3 py-2">Note / issue</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 500).map((r: any) => {
                const m = r.mapped ?? {};
                return (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-3 py-2 text-muted-foreground">{r.row_num}</td>
                    <td className="px-3 py-2">
                      <ActionBadge action={r.action} />
                    </td>
                    {planOrBalance ? (
                      <PlanOrBalanceCells entity={batch.entity} m={m} error={r.error} />
                    ) : (
                      <>
                    <td className="px-3 py-2">{m.display_name ?? "-"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{m.account_type ?? "-"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{m.primary_email ?? "-"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{m.primary_phone ?? "-"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {[m.street, m.city, m.region, m.postal_code].filter(Boolean).join(", ") || "-"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{m.external_id ?? "-"}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.error ? (
                        <span className="text-red-600">{r.error}</span>
                      ) : (
                        <span className="text-muted-foreground">{m.notes ?? ""}</span>
                      )}
                    </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length > 500 && (
            <div className="border-t px-3 py-2 text-xs text-muted-foreground">
              Showing first 500 of {shown.length} matching rows.
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function ImportStatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    committed: "border-transparent bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400",
    failed: "border-transparent bg-destructive/15 text-destructive hover:bg-destructive/15",
    cancelled: "text-muted-foreground",
  };
  return (
    <Badge variant={status === "cancelled" ? "outline" : "secondary"} className={cls[status] ?? ""}>
      {importStatusLabel(status)}
    </Badge>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const toneClass =
    tone === "emerald" ? "text-emerald-600 dark:text-emerald-400"
    : tone === "blue" ? "text-blue-600 dark:text-blue-400"
    : tone === "red" ? "text-red-600 dark:text-red-400"
    : "text-foreground";
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const map: Record<string, string> = {
    create: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
    update: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300",
    skip: "bg-muted text-muted-foreground",
    error: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300",
  };
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${map[action] ?? ""}`}>
      {action}
    </span>
  );
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function money(cents: number | null | undefined) {
  return cents == null ? "-" : `$${(cents / 100).toFixed(2)}`;
}

/** A plan or a balance row, in the words its columns mean. */
function PlanOrBalanceCells({ entity, m, error }: { entity: string; m: any; error: string | null }) {
  const client = m.client_name ?? m.client_external_id ?? "-";
  const issue = <td className="px-3 py-2 text-xs text-red-600">{error ?? ""}</td>;
  if (entity === "services") {
    const often =
      m.frequency === "weekly" && m.interval_weeks
        ? `Every ${m.interval_weeks} weeks`
        : m.frequency === "every_n_days"
          ? `Every ${m.interval_days} days`
          : m.frequency
            ? String(m.frequency).replace(/_/g, " ")
            : "-";
    return (
      <>
        <td className="px-3 py-2">{client}</td>
        <td className="px-3 py-2 text-muted-foreground">{often}</td>
        <td className="px-3 py-2 tabular-nums">{money(m.price_cents)}</td>
        <td className="px-3 py-2 text-muted-foreground">
          {(m.preferred_weekdays ?? []).map((d: number) => WEEKDAY_SHORT[d]).join(", ") || "-"}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{m.started_on ?? "Next generation"}</td>
        {issue}
      </>
    );
  }
  return (
    <>
      <td className="px-3 py-2">{client}</td>
      <td className="px-3 py-2 tabular-nums">{money(m.amount_cents)}</td>
      <td className="px-3 py-2 text-muted-foreground">{m.due_on ?? "Payment terms"}</td>
      <td className="px-3 py-2 text-muted-foreground">{m.note ?? ""}</td>
      <td className="px-3 py-2" />
      {issue}
    </>
  );
}
