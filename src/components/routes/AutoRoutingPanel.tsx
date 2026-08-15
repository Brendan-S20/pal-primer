/**
 * Auto-routing, as a floating card rather than a slab.
 *
 * ── WHAT WAS WRONG WITH THE LAST ONE ──────────────────────────────────────
 *
 * It was correct and unusable. Opening it inserted a full-width block between
 * the toolbar and the board, so the thing you were routing slid off-screen at
 * the moment you started routing it. Two date inputs, three level buttons with
 * a paragraph of hint text, a chip per tech, a bordered switch with two lines
 * of explanation, two buttons and a result table — all expanded at once,
 * roughly 500px tall before the preview even ran. The verdict was fair: it
 * "covers the majority of the screen" and it is "very much in the way".
 *
 * The information was not the problem; the simultaneity was. Every control was
 * shouting its full explanation whether or not you were touching it.
 *
 * ── THE SHAPE ─────────────────────────────────────────────────────────────
 *
 * A ~320px card floating over the board, bottom-right, so the schedule stays
 * visible and in place behind it. Each input collapses to a pill that STATES
 * ITS CURRENT VALUE — "Aug 5", "All techs", "Balanced" — and opens to an
 * editor only when clicked. One open at a time, so the card cannot grow past
 * about a third of the viewport.
 *
 * A pill showing its value is doing two jobs: it is the control, and it is the
 * summary you would otherwise need the panel open to read.
 *
 * The preview result collapses the same way. The per-day table is gone from
 * the card — a dispatcher deciding whether to apply needs the headline, not
 * fourteen rows — and the things that were buried in that table's margins
 * (arrival-window violations, days that could not be planned) are toasts,
 * because those are the ones you must not miss.
 *
 * Everything the previous panel could express, it still expresses. Preview is
 * still mandatory before Apply; refusals are still surfaced rather than
 * swallowed; the honest "New route" headline still refuses to invent a saving
 * for a day that had no route to begin with.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarDays, Check, ChevronDown, Users, Wand2, X, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

/** "Aug 5" — the pill has ~90px, and the year is almost never the question. */
const shortDay = (iso: string) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

type Section = "dates" | "techs" | "level" | null;

