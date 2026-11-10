// A price a person typed into a "$ [ ]" box, in cents, or null for no price.
//
// The box draws its own "$" outside the input, but people type one anyway --
// the onboarding QA run that found #784 wrote its price as "$20". parseFloat
// reads "$20" as NaN, so the plan had no price and Create client stayed
// greyed out with nobody saying the "$" was why. A thousands comma ("1,200")
// read as 1. Both are a price; anything else that is not a positive number
// is still no price.
export function typedPriceCents(input: string): number | null {
  const cleaned = input
    .trim()
    .replace(/^\$\s*/, "")
    .replace(/,/g, "");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
