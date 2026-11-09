// Settings → Client portal: what happens when a customer reschedules or
// skips from the portal, per-line cutoffs, and late-change fees (#730, D6).
//
// The owner chooses. Everybody else who can open this page sees the choice
// and is told who can change it; the server and the database refuse them
// anyway (portal-change.functions.ts, 20261108153700).
//
// Laid out as one stacked block per service line rather than a table, so it
// reflows at 320px instead of scrolling sideways, and every input is a full
// touch target.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getPortalChangeSettings, setPortalChangeSettings } from "@/lib/portal-change.functions";
import {
  PORTAL_CHANGE_POLICIES,
  PORTAL_CHANGE_POLICY_LABELS,
  dollarsToCents,
  type PortalChangePolicy,
  type PortalChangeRule,
} from "@/lib/portal-change";
import {
  OFFERED_SERVICE_LINES,
  serviceLinesOrDefault,
  type ServiceLine,
} from "@/lib/service-lines";
import { humanizeEnum } from "@/lib/humanize";

type Draft = {
  cutoff: string;
  window: string;
  reschedFee: string;
  cancelFee: string;
};

const POLICY_HELP: Record<PortalChangePolicy, string> = {
  instant: "A client's reschedule or skip changes the schedule right away.",
  approval:
    "A client's reschedule or skip waits on the Requests page until you approve or deny it.",
};

function toDraft(r: PortalChangeRule | undefined): Draft {
  return {
    cutoff: r?.cutoff_hours == null ? "" : String(r.cutoff_hours),
    window:
      r?.late_window_hours == null || r.late_window_hours === 0 ? "" : String(r.late_window_hours),
    reschedFee: r?.late_reschedule_fee_cents ? (r.late_reschedule_fee_cents / 100).toFixed(2) : "",
    cancelFee: r?.late_cancel_fee_cents ? (r.late_cancel_fee_cents / 100).toFixed(2) : "",
  };
}

function hours(s: string): number | null | undefined {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 336 ? n : undefined;
}