function Pill({
  icon: Icon,
  value,
  open,
  onClick,
}: {
  icon: typeof CalendarDays;
  value: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        open ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="max-w-[9rem] truncate">{value}</span>
      <ChevronDown
        className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}

export function AutoRoutingPanel({
  day,
  staff,
  onApplied,
  onClose,
}: {
  day: string;
  staff: any[];
  onApplied: () => void;
  onClose: () => void;
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
  const [section, setSection] = useState<Section>(null);

  const chosen = picked.size ? [...picked] : techs.map((s: any) => s.id);

  // First names only: the toast lists every technician in the run, and three
  // full names is already wider than a phone.
  const nameOf = (id: string) =>
    String(staff.find((s: any) => s.id === id)?.display_name ?? "Tech").split(" ")[0];
  const rangeValid = Boolean(from && to && to >= from);

  const previewMut = useMutation({
    mutationFn: () => previewFn({ data: { staffIds: chosen, from, to, level, reassign } }),
    onSuccess: (r) => {
      // Surfaced here rather than in a table nobody reads to the end of. A stop
      // that will still miss its window is the one fact that should change your
      // mind about pressing Apply.
      const v = r.totals?.violations ?? 0;
      if (v > 0) {
        toast.warning(
          `${v} stop${v === 1 ? "" : "s"} would still miss its arrival window.`,
          { duration: 8000 },
        );
      }
      const unordered = (r.totals?.daysPlanned ?? 0) - (r.totals?.daysMeasured ?? 0);
      if (unordered > 0 && (r.totals?.daysMeasured ?? 0) > 0) {
        toast.info(`${unordered} tech-day${unordered === 1 ? "" : "s"} had no route to compare.`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: () => applyFn({ data: { staffIds: chosen, from, to, level, reassign } }),
    onSuccess: (r) => {
      // The split is the point, so it is what the toast says. "Re-ordered 20
      // stops" was true both before and after the fix for the bug where all
      // twenty landed on one technician — it could not tell the dispatcher
      // whether the work had actually been divided.
      const share = (r.balance ?? [])
        .map((b) => `${nameOf(b.staffId)} ${b.stops}`)
        .join(" · ");
      toast.success(
        `Routed ${r.stops} stop${r.stops === 1 ? "" : "s"}` + (share ? ` — ${share}` : "."),
      );
      // Refusals are surfaced, not swallowed. A dispatcher who is not told a
      // day was skipped will believe it was optimized.
      for (const s of r.skipped.slice(0, 3)) toast.warning(s.reason, { duration: 8000 });
      if (r.skipped.length > 3) {
        toast.warning(`${r.skipped.length - 3} more day(s) skipped.`, { duration: 8000 });
      }
      previewMut.reset();
      qc.invalidateQueries({ queryKey: ["visits"] });
      onApplied();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Any change to the inputs invalidates the preview, and Apply is gated on a
  // preview existing — so this is what stops somebody previewing Monday and
  // applying it to Friday.
  const dirty = () => {
    previewMut.reset();
  };

  // Escape closes the card. It floats above the board, so the usual instinct
  // for "get this out of my way" has to work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (section) setSection(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, onClose]);

  const p = previewMut.data;
  const t = p?.totals;
  const busy = previewMut.isPending || applyMut.isPending;

  const dateLabel = from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`;
  const techLabel =
    picked.size === 0
      ? "All techs"
      : picked.size === 1
        ? (techs.find((s: any) => picked.has(s.id))?.display_name ?? "1 tech")
        : `${picked.size} techs`;

  return (
    <div
      role="dialog"
      aria-label="Auto-routing"
      className="fixed inset-x-3 bottom-3 z-40 max-h-[min(32rem,calc(100vh-6rem))] overflow-y-auto rounded-lg border bg-card shadow-xl sm:left-auto sm:right-4 sm:w-80"
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Wand2 className="h-4 w-4" /> Auto-routing
        </div>
        <button
          onClick={onClose}
          aria-label="Close auto-routing"
          className="rounded p-1 text-muted-foreground hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-2 p-3">
        <div className="flex flex-wrap gap-1.5">
          <Pill
            icon={CalendarDays}
            value={dateLabel}
            open={section === "dates"}
            onClick={() => setSection(section === "dates" ? null : "dates")}
          />
          <Pill
            icon={Users}
            value={techLabel}
            open={section === "techs"}
            onClick={() => setSection(section === "techs" ? null : "techs")}
          />
          <Pill
            icon={Zap}
            value={LEVELS.find((l) => l.value === level)!.label}
            open={section === "level"}
            onClick={() => setSection(section === "level" ? null : "level")}
          />
        </div>

        {section === "dates" && (
          <div className="space-y-1.5 rounded-md border p-2">
            <Label className="text-2xs text-muted-foreground">Days to route</Label>
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={from}
                aria-label="First day"
                onChange={(e) => {
                  setFrom(e.target.value);
                  // Dragging the start past the end silently inverts the range
                  // and the server rejects it. Carrying the end along keeps the
                  // common case (one day) working without a second click.
                  if (to < e.target.value) setTo(e.target.value);
                  dirty();
                }}
                className="h-8 text-xs"
              />
              <span className="text-2xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={to}
                min={from || undefined}
                aria-label="Last day"
                onChange={(e) => {
                  setTo(e.target.value);
                  dirty();
                }}
                className="h-8 text-xs"
              />
            </div>
          </div>
        )}

        {section === "techs" && (
          <div className="space-y-1.5 rounded-md border p-2">
            <div className="flex items-center justify-between">
              <Label className="text-2xs text-muted-foreground">
                {picked.size === 0 ? "Everyone who runs routes" : `${picked.size} selected`}
              </Label>
              {picked.size > 0 && (
                <button
                  className="text-2xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    setPicked(new Set());
                    dirty();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
              {techs.map((s: any) => {
                const on = picked.has(s.id);
                return (
                  <button
                    key={s.id}
                    aria-pressed={on}
                    onClick={() => {
                      const next = new Set(picked);
                      if (on) next.delete(s.id);
                      else next.add(s.id);
                      setPicked(next);
                      dirty();
                    }}
                    className={`rounded-full border px-2 py-0.5 text-2xs ${on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    {s.display_name}
                  </button>
                );
              })}
              {techs.length === 0 && (
                <span className="text-2xs text-muted-foreground">
                  Nobody runs routes yet — switch someone on under Crew.
                </span>
              )}
            </div>
          </div>
        )}

        {section === "level" && (
          <div className="space-y-1 rounded-md border p-2">
            {LEVELS.map((l) => (
              <button
                key={l.value}
                onClick={() => {
                  setLevel(l.value);
                  dirty();
                }}
                className={`flex w-full items-start gap-1.5 rounded p-1.5 text-left ${level === l.value ? "bg-muted" : "hover:bg-muted/60"}`}
              >
                <Check
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${level === l.value ? "text-primary" : "text-transparent"}`}
                />
                <span>
                  <span className="block text-xs font-medium">{l.label}</span>
                  <span className="block text-2xs leading-snug text-muted-foreground">
                    {l.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {/* One checkbox, and it stays visible rather than hiding behind a pill:
            it is the only control here that can move a stop from one person to
            another, and that is not something to discover after the fact. */}
        <label className="flex items-start gap-2 pt-0.5 text-2xs">
          <Checkbox
            checked={reassign}
            onCheckedChange={(v) => {
              setReassign(v === true);
              dirty();
            }}
            className="mt-0.5"
          />
          <span>
            Also move work between techs
            <span className="block text-muted-foreground">
              Off, each tech keeps their own stops and is only re-ordered.
            </span>
          </span>
        </label>

        {p && (
          <div className="rounded-md border bg-muted/40 p-2 text-xs">
            {p.days.length === 0 ? (
              /* Two ways to get here, and until 20260815190000 only the first
                 existed. The preview now reports what Apply would actually do,
                 and Apply does nothing to a day whose stops are all assigned
                 already unless it is allowed to move work between techs — so
                 an empty preview on a full day is a correct answer, and the
                 old sentence ("no scheduled stops") was flatly untrue for it. */
              <span className="text-muted-foreground">
                Nothing to route in that range. Either those techs have no scheduled stops, or
                every stop is already assigned and “Also move work between techs” is off.
              </span>
            ) : (
              <>
                {/* The headline is the honest one. `daysMeasured` counts only
                    days that HAD a route to compare against; a day whose stops
                    carry no sequence is not a slower route, it is no route, and
                    folding it in would invent a saving. */}
                {t!.daysMeasured > 0 ? (
                  t!.savedMin > 0.5 ? (
                    <>
                      Saves about <strong>{mins(t!.savedMin)}</strong> of driving.
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
                <div className="mt-0.5 text-2xs text-muted-foreground">
                  {t!.stops} stop{t!.stops === 1 ? "" : "s"} · {t!.daysPlanned} tech-day
                  {t!.daysPlanned === 1 ? "" : "s"}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => previewMut.mutate()}
            disabled={!rangeValid || techs.length === 0 || busy}
          >
            {previewMut.isPending ? "Working…" : "Preview"}
          </Button>
          {/* Apply is unreachable until a preview exists. That is the safeguard
              the old buttons lacked: nothing rearranges a day that somebody has
              not first been shown. */}
          <Button
            size="sm"
            onClick={() => applyMut.mutate()}
            disabled={!p || applyMut.isPending || p.days.length === 0}
            title={!p ? "Preview first" : undefined}
          >
            {applyMut.isPending ? "Applying…" : "Apply"}
          </Button>
        </div>
      </div>
    </div>
  );
}
