// Feeding and medication fields shared by the office and customer stay form.
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FEEDING_MAX, MED_DOSE_MAX, MED_NAME_MAX, MED_NOTES_MAX, MED_TIMES_MAX, MEDS_MAX, OTHER_CARE_MAX, type PetCare, type PetMed } from "@/lib/pets";

const blankMed = (): PetMed => ({ name: "", dose: null, times: ["08:00"], notes: null });

export function PetCareFields({ petId, value, onChange }: { petId: string; value: PetCare; onChange: (next: PetCare) => void }) {
  const feeding = value.feeding ?? "";
  const otherCare = value.other_care ?? "";
  const meds = value.meds;
  const setFeeding = (feeding: string) => onChange({ ...value, feeding });
  const setOtherCare = (other_care: string) => onChange({ ...value, other_care });
  const setMeds = (next: PetMed[] | ((list: PetMed[]) => PetMed[])) => onChange({ ...value, meds: typeof next === "function" ? next(meds) : next });
  const setMed = (i: number, patch: Partial<PetMed>) => setMeds(meds.map((m, j) => j === i ? { ...m, ...patch } : m));
  return <div className="space-y-3">
      <div>
        <Label htmlFor={`care-feeding-${petId}`} className="text-xs">
          Feeding
        </Label>
        <Textarea
          id={`care-feeding-${petId}`}
          value={feeding}
          maxLength={FEEDING_MAX}
          rows={2}
          placeholder="What, how much and when. Where the food is kept."
          onChange={(e) => setFeeding(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium">Medications</span>
          {meds.length < MEDS_MAX && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setMeds((list) => [...list, blankMed()])}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" /> Add medication
            </Button>
          )}
        </div>
        {meds.length === 0 && <p className="text-xs text-muted-foreground">No medications.</p>}
        <ul className="space-y-2">
          {meds.map((m, i) => (
            <li key={i} className="space-y-2 rounded-md border bg-background p-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="min-w-0">
                  <Label htmlFor={`med-name-${petId}-${i}`} className="text-xs">
                    Name
                  </Label>
                  <Input
                    id={`med-name-${petId}-${i}`}
                    value={m.name}
                    maxLength={MED_NAME_MAX}
                    onChange={(e) => setMed(i, { name: e.target.value })}
                  />
                </div>
                <div className="min-w-0">
                  <Label htmlFor={`med-dose-${petId}-${i}`} className="text-xs">
                    Dose
                  </Label>
                  <Input
                    id={`med-dose-${petId}-${i}`}
                    value={m.dose ?? ""}
                    maxLength={MED_DOSE_MAX}
                    placeholder="Half a tablet"
                    onChange={(e) => setMed(i, { dose: e.target.value })}
                  />
                </div>
              </div>
              <div>
                <span className="text-xs">Times</span>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {m.times.map((t, k) => (
                    <span key={k} className="flex items-center gap-1">
                      <Input
                        type="time"
                        aria-label={`Time ${k + 1}`}
                        className="w-32 touch:min-h-11"
                        value={t}
                        onChange={(e) =>
                          setMed(i, {
                            times: m.times.map((x, j) => (j === k ? e.target.value : x)),
                          })
                        }
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove time ${k + 1}`}
                        onClick={() => setMed(i, { times: m.times.filter((_, j) => j !== k) })}
                      >
                        <X className="h-4 w-4 shrink-0" />
                      </Button>
                    </span>
                  ))}
                  {m.times.length < MED_TIMES_MAX && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setMed(i, { times: [...m.times, "12:00"] })}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0" /> Add time
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Label htmlFor={`med-notes-${petId}-${i}`} className="text-xs">
                    Notes
                  </Label>
                  <Input
                    id={`med-notes-${petId}-${i}`}
                    value={m.notes ?? ""}
                    maxLength={MED_NOTES_MAX}
                    placeholder="Hide it in a treat"
                    onChange={(e) => setMed(i, { notes: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setMeds((list) => list.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" /> Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <Label htmlFor={`care-other-${petId}`} className="text-xs">
          Other care
        </Label>
        <Textarea
          id={`care-other-${petId}`}
          value={otherCare}
          maxLength={OTHER_CARE_MAX}
          rows={2}
          placeholder="Litter, plants, mail, lights."
          onChange={(e) => setOtherCare(e.target.value)}
        />
      </div>

  </div>;
}
