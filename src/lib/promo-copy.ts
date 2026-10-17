type PromoCopy = {
  code: string;
  description?: string | null;
  discount_type: string;
  discount_percent?: number | string | null;
  applies_to: string;
};

/** Hide the stale demo description when it contradicts the computed rule. */
export function promoDescription(promo: PromoCopy): string | null {
  if (
    promo.code === "DEMOSPRING" &&
    promo.discount_type === "percent" &&
    Number(promo.discount_percent) === 15 &&
    promo.applies_to === "first_visit" &&
    ["15% off your next 3 visits", "15% off next 3 visits"].includes(promo.description ?? "")
  ) {
    return null;
  }
  return promo.description ?? null;
}
