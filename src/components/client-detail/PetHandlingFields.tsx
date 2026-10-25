import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PetHandling = {
  muzzleRequired: boolean;
  biteHistory: boolean;
  seniorOrMedical: boolean;
  handlingNotes: string;
};

export const NO_HANDLING: PetHandling = {
  muzzleRequired: false,
  biteHistory: false,
  seniorOrMedical: false,
  handlingNotes: "",
};

/** Office fields for how a groomer handles the pet. My Day shows them at the
 *  top of the pet's block on every groom. */
export function PetHandlingFields({
  value,
  onChange,
}: {
  value: PetHandling;
  onChange: (next: PetHandling) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const flags: [keyof PetHandling, string][] = [
    ["muzzleRequired", t("groom.muzzle")],
    ["biteHistory", t("groom.bite")],
    ["seniorOrMedical", t("groom.senior")],
  ];
  return (
    <fieldset className="min-w-0 space-y-1 sm:col-span-5">
      <legend className="text-xs font-medium">{t("groom.handlingLegend")}</legend>
      <div className="flex flex-wrap gap-x-4">
        {flags.map(([key, label]) => (
          <label key={key} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0"
              checked={value[key] as boolean}
              onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <Label htmlFor={`${id}-handling`} className="text-xs">
        {t("groom.handlingNotes")}
      </Label>
      <Input
        id={`${id}-handling`}
        className="min-h-11"
        maxLength={1000}
        value={value.handlingNotes}
        onChange={(e) => onChange({ ...value, handlingNotes: e.target.value })}
      />
    </fieldset>
  );
}
