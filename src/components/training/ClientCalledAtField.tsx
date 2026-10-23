import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** datetime-local wants "YYYY-MM-DDTHH:MM" in local time, with no zone. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Now, as the field's value. The cancel form opens with this filled in. */
export function nowAsCalledAt(): string {
  return toLocalInput(new Date());
}

/** The field's value as an ISO timestamp for office_skip_visit, or null when empty. */
export function clientCalledAtIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * On a training package lesson's office cancel: when the client called. The
 * late-cancel rule measures notice from this time. Empty means now.
 */
export function ClientCalledAtField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-xs">
        Client called to cancel at
      </Label>
      <Input
        id={id}
        type="datetime-local"
        className="w-full sm:w-56"
        value={value}
        max={toLocalInput(new Date())}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        The late-cancel window is measured from this time, not from when you save.
      </p>
    </div>
  );
}
