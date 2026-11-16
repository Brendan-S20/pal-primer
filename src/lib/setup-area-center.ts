// Where Setup step 2's radius area is centred (#946).
//
// The step used to ask for a ZIP only when the business had no pin, and said
// "Centered on your business address" otherwise. An owner whose address was
// pinned had no field to put a ZIP in at all, so the QA tester typed it into
// the area's NAME ("ZIP 48933") and the circle stayed wherever the pin was.
//
// The step now always shows the centre's ZIP, prefilled from the business
// address when that address ends in one. Left as it was, the area centres on
// the business's own pin (more exact than a ZIP's middle); changed, it
// centres on the ZIP typed. Either way createZone is asked to fill the ZIPs
// the circle holds (#858), so the signup page and lead form can quote it.

/** A US ZIP's first five digits, or "" for anything else. */
export function zip5(raw: string | null | undefined): string {
  const m = /^\s*(\d{5})(?:-?\d{4})?\s*$/.exec(raw ?? "");
  return m ? m[1] : "";
}

/**
 * The ZIP at the end of a one-line US address ("1 Main St, Lansing, MI
 * 48933"), or "" when it does not end in one. The LAST five-digit group is
 * taken, so a house number such as "12345 Grand River Ave" is not mistaken
 * for it.
 */
export function zipFromAddress(address: string | null | undefined): string {
  const a = (address ?? "").trim().replace(/[,\s]*(USA|US|United States)\.?$/i, "");
  const m = /\b(\d{5})(?:-\d{4})?\s*$/.exec(a);
  return m ? m[1] : "";
}

export type SetupAreaPin = { lat: number; lng: number };

/**
 * The ZIP field's value: what the owner typed once they have touched it,
 * otherwise the business address's ZIP. A cleared field stays cleared.
 */
export function setupAreaZipValue(opts: {
  typed: string;
  edited: boolean;
  businessAddress: string | null | undefined;
}): string {
  return opts.edited ? opts.typed : zipFromAddress(opts.businessAddress);
}

/** Why Save cannot centre the area, or null when it can. */
export function setupAreaCenterProblem(opts: {
  zip: string;
  pin: SetupAreaPin | null;
}): string | null {
  if (zip5(opts.zip)) return null;
  // An empty field on a pinned business still has somewhere to go: the pin.
  if (!opts.zip.trim() && opts.pin) return null;
  return "Enter the ZIP code at the middle of the area you serve.";
}

/**
 * The circle's centre. The business's pin when the ZIP is the business's own
 * (or empty), otherwise the typed ZIP's middle, from `geocode`.
 */
export async function setupAreaCenter(opts: {
  zip: string;
  businessAddress: string | null | undefined;
  pin: SetupAreaPin | null;
  geocode: (zip: string) => Promise<SetupAreaPin | null>;
}): Promise<SetupAreaPin> {
  const typed = zip5(opts.zip);
  const own = zipFromAddress(opts.businessAddress);
  if (opts.pin && (!typed || typed === own)) return opts.pin;
  if (!typed) throw new Error("Enter the ZIP code at the middle of the area you serve.");
  const point = await opts.geocode(typed);
  if (!point) throw new Error("We could not find that ZIP code. Check it and try again.");
  return point;
}