export function PortalChangePolicyCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getPortalChangeSettings);
  const setFn = useServerFn(setPortalChangeSettings);
  const q = useQuery({ queryKey: ["portal-change-settings"], queryFn: () => getFn() });

  const [policy, setPolicy] = useState<PortalChangePolicy>("instant");
  const [autocharge, setAutocharge] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const lines = useMemo<ServiceLine[]>(() => {
    const runs = serviceLinesOrDefault(q.data?.serviceLines ?? null);
    return OFFERED_SERVICE_LINES.filter((l) => runs.includes(l));
  }, [q.data?.serviceLines]);

  useEffect(() => {
    if (!q.data) return;
    setPolicy(q.data.policy);
    setAutocharge(q.data.autocharge);
    const next: Record<string, Draft> = {};
    for (const l of lines) next[l] = toDraft(q.data.rules.find((r) => r.service_line === l));
    setDrafts(next);
  }, [q.data, lines]);

  const canEdit = !!q.data?.canEdit;

  const parsed = useMemo(() => {
    const rules: PortalChangeRule[] = [];
    for (const l of lines) {
      const d = drafts[l];
      if (!d) continue;
      const cutoff = hours(d.cutoff);
      const window = hours(d.window);
      const resched = dollarsToCents(d.reschedFee);
      const cancel = dollarsToCents(d.cancelFee);
      if (cutoff === undefined || window === undefined || resched === null || cancel === null) {
        return { error: `Check the numbers for ${humanizeEnum(l)}.` } as const;
      }
      if (resched > 100_000 || cancel > 100_000) {
        return { error: "A fee can be at most $1,000.00." } as const;
      }
      rules.push({
        service_line: l,
        cutoff_hours: cutoff,
        late_window_hours: window,
        late_reschedule_fee_cents: resched,
        late_cancel_fee_cents: cancel,
      });
    }
    return { rules } as const;
  }, [drafts, lines]);

  const mut = useMutation({
    mutationFn: () => {
      if ("error" in parsed) throw new Error(parsed.error);
      return setFn({ data: { policy, autocharge, rules: parsed.rules } });
    },
    onSuccess: () => {
      toast.success("Portal change rules saved");
      qc.invalidateQueries({ queryKey: ["portal-change-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = (line: string, k: keyof Draft, v: string) =>
    setDrafts((d) => ({ ...d, [line]: { ...(d[line] ?? toDraft(undefined)), [k]: v } }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reschedules and skips from the portal</CardTitle>
        <CardDescription>
          Choose whether a client's change applies right away or waits for you, and set late rules
          for each service you run. This covers reschedules and skips only: vacation holds and plan
          changes follow "Auto-apply requested changes" above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : q.isError ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : (
          <>
            {!canEdit && (
              <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                Only an owner can change these settings.
              </p>
            )}

            <fieldset className="space-y-2" disabled={!canEdit}>
              <legend className="text-sm font-medium">When a client reschedules or skips</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {PORTAL_CHANGE_POLICIES.map((p) => (
                  <label
                    key={p}
                    className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${policy === p ? "border-primary bg-primary/5" : ""}`}
                  >
                    <input
                      type="radio"
                      name="portal-change-policy"
                      value={p}
                      checked={policy === p}
                      onChange={() => setPolicy(p)}
                      className="mt-1 h-4 w-4 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{PORTAL_CHANGE_POLICY_LABELS[p]}</span>
                      <span className="block text-xs text-muted-foreground">{POLICY_HELP[p]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="space-y-3 border-t pt-4">
              <div>
                <p className="text-sm font-medium">Cutoffs and late fees</p>
                <p className="text-xs text-muted-foreground">
                  Hours are counted back from the start of the visit day. Leave the cutoff blank to
                  use your portal change cutoff ({q.data?.defaultCutoffHours ?? 18} hours). A late
                  fee applies to changes made inside the late window but before the cutoff. Leave
                  the window blank for no late fee. Your clients see the fee before they confirm a
                  change.
                </p>
              </div>
              {lines.map((l) => {
                const d = drafts[l] ?? toDraft(undefined);
                return (
                  <fieldset
                    key={l}
                    disabled={!canEdit}
                    className="min-w-0 space-y-2 rounded-md border p-3"
                  >
                    <legend className="px-1 text-sm font-medium">{humanizeEnum(l)}</legend>
                    <div className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="min-w-0">
                        <Label htmlFor={`pc-cutoff-${l}`} className="text-xs">
                          Cutoff (hours)
                        </Label>
                        <Input
                          id={`pc-cutoff-${l}`}
                          inputMode="numeric"
                          className="mt-1"
                          value={d.cutoff}
                          placeholder={String(q.data?.defaultCutoffHours ?? 18)}
                          onChange={(e) => set(l, "cutoff", e.target.value)}
                        />
                      </div>
                      <div className="min-w-0">
                        <Label htmlFor={`pc-window-${l}`} className="text-xs">
                          Late window (hours)
                        </Label>
                        <Input
                          id={`pc-window-${l}`}
                          inputMode="numeric"
                          className="mt-1"
                          value={d.window}
                          placeholder="No late fee"
                          onChange={(e) => set(l, "window", e.target.value)}
                        />
                      </div>
                      <div className="min-w-0">
                        <Label htmlFor={`pc-rfee-${l}`} className="text-xs">
                          Late reschedule fee ($)
                        </Label>
                        <Input
                          id={`pc-rfee-${l}`}
                          inputMode="decimal"
                          className="mt-1"
                          value={d.reschedFee}
                          placeholder="0.00"
                          onChange={(e) => set(l, "reschedFee", e.target.value)}
                        />
                      </div>
                      <div className="min-w-0">
                        <Label htmlFor={`pc-cfee-${l}`} className="text-xs">
                          Late skip fee ($)
                        </Label>
                        <Input
                          id={`pc-cfee-${l}`}
                          inputMode="decimal"
                          className="mt-1"
                          value={d.cancelFee}
                          placeholder="0.00"
                          onChange={(e) => set(l, "cancelFee", e.target.value)}
                        />
                      </div>
                    </div>
                  </fieldset>
                );
              })}
            </div>

            <div className="flex flex-wrap items-start justify-between gap-3 border-t pt-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Charge late fees automatically</p>
                <p className="text-xs text-muted-foreground">
                  Off by default. When on, an applied late change is charged to the client's saved
                  card. Charging runs in Stripe test mode only for now; until it is enabled for live
                  payments, fees are recorded for you to collect.
                </p>
              </div>
              <Switch
                checked={autocharge}
                onCheckedChange={setAutocharge}
                disabled={!canEdit}
                aria-label="Charge late fees automatically"
              />
            </div>

            {"error" in parsed && <p className="text-sm text-destructive">{parsed.error}</p>}

            {canEdit && (
              <div className="flex justify-end">
                <Button onClick={() => mut.mutate()} disabled={mut.isPending || "error" in parsed}>
                  {mut.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
