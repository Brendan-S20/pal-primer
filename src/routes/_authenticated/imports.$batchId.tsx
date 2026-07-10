import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { getImportBatch, commitImport, cancelImport } from "@/lib/imports.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/imports/$batchId")({
  component: BatchDetail,
});

function BatchDetail() {
  const { batchId } = Route.useParams();
  const navigate = useNavigate();
  const getFn = useServerFn(getImportBatch);
  const commitFn = useServerFn(commitImport);
  const cancelFn = useServerFn(cancelImport);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "create" | "update" | "skip" | "error">("all");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["import-batch", batchId],
    queryFn: () => getFn({ data: { batchId } }),
  });

  if (isLoading || !data) return <p className="text-muted-foreground">Loading…</p>;

  const { batch, rows } = data;
  const stats = (batch.stats ?? {}) as Record<string, number>;
  const shown = filter === "all" ? rows : rows.filter((r: any) => r.action === filter);

  const doCommit = async () => {
    setBusy(true);
    try {
      const s = await commitFn({ data: { batchId } });
      toast.success(`Committed. ${s.created} created, ${s.updated} updated, ${s.failed} failed.`);
      refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Commit failed");
    } finally {
      setBusy(false);
    }
  };

  const doCancel = async () => {
    setBusy(true);
    try {
      await cancelFn({ data: { batchId } });
      toast.success("Import cancelled");
      navigate({ to: "/imports" });
    } catch (e: any) {
      toast.error(e?.message ?? "Cancel failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/imports" className="text-sm text-muted-foreground hover:underline">
            ← All imports
          </Link>
          <h1 className="text-2xl font-semibold">
            {batch.source} · {batch.filename ?? "import"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Created {new Date(batch.created_at).toLocaleString()}
          </p>
        </div>
        <Badge variant={batch.status === "committed" ? "default" : "secondary"}>
          {batch.status}
        </Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-5">
        <StatCard label="Rows" value={stats.total ?? rows.length} />
        <StatCard label="Create" value={stats.create ?? 0} tone="emerald" />
        <StatCard label="Update" value={stats.update ?? 0} tone="blue" />
        <StatCard label="Skip" value={stats.skip ?? 0} />
        <StatCard label="Errors" value={stats.errors ?? 0} tone="red" />
      </div>

      {batch.status === "previewing" && (
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
        <div className="rounded border bg-emerald-50 p-4 text-sm text-emerald-900">
          Import committed: {stats.created} created, {stats.updated} updated, {stats.failed} failed.
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
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Phone</th>
                <th className="px-3 py-2">Service address</th>
                <th className="px-3 py-2">External ID</th>
                <th className="px-3 py-2">Note</th>
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
                    <td className="px-3 py-2">{m.display_name ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{m.account_type ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{m.primary_email ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{m.primary_phone ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {[m.street, m.city, m.region, m.postal_code].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{m.external_id ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-red-600">{r.error ?? ""}</td>
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
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const toneClass =
    tone === "emerald" ? "text-emerald-600"
    : tone === "blue" ? "text-blue-600"
    : tone === "red" ? "text-red-600"
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
    create: "bg-emerald-100 text-emerald-800",
    update: "bg-blue-100 text-blue-800",
    skip: "bg-muted text-muted-foreground",
    error: "bg-red-100 text-red-800",
  };
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${map[action] ?? ""}`}>
      {action}
    </span>
  );
}
