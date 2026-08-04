/**
 * Auto-routing: dates, techs, level, preview, apply.
 *
 * This replaces "Dispatch tools", which held a tech dropdown, three separate
 * optimize buttons with different scopes, and no way to find out what any of
 * them would do short of pressing one. Optimize on a route a dispatcher had
 * already ordered by hand was destructive and irreversible — the only way back
 * was to re-drag the day.
 *
 * Four inputs, a preview, and Apply. Nothing else, deliberately: the preview is
 * the safeguard, so the controls do not need to be defensive as well.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { applyOptimize, previewOptimize } from "@/lib/visits.functions";

const LEVELS = [
  {
    value: "fast" as const,
    label: "Fast",
    hint: "Shortest driving only. Ignores arrival windows and morning/afternoon preferences.",
  },
  {
    value: "balanced" as const,
    label: "Balanced",
    hint: "Shortest driving that still respects arrival windows and time-of-day preferences.",
  },
  {
    value: "thorough" as const,
    label: "Thorough",
    hint: "Balanced, then a second pass that removes crossings. Slower to compute, best on long days.",
  },
];

const mins = (n: number) => {
  const r = Math.round(n);
  if (Math.abs(r) < 60) return `${r} min`;
  const h = Math.floor(Math.abs(r) / 60);
  const m = Math.abs(r) % 60;
  return `${r < 0 ? "-" : ""}${h}h${m ? ` ${m}m` : ""}`;
};

export function AutoRoutingPanel({
  day,
  staff,
  onApplied,
}: {
  day: string;
  staff: any[];
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const previewFn = useServerFn(previewOptimize);
  const applyFn = useServerFn(applyOptimize);

  const techs = useMemo(() => staff.filter((s: any) => s.is_field_tech), [staff]);

  const [from, setFrom] = useState(day);
  const [to, setTo] = useState(day);
  const [level, setLevel] = useState<"fast" | "balanced" | "thorough">("balanced");
  const [reassign, setReassign] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const chosen = picked.size ? [...picked] : techs.map((s: any) => s.id);
  const rangeValid = Boolean(from && to && to >= from);

  const previewMut = useMutation({
    mutationFn: () => previewFn({ data: { staffIds: chosen, from, to, level, reassign } }),
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: () => applyFn({ data: { staffIds: chosen, from, to, level, reassign } }),
    onSuccess: (r) => {
      toast.success(`Re-ordered ${r.stops} stop${r.stops === 1 ? "" : "s"}.`);
      // Refusals are surfaced, not swallowed. A dispatcher who is not told a
      // day was skipped will believe it was optimized.
      for (const s of r.skipped.slice(0, 3)) toast.warning(s.reason, { duration: 8000 });
      if (r.skipped.length > 3) {
        toast.warning(`${r.skipped.length - 3} more day(s) skipped.`, { duration: 8000 });
      }
      previewMut.reset();
      qc.invalidateQueries({ queryKey: ["visits"] });
      onApplied();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const p = previewMut.data;
  const t = p?.totals;

  return (
    <div className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <Wand2 className="h-4 w-4" /> Auto-routing
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Days</Label>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                // Dragging the start past the end silently inverts the range
                // and the server rejects it. Carrying the end along keeps the
                // common case (one day) working without a second click.
                if (to < e.target.value) setTo(e.target.value);
                previewMut.reset();
              }}
              className="h-9"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => {
                setTo(e.target.value);
                previewMut.reset();
              }}
              className="h-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Optimization level</Label>
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            {LEVELS.map((l) => (
              <button
                key={l.value}
                title={l.hint}
                className={`rounded px-3 py-1 ${level === l.value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                onClick={() => {
                  setLevel(l.value);
                  previewMut.reset();
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {LEVELS.find((l) => l.value === level)!.hint}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">
          Techs {picked.size === 0 && <span className="text-muted-foreground">(all)</span>}
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {techs.map((s: any) => {
            const on = picked.has(s.id);
            return (
              <button
                key={s.id}
                onClick={() => {
                  const next = new Set(picked);
                  if (on) next.delete(s.id);
                  else next.add(s.id);
                  setPicked(next);
                  previewMut.reset();
                }}
                className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
              >
                {s.display_name}
              </button>
            );
          })}
          {techs.length === 0 && (
            <span className="text-xs text-muted-foreground">
              Nobody runs routes yet — switch someone on under Crew.
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <div>
          <div className="text-xs font-medium">Also move work between techs</div>
          <div className="text-[11px] text-muted-foreground">
            Off, each tech is re-ordered but keeps their own stops. On, stops can change hands.
          </div>
        </div>
        <Switch
          checked={reassign}
          onCheckedChange={(v) => {
            setReassign(v);
            previewMut.reset();
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={() => previewMut.mutate()}
          disabled={!rangeValid || techs.length === 0 || previewMut.isPending}
        >
          {previewMut.isPending ? "Working…" : "Preview"}
        </Button>
        {/* Apply is unreachable until a preview exists. That is the safeguard
            the old buttons lacked: nothing rearranges a day that somebody has
            not first been shown. */}
        <Button
          onClick={() => applyMut.mutate()}
          disabled={!p || applyMut.isPending || p.days.length === 0}
          title={!p ? "Preview first" : undefined}
        >
          {applyMut.isPending ? "Applying…" : "Apply"}
        </Button>
        {!p && (
          <span className="text-[11px] text-muted-foreground">
            Preview first — Apply reorders the days you picked.
          </span>
        )}
      </div>

      {p && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          {p.days.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing to route in that range — no scheduled stops for those techs on those days.
            </p>
          ) : (
            <>
              <div className="text-sm">
                {/* The headline is the honest one. `daysMeasured` counts only
                    days that HAD a route to compare against; a day whose stops
                    carry no sequence is not a slower route, it is no route,
                    and folding it in would invent a saving. */}
                {t!.daysMeasured > 0 ? (
                  t!.savedMin > 0.5 ? (
                    <>
                      Saves about <strong>{mins(t!.savedMin)}</strong> of driving across{" "}
                      {t!.daysMeasured} already-ordered day{t!.daysMeasured === 1 ? "" : "s"}.
                    </>
                  ) : t!.savedMin < -0.5 ? (
                    <>
                      Adds about <strong>{mins(-t!.savedMin)}</strong> of driving — the current
                      order is already better. Leave it alone.
                    </>
                  ) : (
                    <>No meaningful change to driving time. The current order is already good.</>
                  )
                ) : (
                  <>
                    <strong>New route.</strong> These days were not ordered yet, so there is
                    nothing to compare against.
                  </>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {t!.stops} stop{t!.stops === 1 ? "" : "s"} across {t!.daysPlanned} tech-day
                {t!.daysPlanned === 1 ? "" : "s"}
                {t!.daysPlanned > t!.daysMeasured && (
                  <> · {t!.daysPlanned - t!.daysMeasured} not previously ordered</>
                )}
                {t!.violations > 0 && (
                  <>
                    {" "}
                    ·{" "}
                    <span className="text-amber-700">
                      {t!.violations} stop{t!.violations === 1 ? "" : "s"} would still miss its
                      arrival window
                    </span>
                  </>
                )}
              </div>
              <div className="max-h-40 overflow-y-auto text-[11px]">
                <table className="w-full">
                  <tbody>
                    {p.days.map((d: any) => {
                      const who = staff.find((s: any) => s.id === d.staff_id);
                      const delta = Number(d.before_min) - Number(d.after_min);
                      return (
                        <tr key={`${d.staff_id}-${d.day}`} className="border-b last:border-0">
                          <td className="py-1 pr-2">{who?.display_name ?? "—"}</td>
                          <td className="py-1 pr-2 text-muted-foreground">{d.day}</td>
                          <td className="py-1 pr-2 text-muted-foreground">{d.stops} stops</td>
                          <td className="py-1 text-right">
                            {d.before_known ? (
                              <span className={delta > 0.5 ? "text-emerald-600" : "text-muted-foreground"}>
                                {mins(Number(d.before_min))} → {mins(Number(d.after_min))}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                new · {mins(Number(d.after_min))}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
