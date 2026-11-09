/**
 * How many dogs one person walks at once, on Users & roles (#731).
 *
 * Empty means no cap of their own, which is every person until somebody sets
 * one, so a business that never touches this keeps the group sizes it set on
 * the service. When set, a group walk with this walker holds the smaller of
 * the two, and the database refuses a walk that would go over
 * (20261108170000). Drawn only for a business that walks dogs.
 *
 * Lowering a cap does not move or refuse anything already booked; the group
 * shows as over the cap on Routes and the office decides.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { useServiceLines } from "@/components/CommercialOnly";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseDogCap } from "@/lib/walk-groups";
import { listWalkerDogCaps, setWalkerDogCap } from "@/lib/walk-groups.functions";

export const WALKER_DOG_CAPS_KEY = ["walker-dog-caps"] as const;

export function WalkerDogCap({ staffId, canEdit }: { staffId: string; canEdit: boolean }) {
  const { lines, known } = useServiceLines();
  if (!known || !lines.includes("dog_walking")) return null;
  return <WalkerDogCapField staffId={staffId} canEdit={canEdit} />;
}

function WalkerDogCapField({ staffId, canEdit }: { staffId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listWalkerDogCaps);
  const saveFn = useServerFn(setWalkerDogCap);
  const q = useQuery({ queryKey: WALKER_DOG_CAPS_KEY, queryFn: () => listFn() });
  const current = q.data?.rows.find((r) => r.id === staffId)?.maxDogs ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (current == null ? "" : String(current));
  const parsed = parseDogCap(value);
  const save = useMutation({
    mutationFn: (maxDogs: number | null) => saveFn({ data: { staffId, maxDogs } }),
    onSuccess: () => {
      toast.success("Dog cap saved");
      setDraft(null);
      void qc.invalidateQueries({ queryKey: WALKER_DOG_CAPS_KEY });
      void qc.invalidateQueries({ queryKey: ["visits", "walk-groups"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const id = `dog-cap-${staffId}`;
  return (
    <div className="sm:col-span-2 space-y-2 border-t pt-3">
      <Label htmlFor={id} className="text-xs">
        Most dogs walked at once
      </Label>
      <p className="text-xs text-muted-foreground">
        Leave empty for no cap. A group walk with this person never holds more dogs than this, even
        when the service allows more.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          className="min-h-11 w-28 min-w-0"
          inputMode="numeric"
          placeholder="No cap"
          value={value}
          disabled={!canEdit || q.isLoading || save.isPending}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={!parsed.ok}
        />
        {canEdit && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 shrink-0"
            disabled={draft == null || !parsed.ok || save.isPending}
            onClick={() => parsed.ok && save.mutate(parsed.value)}
          >
            Save cap
          </Button>
        )}
      </div>
      {!parsed.ok && (
        <p role="alert" className="text-xs text-destructive">
          Enter a whole number from 1 to 50, or leave it empty.
        </p>
      )}
    </div>
  );
}
