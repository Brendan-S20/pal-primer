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
          className={`rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50 ${
            selected.has(d)
              ? "border-primary bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
