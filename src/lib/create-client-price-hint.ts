// The sentence under "Create client" about the price (#946).
//
// "Set a price per visit first." used to show whenever there was no price,
// which included the second or so the zone quote is still on its way: a new
// owner coming from Setup step 2 saw it flash, then saw their $20 arrive. A
// price that is still loading is not a missing price. It is said as loading,
// and the button stays disabled until it lands either way.

export type CreateClientPriceHint = "loading" | "set-price" | null;

export function createClientPriceHint(opts: {
  /** No price yet, typed or quoted, on a plan that needs one. */
  needsPrice: boolean;
  /** The zone quote (or the service price) has been asked for and not answered. */
  priceLoading: boolean;
}): CreateClientPriceHint {
  if (!opts.needsPrice) return null;
  return opts.priceLoading ? "loading" : "set-price";
}

export const CREATE_CLIENT_PRICE_HINT_COPY: Record<Exclude<CreateClientPriceHint, null>, string> = {
  loading: "Loading the price…",
  "set-price": "Set a price per visit first.",
};
