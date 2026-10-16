import { useId } from "react";
import { COAT_LABEL, COAT_TYPES, PET_SIZES, PET_SIZE_LABEL, type CoatType } from "@/lib/groom";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Office fields. Imported size text remains an option until the owner changes it. */
export function PetSizeFields({
  size,
  coatType,
  weightLb,
  grooming,
  onChange,
}: {
  size: string;
  coatType: string;
  weightLb: string;
  grooming: boolean;
  onChange: (patch: { size?: string; coatType?: CoatType | ""; weightLb?: string }) => void;
}) {
  const id = useId();
  return (
    <>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`${id}-size`}>Size</Label>
        <select
          id={`${id}-size`}
          className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
          value={size}
          onChange={(e) => onChange({ size: e.target.value })}
        >
          <option value="">Not set</option>
          {size && !PET_SIZES.includes(size as (typeof PET_SIZES)[number]) && (
            <option value={size}>{size}</option>
          )}
          {PET_SIZES.map((s) => (
            <option key={s} value={s}>
              {PET_SIZE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {grooming && (
        <>
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${id}-coat`}>Coat type</Label>
            <select
              id={`${id}-coat`}
              className="min-h-11 w-full rounded-md border bg-background px-3 text-sm"
              value={coatType}
              onChange={(e) => onChange({ coatType: e.target.value as CoatType | "" })}
            >
              <option value="">Not set</option>
              {COAT_TYPES.map((c) => (
                <option key={c} value={c}>
                  {COAT_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${id}-weight`}>Weight (lb)</Label>
            <Input
              id={`${id}-weight`}
              className="min-h-11"
              type="number"
              inputMode="decimal"
              min={0.1}
              max={300}
              step={0.1}
              value={weightLb}
              onChange={(e) => onChange({ weightLb: e.target.value })}
            />
          </div>
        </>
      )}
    </>
  );
}
