/** First-cleanup pricing: what a new customer pays for the first visit to a
 *  yard, set by each business for itself.
 *
 *  The owner's decision was "build it out, but leave it up to the company on
 *  how it should be priced", so there are three answers and the owner picks:
 *
 *    off              no first-cleanup charge.
 *    flat             each zone's own "Initial cleanup fee"
 *                     (`zones.initial_cleanup_cents`). Per zone, because that
 *                     is what the field already was.
 *    by_last_cleaned  the owner's tiers, answering "when was the yard last
 *                     cleaned?", organization-wide.
 *
 *  plus an optional add-on per dog beyond the first, in both priced modes.
 *
 *  Stored as `organizations.first_cleanup_pricing` and validated there by
 *  `first_cleanup_pricing_is_valid` (migration 20260929120000). The price is
 *  computed twice, deliberately and for different jobs:
 *
 *    `public.first_cleanup_price_cents`  the public signup's charge. The
 *        browser sends a tier id; the database prices it; the card is charged
 *        what the database said. Nothing the customer's browser sends is a
 *        price.
 *    `firstCleanupPriceCents` below     the office screens' PREFILL — the
 *        new-client wizard and the quote helper — where a person can see the
 *        number and change it before anything is billed.
 *
 *  Two copies of a rule is how this repo keeps finding drift, so the pair is
 *  pinned: tests/the-first-cleanup-is-priced-by-the-server-from-a-tier-id.test.ts
 *  runs the same cases through both. */

export type FirstCleanupMode = "off" | "flat" | "by_last_cleaned";

export type FirstCleanupTier = { id: string; label: string; priceCents: number };

export type FirstCleanupPricing = {
  mode: FirstCleanupMode;
  tiers: FirstCleanupTier[];
  perExtraDogCents: number;
};

export const MAX_TIERS = 8;
export const MAX_TIER_LABEL = 80;
export const MAX_TIER_PRICE_CENTS = 1_000_000;
export const MAX_EXTRA_DOG_CENTS = 100_000;
export const TIER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const FIRST_CLEANUP_OFF: FirstCleanupPricing = {
  mode: "off",
  tiers: [],
  perExtraDogCents: 0,
};

/** The four answers Sweep&Go's signup offers, as a starting point the owner
 *  edits. No prices: what a first cleanup costs is the owner's call, and a
 *  suggested number would be the one that ships unread. */
export const SUGGESTED_TIER_LABELS: readonly { id: string; label: string }[] = [
  { id: "within_a_week", label: "Within a week" },
  { id: "one_to_four_weeks", label: "1–4 weeks" },
  { id: "one_to_three_months", label: "1–3 months" },
  { id: "three_months_or_never", label: "3+ months or never" },
];

export const FIRST_CLEANUP_MODE_LABEL: Record<FirstCleanupMode, string> = {
  off: "Off",
  flat: "Flat price",
  by_last_cleaned: "By time since last cleaned",
};

/** The question the customer and the office are asked. One wording. */
export const LAST_CLEANED_QUESTION = "When was your yard last cleaned?";

/** A fresh tier id: never derived from the label, so renaming a tier does not
 *  orphan a signup that answered it. */
export function newTierId(): string {
  const r =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `t${r}`.toLowerCase();
}

