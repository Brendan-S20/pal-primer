// What a picked address suggestion is allowed to do to a form (#783).
//
// The rule is all or nothing. A form holds an address as parts — street,
// unit, city, state, ZIP, and a pin — and there are exactly two honest ways
// for those parts to end up saved:
//
//   1. the person typed them, and they are saved as typed, or
//   2. the person picked a suggestion, and EVERY part comes from that pick.
//
// What onboarding QA found on 2026-11-09 was a third: `200 Test Ave,
// Lansing, MI 48933` saved as `200 Test Road, Richmond 48933` — a far-away
// suggestion's street and city sitting on the typed ZIP. Each route to a
// mix is closed here, in one place, so the new-client wizard, the property
// drawer and every other address form get the same answer:
//
//   - a pick that cannot supply every part (no city, no state, no ZIP) is
//     not applied at all, rather than applied where it can be and left to
//     the typed value where it cannot;
//   - a pick whose details fail keeps the typed text exactly — it used to
//     write the suggestion's street line over it and leave the rest typed;
//   - a pick that resolves after the person has kept typing is stale, and
//     the newer typing wins;
//   - an applied pick sets every part, empties included: `region ?? ""`,
//     never `if (region) setRegion(region)`, which kept a typed state under
//     a suggestion's city.
//
// Pure, so it is tested directly: vitest runs in node here, with no jsdom.
import type { AddressDetails } from "@/lib/address/provider.server";

/** Every part of an address a form stores, as the form stores it. */
export interface AddressParts {
  street: string;
  unit: string;
  city: string;
  region: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
}

/** Can this resolved suggestion stand in for EVERY part of a typed address?
 *  A pick missing any of them would have to borrow that part from what was
 *  typed, which is the mix this file exists to prevent. */
export function isCompletePick(d: AddressDetails | null | undefined): d is AddressDetails {
  if (!d) return false;
  return Boolean(d.street?.trim() && d.city?.trim() && d.region?.trim() && d.postalCode?.trim());
}

/** All of the parts from a pick. Nothing is conditional: a part the pick
 *  does not carry (a unit, a pin) is cleared, not left as it was. */
export function partsFromPick(d: AddressDetails): AddressParts {
  const coords =
    d.latitude != null && d.longitude != null
      ? { latitude: d.latitude, longitude: d.longitude }
      : { latitude: null, longitude: null };
  return {
    street: d.street.trim(),
    unit: (d.unit ?? "").trim(),
    city: d.city.trim(),
    region: (d.region ?? "").trim(),
    postalCode: d.postalCode.trim(),
    ...coords,
  };
}

export type PickOutcome =
  | { kind: "replace"; parts: AddressParts }
  | { kind: "keep-typed"; reason: "failed" | "incomplete" | "typed-since" };

/** Decide what a resolved pick does to the form.
 *
 *  `textAtPick` is what the field held when the suggestion was chosen and
 *  `textNow` what it holds when the details come back. If they differ the
 *  person kept typing while the request was in flight, and what they typed
 *  is newer than the pick. */
export function pickOutcome(args: {
  details: AddressDetails | null | undefined;
  textAtPick: string;
  textNow: string;
}): PickOutcome {
  if (args.textNow !== args.textAtPick) return { kind: "keep-typed", reason: "typed-since" };
  if (!args.details) return { kind: "keep-typed", reason: "failed" };
  if (!isCompletePick(args.details)) return { kind: "keep-typed", reason: "incomplete" };
  return { kind: "replace", parts: partsFromPick(args.details) };
}

/** Does Enter pick the highlighted row? Only when the person moved the
 *  highlight with the arrow keys. A row lit by a mouse pointer that happens
 *  to rest where the list opened is not a choice anybody made, and Enter on
 *  an address field is usually "next" — it was a silent swap of a typed
 *  address for a suggestion. */
export function enterPicks(s: { active: number; activeByKeyboard: boolean }): boolean {
  return s.active >= 0 && s.activeByKeyboard;
}

/** The query the server accepts (`z.string().min(3).max(200)`). The setup
 *  box allows 300 characters, and a longer value used to be rejected by the
 *  validator, caught, and shown as "no suggestions". */
export const MAX_QUERY_CHARS = 200;
export function searchQuery(text: string): string {
  return text.trim().slice(0, MAX_QUERY_CHARS).trim();
}
