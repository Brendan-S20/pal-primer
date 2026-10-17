// The account-deletion job's dry run, for a platform admin (NP-12). The owner
// reads this before switching the job on in src/lib/account-deletion.server.ts.
// It counts; it never deletes.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { previewAccountDeletion } from "@/lib/account-deletion.functions";

type Preview = Awaited<ReturnType<typeof previewAccountDeletion>>;

export function AccountDeletionCard() {
  const preview = useServerFn(previewAccountDeletion);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await preview());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const r = data?.report;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Account deletion (dry run)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Locked and canceled accounts are deleted 30 days after the lock, or 30 days after the
          deploy for accounts locked before it. The job is{" "}
          {r ? (r.enabled ? "ON" : "OFF") : "off until switched on in code"}; this only counts.
        </p>
        <Button variant="outline" onClick={run} disabled={busy}>
          <Trash2 className="h-4 w-4 shrink-0" />
          {busy ? "Counting..." : "Run a dry run"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {r && (
          <div className="space-y-2 text-sm" role="status">
            <p>
              {r.accounts} account{r.accounts === 1 ? "" : "s"}, {r.recordsToDelete} record
              {r.recordsToDelete === 1 ? "" : "s"} to delete, {r.recordsKept} kept. Earliest
              deletion: {r.earliestDeleteAfter ? r.earliestDeleteAfter.slice(0, 10) : "none"}
              {r.deployedOnIsHypothetical ? ` (if switched on ${r.deployedOn})` : ""}.
            </p>
            <ul className="space-y-1">
              {r.perAccount.map((a) => (
                <li key={a.organizationId} className="min-w-0 break-words text-xs text-muted-foreground">
                  {a.organizationId}: {a.reason}, delete after {a.deleteAfter.slice(0, 10)}
                  {a.error ? `, error: ${a.error}` : ""}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Already deleted: {data?.recentPurges.length ?? 0} account(s)
              {data?.recentPurges.length
                ? ` (last report: ${JSON.stringify(data.recentPurges[0].last_report)})`
                : ""}
              . SMS consent records kept under their own retention: {data?.keptConsents.length ?? 0}
              {data?.keptConsents.length
                ? ` (latest wording: "${data.keptConsents[0].consent_text ?? ""}")`
                : ""}
              .
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
