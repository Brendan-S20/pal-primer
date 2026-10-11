// "Export your data" (NP-12): one JSON file of the business's records. Shown to
// an owner on any plan, and for 30 days after a cancelled plan ends; not
// during a trial lock, where the server refuses it too.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { exportAccountData } from "@/lib/account-export.functions";
import { getAccountLock } from "@/lib/account-lock.functions";
import { exportAllowed } from "@/lib/account-lock";
import { formatDay } from "@/lib/format";

export function ExportDataCard() {
  const lockFn = useServerFn(getAccountLock);
  const exportFn = useServerFn(exportAccountData);
  const { data: lock } = useQuery({
    queryKey: ["account-lock"],
    queryFn: () => lockFn(),
    staleTime: 15_000,
  });
  const run = useMutation({
    mutationFn: () => exportFn(),
    onSuccess: (file) => {
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `houndstack-export-${file.exported_at.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!lock || !lock.canChoosePlan || !exportAllowed(lock)) return null;

  return (
    <section className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Your data</h2>
          <p className="text-sm text-muted-foreground">
            Download your clients, properties, visits, invoices and payments as one file.
            {lock.locked && lock.exportUntil
              ? ` Available until ${formatDay(lock.exportUntil)}.`
              : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
          <Download className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {run.isPending ? "Preparing…" : "Export your data"}
        </Button>
      </div>
    </section>
  );
}
