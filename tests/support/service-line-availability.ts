// The platform switch (#531) as a test holds it.
//
// The real answer is public.platform_service_lines, read at runtime. A test
// that drives the rules without a database passes one of these instead.
// LAUNCH_DEFAULT is the migration's seed (20261025200000), and
// tests/a-service-line-is-turned-on-only-when-bookable.test.ts fails if the
// two ever differ.

import type { ServiceLine, ServiceLineAvailability } from "@/lib/service-lines";

export const LAUNCH_DEFAULT: ServiceLineAvailability = {
  bookable: ["pet_waste", "dog_walking"],
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
