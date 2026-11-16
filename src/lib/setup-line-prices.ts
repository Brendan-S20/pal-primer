// ── SITTING, GROOMING AND TRAINING, PRICED IN SETUP (#959) ──────────────────
//
// #769 moved the walks off a Settings button and onto /setup. Sitting,
// grooming and training were still that button ("Review sitting prices",
// "Review grooming setup", "Price lessons"), so a sitter who never followed it
// quoted the seeded $25 / $75 / $100 starters, and a trainer who never priced
// the package could not sell a lesson. They are asked on /setup now, the same
// way, and this file is the one copy of what each line needs before its part
// of the price step is done, read by the server's done test, the forms and
// the tests.
//
// Pure: no database, no React. Office-only (owner, office manager), so English.

import { walkPriceCents } from "@/lib/setup-walk-prices";
import { PET_SIZES, type PetSize } from "@/lib/groom";

/** "25", "25.50", "$25" → cents; blank → null; nonsense or ≤ 0 → NaN. The
 *  walk form's parser, so every price on /setup reads a typed number alike. */
export const setupPriceCents = walkPriceCents;

// ── Sitting ────────────────────────────────────────────────────────────────

export type SetupStay = {
  id: string;
  name: string;
  price_unit: string;
  base_price_cents: number | null;
  created_at: string;
  updated_at: string;
};

/** Signup seeds Drop-in, Overnight stay and House sit WITH starter prices
 *  ($25 / $75 / $100, migration 20261024081200), so "has a price" is true of
 *  a stay nobody looked at. Done is "saved on purpose": every active stay has
 *  a price AND has been written since it was created (services_touch_updated_at
 *  moves updated_at on every UPDATE). One saved stay used to tick the part
 *  while the other two still quoted the starter. */
export function staysSavedForSetup(
  stays: readonly Pick<SetupStay, "base_price_cents" | "created_at" | "updated_at">[],
): boolean {
  if (stays.length === 0) return false;
  return stays.every((s) => (s.base_price_cents ?? 0) > 0 && s.updated_at !== s.created_at);
}

/** What a stay's price is per, in the field's label. */
export function stayUnitLabel(unit: string): string {
  if (unit === "night") return "per night";
  if (unit === "hour") return "per hour";
  return "per visit";
}

/** The stay form's refusal, or null. Every stay needs a price: the part is
 *  done only when all of them are saved, so a blank one is refused here
 *  rather than saved and left open. */
export function setupStayPricesProblem(
  fields: readonly { name: string; cents: number | null }[],
): string | null {
  if (fields.length === 0) return "There are no stays to price yet.";
  for (const f of fields) {
    if (f.cents !== null && Number.isNaN(f.cents)) return `Enter a price for ${f.name}, like 25.`;
    if (f.cents === null) return `Enter a price for ${f.name}.`;
  }
  return null;
}

/** The server's refusal when a save leaves a stay out. */
export const STAYS_MISSING = "Every stay needs a price before setup can save them.";

/** Whether a save names every active stay, each once (setSetupStayPrices). */
export function coversEveryStay(activeIds: readonly string[], sentIds: readonly string[]): boolean {
  const sent = new Set(sentIds);
  return (
    sent.size === sentIds.length &&
    activeIds.length === sent.size &&
    activeIds.every((id) => sent.has(id))
  );
}

// ── Grooming ───────────────────────────────────────────────────────────────

/** Done when the size grid has a price for at least one size AND the
 *  vaccines and setup/cleanup/travel minutes have been reviewed (saved with
 *  setupReviewed, which stamps organizations.groom_setup_reviewed_at). The
 *  review alone used to be enough, so a groomer could finish with an empty
 *  grid and every groom quoted at the service's one flat price. */
export function groomSetupDone(a: { reviewed: boolean; pricedSizes: number }): boolean {
  return a.reviewed && a.pricedSizes > 0;
}

export type SetupSizeRow = { size: PetSize; price: string; minutes: string };

/** The size rows the form sends: only the ones with a price typed. A size
 *  left blank keeps the service's own price, as in Settings. */
export function setupSizeRules(
  rows: readonly SetupSizeRow[],
): { size: PetSize; priceCents: number; durationMin: number }[] {
  return rows.flatMap((r) => {
    const cents = setupPriceCents(r.price);
    if (cents === null || Number.isNaN(cents)) return [];
    return [{ size: r.size, priceCents: cents, durationMin: parseInt(r.minutes, 10) }];
  });
}

/** The grooming form's refusal, or null. At least one size needs a price;
 *  a price needs its minutes; the buffer is whole minutes from 0 to 240. */
export function setupGroomProblem(a: {
  rows: readonly SetupSizeRow[];
  bufferMin: string;
  sizeLabel: (s: PetSize) => string;
}): string | null {
  for (const r of a.rows) {
    const cents = setupPriceCents(r.price);
    if (cents !== null && Number.isNaN(cents))
      return `Enter a price for ${a.sizeLabel(r.size)}, like 45.`;
    if (cents === null) continue;
    const m = Number(r.minutes);
    if (!/^\d+$/.test(r.minutes.trim()) || m < 1 || m > 720)
      return `Enter how many minutes a ${a.sizeLabel(r.size).toLowerCase()} groom takes.`;
  }
  if (!a.rows.some((r) => setupPriceCents(r.price) !== null))
    return "Enter a price for at least one size.";
  const b = Number(a.bufferMin);
  if (!/^\d+$/.test(a.bufferMin.trim()) || b > 240)
    return "Enter setup, cleanup and travel minutes from 0 to 240.";
  return null;
}

/** The grid in the order the form draws it. */
export const SETUP_SIZES: readonly PetSize[] = PET_SIZES;

// ── Training ───────────────────────────────────────────────────────────────

/** The training form's refusal, or null. The part is done when a package is
 *  active with a price and an active skill exists (onboarding.functions), so
 *  the form asks for both: a price, a session count, and a skill unless the
 *  business already has one. */
export function setupTrainingProblem(a: {
  priceCents: number | null;
  sessions: string;
  hasSkill: boolean;
  newSkill: string;
}): string | null {
  if (a.priceCents === null) return "Enter what the lesson package costs.";
  if (Number.isNaN(a.priceCents)) return "Enter a price for the package, like 300.";
  const n = Number(a.sessions);
  if (!/^\d+$/.test(a.sessions.trim()) || n < 1 || n > 100)
    return "Enter how many lessons the package holds, from 1 to 100.";
  if (!a.hasSkill && !a.newSkill.trim()) return "Add one skill a trainer scores, like Sit.";
  if (a.newSkill.trim().length > 80) return "Keep a skill name under 80 characters.";
  return null;
}
