// The service area a walker, sitter, groomer or trainer sets in setup (#958).
//
// public_quote answers only for a ZIP some zone lists, and says nothing at
// all for one no zone does. The public booking link, the receptionist and
// the directory's Book online all read that silence as "out of area". Setup
// asked for an area only at a pet-waste business, so a walker could finish
// setup, price every walk, share the link and be out of area to everybody.
//
// The zone this writes carries NO price: a walk, a stay, a groom and a lesson
// are priced by their own service, and a zone with no price charges the
// standard price (#860) if the business ever adds pet waste. It is drawn as
// a circle like the pet-waste form's, and createZone lists the ZIPs inside it
// (#858), which is what public_quote matches on.

import type { SetupAreaPin } from "@/lib/setup-area-center";

/** How far you drive, in miles: the same choices as the pet-waste form. */
export const SETUP_AREA_MILES = [5, 10, 15, 25, 40] as const;

export const SETUP_AREA_DEFAULT_NAME = "Main service area";

/** What createZone is sent for a service area with no price of its own. */
export function setupServiceAreaZone(opts: { name: string; center: SetupAreaPin; miles: number }) {
  return {
    name: opts.name.trim() || SETUP_AREA_DEFAULT_NAME,
    geoMatchMode: "radius" as const,
    fillZipsFromShape: true,
    centerLatitude: opts.center.lat,
    centerLongitude: opts.center.lng,
    radiusMeters: Math.round(opts.miles * 1609.344),
  };
}
