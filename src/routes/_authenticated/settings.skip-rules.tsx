import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listSkipRules, upsertSkipRule, SKIP_REASON_CODES } from "@/lib/skip-rules.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { HelpTip } from "@/components/HelpTip";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/settings/skip-rules")({
  head: () => titleHead("Skip rules", "Settings"),
  component: SkipRulesPage,
});

function SkipRulesPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listSkipRules);
  const upsertFn = useServerFn(upsertSkipRule);
  const { data, isLoading } = useQuery({
    queryKey: ["skip-rules"],
    queryFn: () => listFn(),
  });

  const upsert = useMutation({
    mutationFn: (v: { code: (typeof SKIP_REASON_CODES)[number]; billablePct: number }) =>
      upsertFn({ data: v }),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["skip-rules"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          Skip billing rules <HelpTip article="skip-rules" />
        </h2>
        <p className="text-sm text-muted-foreground">
          When a tech skips a visit with a given reason, this percent of the subscription price is
          billed on the next invoice. Defaults follow industry practice; override any you like.
        </p>
      </div>

      <div className="relative overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="border-b bg-muted/40 text-left">
            <tr>
              <th className="px-4 py-2">Reason</th>
              <th className="px-4 py-2 w-40">Billable %</th>
              <th className="px-4 py-2 w-24"></th>
              <th className="px-4 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.rules ?? []).map((r) => (
              <RuleRow
                key={r.code}
                rule={r}
                onSave={(pct) => upsert.mutate({ code: r.code, billablePct: pct })}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RuleRow({
  rule,
  onSave,
}: {
  rule: {
    code: (typeof SKIP_REASON_CODES)[number];
    label: string;
    billable_pct: number;
    is_override: boolean;
  };
  onSave: (pct: number) => void;
}) {
  const [val, setVal] = useState(String(rule.billable_pct));
  const dirty = parseInt(val, 10) !== rule.billable_pct;
  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-2">{rule.label}</td>
      <td className="px-4 py-2">
        <Input
          type="number"
          min="0"
          max="100"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="h-8"
        />
      </td>
      <td className="px-4 py-2 text-xs text-muted-foreground">
        {rule.is_override ? "override" : "default"}
      </td>
      <td className="px-4 py-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty}
          onClick={() => {
            const n = parseInt(val, 10);
            if (n >= 0 && n <= 100) onSave(n);
          }}
        >
          Save
        </Button>
      </td>
    </tr>
  );
}
