import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/useMyRole";
import { getVaccineSettings, setVaccineSettings } from "@/lib/vaccines.functions";
import { REQUIRED_VACCINES, VACCINE_LABELS, type VaccineRule } from "@/lib/vaccines";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VaccineStartRuleSettings } from "@/components/settings/VaccineStartRuleSettings";

export function VaccineSettings() {
  const get = useServerFn(getVaccineSettings);
  const q = useQuery({ queryKey: ["vaccine-settings"], queryFn: () => get() });
  if (q.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {q.error.message}
      </p>
    );
  return q.data?.enabled ? (
    <>
      <VaccineSettingsForm
        key={`${q.data.rule}:${q.data.required.join(",")}:${q.data.bufferMin}`}
        initial={q.data}
        refresh={() => q.refetch()}
      />
      <VaccineStartRuleSettings />
    </>
  ) : null;
}

function VaccineSettingsForm({
  initial,
  refresh,
}: {
  initial: { rule: VaccineRule; required: string[]; bufferMin: number };
  refresh: () => void;
}) {
  const [rule, setRule] = useState(initial.rule);
  const [required, setRequired] = useState(
    initial.required as (typeof REQUIRED_VACCINES)[number][],
  );
  const [bufferMin, setBufferMin] = useState(String(initial.bufferMin));
  const { can } = usePermissions();
  const edit = can("manage_settings");
  const saveFn = useServerFn(setVaccineSettings);
  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          rule,
          required,
          setupReviewed: true,
          bufferMin: Math.min(240, Math.max(0, parseInt(bufferMin, 10) || 0)),
        },
      }),
    onSuccess: () => {
      toast.success("Grooming settings saved");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <form
      className="space-y-4 rounded-lg border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold">Vaccines before a groom</h3>
      <div className="space-y-1">
        <Label htmlFor="vaccine-rule">When a required vaccine is expired or missing</Label>
        <select
          id="vaccine-rule"
          value={rule}
          disabled={!edit}
          onChange={(e) => setRule(e.target.value as VaccineRule)}
          className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
        >
          <option value="off">Off</option>
          <option value="warn">Warn the office</option>
          <option value="block">Block the booking</option>
        </select>
      </div>
      <fieldset>
        <legend className="text-sm font-medium">Required vaccines</legend>
        <div className="grid gap-x-4 sm:grid-cols-2">
          {REQUIRED_VACCINES.map((v) => (
            <label key={v} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={required.includes(v)}
                disabled={!edit}
                onChange={(e) =>
                  setRequired(e.target.checked ? [...required, v] : required.filter((r) => r !== v))
                }
              />
              {VACCINE_LABELS[v]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <Label htmlFor="groom-buffer">Setup, cleanup and travel minutes</Label>
        <Input
          id="groom-buffer"
          inputMode="numeric"
          value={bufferMin}
          disabled={!edit}
          onChange={(e) => setBufferMin(e.target.value)}
          className="h-11 w-24"
        />
        <p className="text-xs text-muted-foreground">
          A booking holds the groom plus these minutes so there is time to set up, clean up and
          drive.
        </p>
      </div>
      {edit && (
        <Button type="submit" disabled={save.isPending} className="min-h-11">
          {save.isPending ? "Saving…" : "Save grooming settings"}
        </Button>
      )}
    </form>
  );
}
