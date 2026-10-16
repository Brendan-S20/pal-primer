// How a pet is looked after (#411): feeding, medications with dose and
// times, and other care (litter, plants, mail). Shown on a pet for a
// business that runs pet sitting. Office screen, English.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PetCareFields } from "@/components/PetCareFields";
import { setPetCare } from "@/lib/stays.functions";
import {
  cleanMeds,
  medsProblem,
  type PetCare,
  type PetMed,
} from "@/lib/pets";
import { clockLabel } from "@/lib/walk-windows";

/** One line under a pet: "Feeding written, 2 medications, other care". */
export function careSummary(care: PetCare | null | undefined): string | null {
  if (!care) return null;
  const parts = [
    care.feeding?.trim() ? "Feeding" : null,
    care.meds.length === 1
      ? "1 medication"
      : care.meds.length > 1
        ? `${care.meds.length} medications`
        : null,
    care.other_care?.trim() ? "Other care" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** "Insulin, 2 units at 8 AM and 8 PM". */
export function medLine(m: PetMed): string {
  const times = m.times.map((t) => clockLabel(t)).filter(Boolean);
  return (
    [m.name, m.dose].filter(Boolean).join(", ") + (times.length ? ` at ${times.join(" and ")}` : "")
  );
}

export function PetCareEditor({
  petId,
  petName,
  care,
  clientId,
  onDone,
}: {
  petId: string;
  petName: string;
  care: PetCare | null;
  clientId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const saveFn = useServerFn(setPetCare);
  const [feeding, setFeeding] = useState(care?.feeding ?? "");
  const [otherCare, setOtherCare] = useState(care?.other_care ?? "");
  const [meds, setMeds] = useState<PetMed[]>(care?.meds ?? []);

  const problem = medsProblem(cleanMeds(meds));
  const save = useMutation({
    mutationFn: () =>
      saveFn({
        data: {
          petId,
          feeding: feeding.trim() || null,
          meds: cleanMeds(meds),
          otherCare: otherCare.trim() || null,
        },
      }),
    onSuccess: () => {
      toast.success(`Saved care for ${petName}`);
      qc.invalidateQueries({ queryKey: ["pet-care", clientId] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <form
      className="mt-2 space-y-3 rounded-md border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) save.mutate();
      }}
    >
      <PetCareFields petId={petId} value={{ feeding, other_care: otherCare, meds }} onChange={(next) => {
        setFeeding(next.feeding ?? "");
        setOtherCare(next.other_care ?? "");
        setMeds(next.meds);
      }} />

      {problem && <p className="text-xs text-destructive">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={save.isPending || !!problem}>
          {save.isPending ? "Saving…" : "Save care"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
