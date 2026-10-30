// Moving a dog to another unit on the Units tab (#601).
//
// Both unit lists are drawn from ONE cached list, ["client-dogs", clientId],
// filtered by unit_id. Invalidating it alone left the move off the screen
// until a reload: an older read can land after the write (a fetch already in
// flight, or a read that has not seen the update yet) and puts the dog back on
// its old unit. updateDog has already confirmed the write when this runs, so
// the cache takes the new unit_id directly, an in-flight read is cancelled,
// and the list is marked stale rather than refetched on the spot. The next
// mount or return to the app reads it again.

import type { QueryClient } from "@tanstack/react-query";

type DogsData = { dogs: Array<{ id: string; unit_id?: string | null }> } | undefined;
type UnitsData = { reviewDogs?: Array<{ id: string }> } | undefined;

export async function applyDogMove(
  qc: QueryClient,
  clientId: string,
  dogId: string,
  unitId: string,
): Promise<void> {
  const dogsKey = ["client-dogs", clientId];
  const unitsKey = ["client-units", clientId];
  await qc.cancelQueries({ queryKey: dogsKey });

  qc.setQueryData<DogsData>(dogsKey, (prev) =>
    prev
      ? { ...prev, dogs: prev.dogs.map((d) => (d.id === dogId ? { ...d, unit_id: unitId } : d)) }
      : prev,
  );
  // A dog with a unit is out of management review (updateDog clears the flag).
  qc.setQueryData<UnitsData>(unitsKey, (prev) =>
    prev?.reviewDogs
      ? { ...prev, reviewDogs: prev.reviewDogs.filter((d) => d.id !== dogId) }
      : prev,
  );

  qc.invalidateQueries({ queryKey: dogsKey, refetchType: "none" });
  qc.invalidateQueries({ queryKey: unitsKey });
  qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  qc.invalidateQueries({ queryKey: ["dna-dogs", clientId] });
  qc.invalidateQueries({ queryKey: ["dna-all-dogs", clientId] });
}
