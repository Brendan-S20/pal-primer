import { useId } from "react";
import { SERVICE_LINES, SERVICE_LINE_LABEL, type ServiceLine } from "@/lib/service-lines";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AddonGroomFields({
  grooming,
  durationMin,
  serviceLine,
  onChange,
}: {
  grooming: boolean;
  durationMin: string;
  serviceLine: string;
  onChange: (patch: { durationMin?: string; serviceLine?: ServiceLine | "" }) => void;
}) {
  const id = useId();
  if (!grooming) return null;
  return (
    <>
      <div className="min-w-0 space-y-1 sm:col-span-2">
        <Label htmlFor={`${id}-minutes`}>Minutes</Label>
        <Input
          id={`${id}-minutes`}
          className="min-h-11"
          type="number"
          inputMode="numeric"
          min={0}
          max={480}
          step={1}
          value={durationMin}
          onChange={(e) => onChange({ durationMin: e.target.value })}
        />
      </div>
      <div className="min-w-0 space-y-1 sm:col-span-2">
        <Label htmlFor={`${id}-line`}>Offered with</Label>
        <select
          id={`${id}-line`}
          className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
          value={serviceLine}
          onChange={(e) => onChange({ serviceLine: e.target.value as ServiceLine | "" })}
        >
          {SERVICE_LINES.map((line) => (
            <option key={line} value={line}>
              {SERVICE_LINE_LABEL[line]}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
