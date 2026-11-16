import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DOG_BREED_PLACEHOLDER, DOG_NAME_PLACEHOLDER } from "@/lib/new-client-dogs";

/** The Name and Breed boxes on one row of the new-client wizard's Dogs step.
 *
 *  #944: a tester cleared both boxes and read "Bailey" and "Lab mix" back as
 *  real values. They were placeholders only (the boxes are controlled by
 *  `name` / `breed`, and nothing writes those words into them), but a bare
 *  name in muted grey reads like a dog that is on file, and the browser was
 *  free to offer its own remembered values on top. So the hint says it is an
 *  example ("e.g. Bailey"), and autofill is off on both boxes: what is in
 *  them is only ever what the owner typed. */
export function DogNameAndBreedFields({
  name,
  breed,
  onChange,
  "aria-invalid": invalid,
  "aria-describedby": describedBy,
}: {
  name: string;
  breed: string;
  onChange: (patch: { name?: string; breed?: string }) => void;
  /** Put on the Name box: the one the "needs a named dog" alert is about. */
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <>
      <div className="space-y-1">
        <Label className="text-xs">Name</Label>
        <Input
          value={name}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          autoComplete="off"
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={DOG_NAME_PLACEHOLDER}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Breed</Label>
        <Input
          value={breed}
          autoComplete="off"
          onChange={(e) => onChange({ breed: e.target.value })}
          placeholder={DOG_BREED_PLACEHOLDER}
        />
      </div>
    </>
  );
}
