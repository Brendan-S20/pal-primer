import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { getVaccineStartRule, setVaccineStartRule } from "@/lib/pet-safety.functions";
import type { VaccineStartRule } from "@/lib/pet-safety";
import { formatDateTime } from "@/lib/format";

const RULE_LABELS: Record<VaccineStartRule, string> = {
  warn: "Warn the tech and start",
  block: "Do not start until the record is updated",
};

/**
 * What a missing required vaccine does when a tech presses Start on a groom
 * (#729). The OWNER chooses; everyone else sees the choice and its history.
 * Warn is the default and what every business had before this existed. The
 * database enforces both the rule (start_visit_as) and who may change it
 * (set_vaccine_start_rule), so this card is only how the owner says it.
 */
export function VaccineStartRuleSettings() {
  const get = useServerFn(getVaccineStartRule);
  const q = useQuery({ queryKey: ["vaccine-start-rule"], queryFn: () => get() });
  if (q.isLoading) return null;
  if (q.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {q.error.message}
      </p>
    );
  if (!q.data) return null;
  return (
    <Form key={`${q.data.rule}:${q.data.setAt}`} initial={q.data} refresh={() => q.refetch()} />
  );
}

function Form({
  initial,
  refresh,
}: {
  initial: Awaited<ReturnType<typeof getVaccineStartRule>>;
  refresh: () => void;
}) {
  const [rule, setRule] = useState<VaccineStartRule>(initial.rule);
  const saveFn = useServerFn(setVaccineStartRule);
  const save = useMutation({
    mutationFn: () => saveFn({ data: { rule } }),
    onSuccess: () => {
      toast.success("Vaccine rule at Start saved");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <form
      className="space-y-3 rounded-lg border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold">Vaccines at Start</h3>
      <div className="space-y-1">
        <Label htmlFor="vaccine-start-rule">
          When a tech starts a groom and a required vaccine is missing or expired
        </Label>
        <select
          id="vaccine-start-rule"
          value={rule}
          disabled={!initial.canChange}
          onChange={(e) => setRule(e.target.value as VaccineStartRule)}
          className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
        >
          <option value="warn">{RULE_LABELS.warn} (default)</option>
          <option value="block">{RULE_LABELS.block}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {initial.canChange
            ? "Only the owner can change this. A visit already in progress is never stopped by it."
            : "Only the owner can change this."}
        </p>
      </div>
      {initial.canChange && (
        <Button
          type="submit"
          className="min-h-11"
          disabled={save.isPending || rule === initial.rule}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      )}
      {initial.history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer touch:min-h-11">Change history</summary>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {initial.history.map((h) => (
              <li key={h.changed_at}>
                {formatDateTime(h.changed_at)}:{" "}
                {h.old_value ? RULE_LABELS[h.old_value as VaccineStartRule] : "none"} →{" "}
                {RULE_LABELS[h.new_value as VaccineStartRule]}
              </li>
            ))}
          </ul>
        </details>
      )}
    </form>
  );
}
