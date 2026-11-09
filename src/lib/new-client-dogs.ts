/** Whether the new-client wizard may leave its Dogs step, and whether the
 *  server may create the client (onboarding audit, 2026-11-09, D2).
 *
 *  A residential client could be created with no dog at all: the Dogs step
 *  let Continue through on a blank row, the plan was priced for
 *  `Math.max(1, rows)` = 1 dog, and the first thing the new client's Summary
 *  said was "Services bill for 1 dog, but no dog is on file". A residential
 *  account is somebody's pets; it needs at least one with a name, because
 *  only a named row is saved as a dog record.
 *
 *  A commercial / HOA account may still skip the step: its plan is priced
 *  from units and stations, not dogs, and the step says so.
 *
 *  Pure, so the wizard, the server function and the tests read one copy. */

export type AccountType = "residential" | "commercial";

/** The rows that would be saved as dogs: a name that is not blank. */
export function namedDogs<T extends { name: string }>(dogs: readonly T[] | undefined | null): T[] {
  return (dogs ?? []).filter((d) => d.name.trim().length > 0);
}

/** True when the account needs a named dog and has none. */
export function needsANamedDog(
  accountType: AccountType,
  dogs: readonly { name: string }[] | undefined | null,
): boolean {
  return accountType === "residential" && namedDogs(dogs).length === 0;
}

/** The inline message on the Dogs step. `pets` for a sitting business, whose
 *  step is called Pets. */
export function needsANamedDogMessage(pets = false): string {
  return pets
    ? "Add at least one pet's name to continue. A household client needs a pet on file before a plan can bill for one."
    : "Add at least one dog's name to continue. A residential client needs a dog on file before a plan can bill for one.";
}

/** What the server says when a residential client arrives with no dog. */
export const SERVER_NEEDS_A_NAMED_DOG =
  "A residential client needs at least one named dog. Add the dog on the Dogs step and try again.";
