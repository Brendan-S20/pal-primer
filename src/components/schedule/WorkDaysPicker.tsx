// Which weekdays the business operates.
//
// Lived inside routes.tsx until the planning-tools split, when the control it
// belongs to moved to Settings → Scheduling. Shared rather than copied: two
// pickers that disagree about whether Sunday is day 0 would silently generate
// visits on the wrong days.

import { toast } from "sonner";

/** Index 0 = Sunday, matching Postgres `extract(dow)` and the `work_days`
 *  column the server validates as 0..6. */
export const WORK_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WorkDaysPicker({
  value,
  onChange,
  disabled,
}: {
  value: number[];
  onChange: (days: number[]) => void;
  disabled?: boolean;
}) {
  const selected = new Set(value);
  const toggle = (d: number) => {
    const next = new Set(selected);
    next.has(d) ? next.delete(d) : next.add(d);
    if (next.size === 0) {
      // The server rejects an empty array too (min(1)); refusing here means the
      // last day cannot be un-picked into a failed request.
      toast.error("Keep at least one working day");
      return;
    }
    onChange([...next].sort((a, b) => a - b));
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {WORK_DAY_LABELS.map((label, d) => (
        <button
          key={d}
          type="button"
          disabled={disabled}
          onClick={() => toggle(d)}
          aria-pressed={selected.has(d)}
          // MEASURED 2026-08-19: 26.0px, seven of them — the row a dispatcher
          // taps to say which days this client is served on. A pill is round,
          // so the minimum goes on both axes or Sunday becomes an oval.
          // Selected is FILLED. It was a 10% tint of primary with primary
          // text, beside unselected pills with a border and grey text — on a
          // phone in daylight the two read as the same pill, and "which days
          // do we work" was a question the control could not answer at a
          // glance (reported 2026-09-27). aria-pressed says it to a screen
          // reader; this says it to everyone else.
          className={`inline-flex items-center justify-center rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50 touch:min-h-11 touch:min-w-11 shrink-0 ${
            selected.has(d)
              ? "border-primary bg-primary font-medium text-primary-foreground"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