const isWholeCents = (n: unknown, max: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;

/** The config out of whatever the org row holds, in the app's shape. Anything
 *  unreadable reads as off: a price nobody can explain is worse than none. */
export function parseFirstCleanupPricing(raw: unknown): FirstCleanupPricing {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return FIRST_CLEANUP_OFF;
  const r = raw as Record<string, unknown>;
  const mode: FirstCleanupMode =
    r.mode === "flat" || r.mode === "by_last_cleaned" ? r.mode : "off";
  const seen = new Set<string>();
  const tiers: FirstCleanupTier[] = [];
  for (const t of Array.isArray(r.tiers) ? r.tiers : []) {
    if (!t || typeof t !== "object") continue;
    const { id, label, price_cents } = t as Record<string, unknown>;
    if (typeof id !== "string" || !TIER_ID_PATTERN.test(id) || seen.has(id)) continue;
    if (typeof label !== "string" || !label.trim()) continue;
    if (!isWholeCents(price_cents, MAX_TIER_PRICE_CENTS)) continue;
    seen.add(id);
    tiers.push({ id, label: label.trim(), priceCents: price_cents });
  }
  const perExtraDogCents = isWholeCents(r.per_extra_dog_cents, MAX_EXTRA_DOG_CENTS)
    ? r.per_extra_dog_cents
    : 0;
  if (mode === "by_last_cleaned" && tiers.length === 0) return { ...FIRST_CLEANUP_OFF };
  return { mode, tiers: tiers.slice(0, MAX_TIERS), perExtraDogCents };
}

/** The config as the database stores it (snake_case, the CHECK's shape). */
export function toStoredFirstCleanupPricing(p: FirstCleanupPricing): Record<string, unknown> {
  const out: Record<string, unknown> = { mode: p.mode };
  if (p.tiers.length) {
    out.tiers = p.tiers.map((t) => ({ id: t.id, label: t.label.trim(), price_cents: t.priceCents }));
  }
  if (p.perExtraDogCents > 0) out.per_extra_dog_cents = p.perExtraDogCents;
  return out;
}

/** Why the owner's draft cannot be saved, or null when it can. The same rules
 *  as `first_cleanup_pricing_is_valid`, in words. */
export function firstCleanupPricingProblem(p: FirstCleanupPricing): string | null {
  if (p.mode === "by_last_cleaned" && p.tiers.length === 0) {
    return "Add at least one answer to price by, or pick another option.";
  }
  if (p.tiers.length > MAX_TIERS) return `Up to ${MAX_TIERS} answers.`;
  const ids = new Set<string>();
  for (const t of p.tiers) {
    if (!t.label.trim()) return "Every answer needs a label.";
    if (t.label.trim().length > MAX_TIER_LABEL) {
      return `Keep each answer under ${MAX_TIER_LABEL} characters.`;
    }
    if (!isWholeCents(t.priceCents, MAX_TIER_PRICE_CENTS)) {
      return `Give "${t.label.trim()}" a price between $0 and $${(MAX_TIER_PRICE_CENTS / 100).toLocaleString("en-US")}.`;
    }
    if (!TIER_ID_PATTERN.test(t.id) || ids.has(t.id)) return "Two answers share an id.";
    ids.add(t.id);
  }
  if (!isWholeCents(p.perExtraDogCents, MAX_EXTRA_DOG_CENTS)) {
    return `The extra-dog add-on has to be between $0 and $${MAX_EXTRA_DOG_CENTS / 100}.`;
  }
  return null;
}

/**
 * The first-cleanup price, in cents. Mirrors `public.first_cleanup_price_cents`
 * exactly — see the header for why there are two and what keeps them equal.
 *
 * Null means "cannot price this": tiered pricing with no tier picked, or a
 * tier the owner no longer has. Zero means free.
 */
export function firstCleanupPriceCents(
  p: FirstCleanupPricing,
  input: { zoneFlatCents: number | null | undefined; dogCount: number; tierId: string | null },
): number | null {
  let base: number;
  if (p.mode === "flat") {
    base = Math.max(0, input.zoneFlatCents ?? 0);
  } else if (p.mode === "by_last_cleaned") {
    if (input.tierId == null) return null;
    const tier = p.tiers.find((t) => t.id === input.tierId);
    if (!tier) return null;
    base = tier.priceCents;
  } else {
    return 0;
  }
  // A first cleanup priced at nothing is free, not "free plus the dogs".
  if (base <= 0) return 0;
  return base + Math.max((input.dogCount || 1) - 1, 0) * Math.max(0, p.perExtraDogCents);
}

/** Each tier priced for one yard: what the signup and the wizard list. */
export function firstCleanupOptions(
  p: FirstCleanupPricing,
  input: { zoneFlatCents: number | null | undefined; dogCount: number },
): Array<{ id: string; label: string; priceCents: number }> {
  if (p.mode !== "by_last_cleaned") return [];
  return p.tiers.map((t) => ({
    id: t.id,
    label: t.label,
    priceCents: firstCleanupPriceCents(p, { ...input, tierId: t.id }) ?? 0,
  }));
}

/** What an invoice or quote line calls it. The tier label is the owner's own
 *  words, quoted as the customer answered them. */
export function firstCleanupDescription(tierLabel: string | null | undefined, dogCount = 1): string {
  const label = tierLabel?.trim();
  const dogs = dogCount > 1 ? `, ${dogCount} dogs` : "";
  return label ? `First cleanup (last cleaned: ${label}${dogs})` : `First cleanup${dogs ? ` (${dogCount} dogs)` : ""}`;
}

/**
 * The quote editor's "Add first cleanup" line: one one-time line, quantity 1,
 * priced from the owner's settings. Null when there is nothing to price —
 * pricing is off, or tiered and no tier was picked.
 */
export function firstCleanupQuoteLine(
  p: FirstCleanupPricing,
  input: { tierId: string | null; zoneFlatCents?: number | null; dogCount: number },
): { description: string; quantity: string; price: string; recurring: false } | null {
  if (p.mode === "off") return null;
  const cents = firstCleanupPriceCents(p, {
    zoneFlatCents: input.zoneFlatCents ?? 0,
    dogCount: input.dogCount,
    tierId: input.tierId,
  });
  if (cents == null) return null;
  const tier = p.mode === "by_last_cleaned" ? p.tiers.find((t) => t.id === input.tierId) : null;
  return {
    description: firstCleanupDescription(tier?.label ?? null, input.dogCount),
    quantity: "1",
    price: (cents / 100).toFixed(2),
    recurring: false,
  };
}
