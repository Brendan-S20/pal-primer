// Yard size is derived from the sketched boundary area, never hand-picked.
// Mirrors the DB trigger tg_properties_derive_yard_size exactly; keep the
// two in sync if thresholds ever change.

import { SQFT_PER_SQM } from "@/lib/estimated-time";

export type YardSizeCategory = "small" | "medium" | "large" | "xlarge";

export const YARD_SIZE_LABELS: Record<YardSizeCategory, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "Extra large",
};

/** Thresholds in square feet: <5k small, <10k medium, <half acre large. */
export function deriveYardSize(areaSqm: number | null | undefined): YardSizeCategory | null {
  if (areaSqm == null || !Number.isFinite(areaSqm) || areaSqm <= 0) return null;
  const sqft = areaSqm * SQFT_PER_SQM;
  if (sqft < 5000) return "small";
  if (sqft < 10000) return "medium";
  if (sqft < 21780) return "large";
  return "xlarge";
}
