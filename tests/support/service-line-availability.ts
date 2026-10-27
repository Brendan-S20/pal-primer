// The platform switch (#531) as a test holds it.
//
// The real answer is public.platform_service_lines, read at runtime. A test
// that drives the rules without a database passes one of these instead.
// LAUNCH_DEFAULT is the switch as a replay of the migrations leaves it: the
// seed (20261025200000) plus each later flip (20261026200000, pet sitting;
// 20261027120000, training; 20261027180000, mobile grooming).
// tests/a-service-line-is-turned-on-only-when-bookable.test.ts fails if the
// two ever differ.

import type { ServiceLine, ServiceLineAvailability } from "@/lib/service-lines";

export const LAUNCH_DEFAULT: ServiceLineAvailability = {
  bookable: ["pet_waste", "dog_walking", "pet_sitting", "training", "mobile_grooming"],
  customerRequestable: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "other"],
};

/** The default with more lines turned on, as a launch would. Bookable only:
 *  a line customers cannot ask for (training) stays that way. */
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
 *  Training and grooming were Coming soon then too (#548, #549 came later). */
export const SITTING_COMING_SOON: ServiceLineAvailability = {
  bookable: LAUNCH_DEFAULT.bookable.filter(
    (l) => l !== "pet_sitting" && l !== "training" && l !== "mobile_grooming",
  ),
  customerRequestable: LAUNCH_DEFAULT.customerRequestable.filter((l) => l !== "mobile_grooming"),
};

/** The switch as it was before grooming launched (#549): pet waste, walking,
 *  sitting and training bookable, grooming Coming soon and kept from
 *  customers, as the seed wrote it. Tests whose subject is "grooming is still
 *  Coming soon" or "a groom request is refused while customers cannot ask for
 *  one" drive it. */
export const GROOMING_COMING_SOON: ServiceLineAvailability = {
  bookable: LAUNCH_DEFAULT.bookable.filter((l) => l !== "mobile_grooming"),
  customerRequestable: LAUNCH_DEFAULT.customerRequestable.filter((l) => l !== "mobile_grooming"),
};

/** The switch as it was before training launched (#548): pet waste, walking
 *  and sitting bookable, training and grooming Coming soon. Tests whose
 *  subject is "training is still Coming soon" drive it. */
export const TRAINING_COMING_SOON: ServiceLineAvailability = {
  bookable: GROOMING_COMING_SOON.bookable.filter((l) => l !== "training"),
  customerRequestable: GROOMING_COMING_SOON.customerRequestable,
};
