// The platform switch (#531) as a test holds it.
//
// The real answer is public.platform_service_lines, read at runtime. A test
// that drives the rules without a database passes one of these instead.
// LAUNCH_DEFAULT is the switch as a replay of the migrations leaves it: the
// seed (20261025200000) plus each later flip (20261026200000, pet sitting;
// 20261027120000, training).
// tests/a-service-line-is-turned-on-only-when-bookable.test.ts fails if the
// two ever differ.

import type { ServiceLine, ServiceLineAvailability } from "@/lib/service-lines";

export const LAUNCH_DEFAULT: ServiceLineAvailability = {
  bookable: ["pet_waste", "dog_walking", "pet_sitting", "training"],
  customerRequestable: ["pet_waste", "dog_walking", "pet_sitting", "other"],
};

/** The default with more lines turned on, as a launch would. Bookable only:
 *  a line customers cannot ask for (grooming, training) stays that way. */
export function withBookable(...lines: ServiceLine[]): ServiceLineAvailability {
  return {
    ...LAUNCH_DEFAULT,
    bookable: [...new Set([...LAUNCH_DEFAULT.bookable, ...lines])],
  };
}

/** The default with lines turned off, as a platform admin might. */
export function withoutBookable(...lines: ServiceLine[]): ServiceLineAvailability {
  return {
    ...LAUNCH_DEFAULT,
    bookable: LAUNCH_DEFAULT.bookable.filter((l) => !lines.includes(l)),
  };
}

/** The switch as it was before pet sitting launched (#547): the one line a
 *  customer could ask for but nobody could buy yet. Tests whose subject is
 *  "a Coming soon line a customer may request is still refused" drive it,
 *  because grooming and training are refused by the second switch first.
 *  Training was Coming soon then too (#548 came later). */
export const SITTING_COMING_SOON: ServiceLineAvailability = withoutBookable(
  "pet_sitting",
  "training",
);

/** The switch as it was before training launched (#548): pet waste, walking
 *  and sitting bookable, training and grooming Coming soon. Tests whose
 *  subject is "training is still Coming soon" drive it. */
export const TRAINING_COMING_SOON: ServiceLineAvailability = withoutBookable("training");
