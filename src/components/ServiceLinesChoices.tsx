import { Checkbox } from "@/components/ui/checkbox";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";
import {
  BOOKABLE_SERVICE_LINES,
  OFFERED_SERVICE_LINES,
  SERVICE_LINE_LABEL,
  toggledServiceLines,
  type ServiceLine,
} from "@/lib/service-lines";

/**
 * The answer to "Which services do you offer?": one row per offered service line.
 *
 * Drawn by Settings → Business defaults, which saves on every tick, and by
 * the first step of /setup, which saves with the rest of its form. One
 * component so the two can never disagree about what is offered, what is
 * "Coming soon", or when a box can be ticked.
 *
 * Two rules keep it from ever stranding anybody:
 *   - a line that is already ticked can always be unticked, even one that is
 *     Coming soon (set some other way, or offered once and withdrawn). Once
 *     unticked, a Coming soon line cannot be ticked again, and setServiceLines
 *     refuses it too;
 *   - the last ticked line cannot be unticked: the database refuses an empty
 *     set, and "runs nothing" is not a business.
 *
 * Each row is the whole label, `min-h-11`, so the 44px target is the row and
 * not the 16px box. Office-only, so English.
 */
export function ServiceLinesChoices({
  lines,
  onChange,
  disabled = false,
  idPrefix = "service-line",
}: {
  lines: readonly ServiceLine[];
  onChange: (next: ServiceLine[]) => void;
  disabled?: boolean;
  /** Keeps the checkbox ids unique if two copies are ever on one page. */
  idPrefix?: string;
}) {
  return (
    <>
      <ul className="divide-y rounded-md border">
        {OFFERED_SERVICE_LINES.map((line) => {
          const checked = lines.includes(line);
          const bookable = BOOKABLE_SERVICE_LINES.includes(line);
          const onlyOne = checked && lines.length === 1;
          const off = disabled || onlyOne || (!checked && !bookable);
          const id = `${idPrefix}-${line}`;
          return (
            <li key={line}>
              <label
                htmlFor={id}
                className={`flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm ${
                  off ? "" : "cursor-pointer"
                }`}
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={off}
                  onCheckedChange={(c) => {
                    const next = toggledServiceLines(lines, line, c === true);
                    if (next) onChange(next);
                  }}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 font-medium">{SERVICE_LINE_LABEL[line]}</span>
                {!bookable && <ComingSoonBadge />}
              </label>
            </li>
          );
        })}
      </ul>
      {lines.length === 1 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Choose at least one service. Lines marked Coming soon cannot be added yet.
        </p>
      )}
    </>
  );
}
