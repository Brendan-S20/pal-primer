import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search } from "lucide-react";
import { getPlatformAudit, type PlatformAuditRow } from "@/lib/platform.functions";
import { humanizeAuditAction } from "@/lib/humanize";
// For impersonation events, the impersonated user + any duration live in the
// after_json — surfaced inline so the log answers "who was impersonated, and
// for how long" without expanding Details (H2). Pure, so it and the filter can
// be tested together; they have to agree on what a row contains (BUG-14).
import { auditActorLabel, auditRowMatches, impersonationDetail } from "@/lib/platform-audit";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/platform/audit")({
  head: () => ({ meta: [{ title: pageTitle("Audit", "Platform admin") }, { name: "robots", content: "noindex" }] }),
  component: AuditPage,
});

function actionTone(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (action.includes("impersonation")) return "destructive";
  if (action.startsWith("update_")) return "secondary";
  return "outline";
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function AuditPage() {
  const fn = useServerFn(getPlatformAudit);
  const q = useQuery({ queryKey: ["platform", "audit"], queryFn: () => fn() });
  const [filter, setFilter] = useState("");

  const filtered = useMemo(
    () => (q.data?.rows ?? []).filter((r) => auditRowMatches(r, filter)),
    [q.data, filter],
  );

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Audit log</CardTitle>
          <div className="text-xs text-muted-foreground">
            Last 200 events
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            placeholder="Filter by action, org, actor, or impersonated user…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-8"
          />
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading audit log…</div>
        ) : q.isError ? (
          <div className="text-sm text-destructive">{(q.error as Error).message}</div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {(q.data?.rows.length ?? 0) === 0 ? "No admin actions recorded yet." : "No matches for that filter."}
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.map((r) => <AuditItem key={r.id} row={r} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AuditItem({ row }: { row: PlatformAuditRow }) {
  const [open, setOpen] = useState(false);
  const detail = impersonationDetail(row);
  const hasDetails =
    (row.before_json && Object.keys(row.before_json).length > 0) ||
    (row.after_json && Object.keys(row.after_json).length > 0);
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={actionTone(row.action)}>{humanizeAuditAction(row.action)}</Badge>
          <span className="font-medium">
            {row.organization_name ?? <span className="text-muted-foreground">(no org)</span>}
          </span>
          {detail && (
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {detail}
            </span>
          )}
          <span className="text-xs text-muted-foreground">by {auditActorLabel(row)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{fmtDate(row.created_at)}</span>
          {hasDetails && (
            <button
              onClick={() => setOpen((v) => !v)}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {open ? "Hide" : "Details"}
            </button>
          )}
        </div>
      </div>
      {open && hasDetails && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <JsonBlock title="Before" json={row.before_json} />
          <JsonBlock title="After" json={row.after_json} />
        </div>
      )}
    </li>
  );
}

function JsonBlock({ title, json }: { title: string; json: any }) {
  if (!json || (typeof json === "object" && Object.keys(json).length === 0)) return null;
  return (
    <div className="rounded-md border bg-muted/40 p-2">
      <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">
{JSON.stringify(json, null, 2)}
      </pre>
    </div>
  );
}
