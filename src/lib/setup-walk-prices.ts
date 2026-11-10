// ── WALK PRICES, ASKED IN SETUP (#769) ──────────────────────────────────────
//
// Signup seeds a walking business with a 30-minute walk, a 60-minute walk and
// a 20-minute drop-in, all with blank prices (DEFAULT_SERVICE_SEEDS). Setup's
// price step used to be a link to Settings, Services, and "done" was "some
// walk has a price", so one price on one walk ticked it and the rest stayed
// "No price yet" on the new-client Plan step.
//
// Now /setup asks for them inline, and the step is done when the 30-minute
// AND the 60-minute walk have a price. The drop-in is optional, and says so:
// a walker who does not sell drop-ins leaves it blank and it is never quoted.
//
// Pure, so the server's done test, the form on /setup and the tests read one
// copy of which walks are required.

/** The walk lengths setup will not finish without a price for. */
export const REQUIRED_WALK_MINUTES = [30, 60] as const;

export type SetupWalk = {
  id: string;
  name: string;
  default_duration_min: number | null;
  base_price_cents: number | null;
};

/** Whether a walk is one of the required lengths. Read from its length, not
 *  its name: an owner may rename "30-minute walk" to "Half-hour stroll". */
export function isRequiredWalk(w: Pick<SetupWalk, "default_duration_min">): boolean {
  return (REQUIRED_WALK_MINUTES as readonly number[]).includes(w.default_duration_min ?? -1);
}

const priced = (w: Pick<SetupWalk, "base_price_cents">) => (w.base_price_cents ?? 0) > 0;

/** The walking part of the price step is done when every required length the
 *  business still sells has a priced walk, and at least one walk is priced.
 *
 *  A length the business no longer sells (the 60-minute walk deactivated) is
 *  not demanded: setup asks for prices, not for a catalogue the owner already
 *  changed. A business with no walk of either length is done when any walk
 *  has a price, which is what the old test asked of everybody. */
export function walksPricedForSetup(
  walks: readonly Pick<SetupWalk, "default_duration_min" | "base_price_cents">[],
): boolean {
  if (!walks.some(priced)) return false;
  return REQUIRED_WALK_MINUTES.every((min) => {
    const ofLength = walks.filter((w) => w.default_duration_min === min);
    return ofLength.length === 0 || ofLength.some(priced);
  });
}

/** The walks /setup draws a price field for: the required lengths first, then
 *  every other active walk (the drop-in), each marked required or optional. */
export function setupWalkFields<T extends SetupWalk>(
  walks: readonly T[],
): { walk: T; required: boolean }[] {
  const order = (w: T) => {
    const i = (REQUIRED_WALK_MINUTES as readonly number[]).indexOf(w.default_duration_min ?? -1);
    return i === -1 ? REQUIRED_WALK_MINUTES.length : i;
  };
  return [...walks]
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((walk) => ({ walk, required: isRequiredWalk(walk) }));
}

/** "25", "25.50", "$25" → cents. Blank → null. Anything else, or zero or less,
 *  → NaN, which the form refuses with a sentence. */
export function walkPriceCents(input: string): number | null {
  const t = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN;
  const cents = Math.round(parseFloat(t) * 100);
  return cents > 0 ? cents : Number.NaN;
}

/** What the form refuses, or null when it can be saved. Every required walk
 *  needs a price; an optional one may be blank but not nonsense. */
export function setupWalkPricesProblem(
  fields: readonly { name: string; required: boolean; cents: number | null }[],
): string | null {
  for (const f of fields) {
    if (f.cents !== null && Number.isNaN(f.cents)) return `Enter a price for ${f.name}, like 25.`;
    if (f.required && f.cents === null) return `Enter what a ${f.name} costs.`;
  }
  return null;
}
