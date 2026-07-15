// Styled date and time fields (QA follow-up 3.2): replace the native
// mm/dd/yyyy and --:-- -- controls with labeled, accessible pickers that
// render consistently across browsers. Values stay canonical (ISO date
// "YYYY-MM-DD", 24h time "HH:MM"); display is humanized.
import { useId, useState } from "react";
import { CalendarIcon, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatDay } from "@/lib/format";

function isoToDate(iso: string | ""): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function dateToISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DateField({
  label,
  value,
  onChange,
  minISO,
  clearable = false,
  clearLabel = "No date",
  error,
  hint,
}: {
  label: string;
  /** ISO date or "" (when clearable). */
  value: string;
  onChange: (iso: string) => void;
  minISO?: string;
  clearable?: boolean;
  clearLabel?: string;
  error?: string | null;
  hint?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className={cn(
              "mt-0.5 h-10 w-full justify-start text-left font-normal",
              !value && "text-muted-foreground",
              error && "border-destructive",
            )}
            aria-invalid={!!error}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
            {value ? formatDay(value) : clearable ? clearLabel : "Pick a date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={isoToDate(value)}
            defaultMonth={isoToDate(value)}
            disabled={minISO ? { before: isoToDate(minISO)! } : undefined}
            onSelect={(d) => {
              if (d) onChange(dateToISO(d));
              setOpen(false);
            }}
          />
          {clearable && value && (
            <div className="border-t p-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
              >
                Clear ({clearLabel})
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      {error ? (
        <p className="mt-1 text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-foreground/60">{hint}</p>
      ) : null}
    </div>
  );
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = ["00", "15", "30", "45"];

export function TimeField({
  label,
  value,
  onChange,
  clearable = true,
  clearLabel = "Anytime",
}: {
  label: string;
  /** 24h "HH:MM" or "" for unset. */
  value: string;
  onChange: (v: string) => void;
  clearable?: boolean;
  clearLabel?: string;
}) {
  const id = useId();
  const [h24, m] = value ? value.split(":") : ["", ""];
  const hourNum = h24 === "" ? null : Number(h24);
  const isPM = hourNum != null && hourNum >= 12;
  const hour12 = hourNum == null ? "" : String(hourNum % 12 === 0 ? 12 : hourNum % 12);

  function emit(nextHour12: string, nextMin: string, nextPM: boolean) {
    if (!nextHour12) {
      onChange("");
      return;
    }
    const h = Number(nextHour12) % 12;
    const h24v = nextPM ? h + 12 : h;
    onChange(`${String(h24v).padStart(2, "0")}:${nextMin || "00"}`);
  }

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-0.5 flex items-center gap-1">
        <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <select
          id={id}
          aria-label={`${label} hour`}
          value={hour12}
          onChange={(e) => emit(e.target.value, m || "00", isPM)}
          className="h-10 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{clearable ? clearLabel : "--"}</option>
          {HOURS.map((h) => (
            <option key={h} value={String(h)}>
              {h}
            </option>
          ))}
        </select>
        <span aria-hidden>:</span>
        <select
          aria-label={`${label} minutes`}
          value={m || "00"}
          onChange={(e) => emit(hour12, e.target.value, isPM)}
          disabled={!hour12}
          className="h-10 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
        >
          {MINUTES.map((mm) => (
            <option key={mm} value={mm}>
              {mm}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label} AM or PM`}
          value={isPM ? "PM" : "AM"}
          onChange={(e) => emit(hour12, m || "00", e.target.value === "PM")}
          disabled={!hour12}
          className="h-10 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      </div>
    </div>
  );
}
