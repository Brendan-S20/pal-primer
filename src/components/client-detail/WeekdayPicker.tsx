// The plan form's weekday picker (service catalog, phase 3): seven toggle
// chips, Monday first, for the days a walk plan runs on. The rules are in
// src/lib/weekday-set.ts.
//
// Each chip is a 44px target on a touch screen (`touch:`, never `max-md:`,
// tests/a-thumb-is-not-a-screen-width.test.ts) and keeps its width in the row
// (`shrink-0`, tests/a-width-floor-is-not-a-shrink-floor.test.ts). The row
// wraps, so seven chips fit a 360px phone on two lines rather than pushing
// the drawer sideways.
import { cn } from "@/lib/utils";
import { WEEK_ORDER, toggleWeekday, weekdayName } from "@/lib/weekday-set";

export function WeekdayPicker({
  id = "sd-weekdays",
  label,
  value,
  onChange,
  locale,
  invalid = false,
}: {
  id?: string;
  label: string;
  /** Days on, 0 = Sunday ... 6 = Saturday. */
  value: readonly number[];
  onChange: (days: number[]) => void;
  /** The formatters' locale (useIntlLocale); the device's when omitted. */
  locale?: string;
  invalid?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span id={`${id}-label`} className="text-sm font-medium leading-none">
        {label}
      </span>
      <div
        role="group"
        aria-labelledby={`${id}-label`}
        aria-invalid={invalid || undefined}
        className="mt-2 flex flex-wrap gap-2"
      >
        {WEEK_ORDER.map((d) => {
          const on = value.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={weekdayName(d, locale, "long")}
              onClick={() => onChange(toggleWeekday(value, d))}
              className={cn(
                "inline-flex h-9 min-w-12 shrink-0 items-center justify-center rounded-md border px-3 text-sm touch:h-11 touch:min-w-11",
                on
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background text-foreground",
                invalid && !on && "border-destructive",
              )}
            >
              {weekdayName(d, locale)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
