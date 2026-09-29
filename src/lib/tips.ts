// A tip on an invoice payment: the arithmetic, the one input shape the server
// accepts, and how it travels through Stripe.
//
// Pure, and imported by both halves. The pay screen uses it to DRAW the
// choices ("15%  $9.00"); the server uses it to DECIDE the charge. The page's
// figure is a preview and nothing more: the server recomputes the tip from the
// customer's CHOICE -- a percent from a fixed list, or a custom amount inside a
// cap -- against the amount it reads from the invoice itself. It never accepts
// a total, a tip in cents for a percent, or a percent it did not offer.
//
// ── WHAT A TIP IS, IN THE LEDGER ──────────────────────────────────────────
//
// Not invoice money. `payments.amount_cents` means money applied to the
// invoice on every row ever written, and the tip sits beside it in
// `payments.tip_cents` exactly as the card surcharge sits in `surcharge_cents`.
// The Stripe charge is amount + surcharge + tip; revenue, AR, franchise
// royalties and the platform fee all read `amount_cents` and never see the tip.
//
// ── WHY THE TIP IS NEVER SURCHARGED ───────────────────────────────────────
//
// A surcharge is quoted on `baseCents: dueCents` -- the invoice -- at every
// site that quotes one (processing-fee.server.ts). Tips are offered only on
// the two customer-present screens, and those do not surcharge at all: the
// payer picks card or bank inside the Payment Element after the intent's
// amount is fixed. So the charge on a tipped payment is exactly due + tip,
// surcharge 0, and if the two-step surcharge is ever built its base must stay
// `dueCents`, not the tipped total. Surcharging a gratuity would recover a
// processing fee on money the business was given rather than earned, and the
// card-network 3% cap is framed on the transaction for goods and services.
// The platform fee follows the same rule: `platformFeeCents(dueCents)`.
//
// ── WHY PERCENT OF THE AMOUNT DUE ─────────────────────────────────────────
//
// "15%" is taken of what the customer is paying for the invoice today: the
// total net of any account credit already applied, the number on the pay
// button before a tip. It is the smaller of the two candidates (the gross
// total is the other), which is the conservative choice when the question is
// how much of a stranger's money to suggest, and it is the figure printed
// right beside the choices, so the arithmetic is checkable on the screen.

import { preTaxShareCents } from "@/lib/sales-tax";
import { z } from "zod";

export const TIP_PERCENTS = [10, 15, 20] as const;
export type TipPercent = (typeof TIP_PERCENTS)[number];

/** The absolute ceiling on a custom tip: $1,000. */
export const TIP_CUSTOM_MAX_CENTS = 100_000;

/** The floor under the relative cap, so a $12 invoice can still carry a $20
 *  tip for a job somebody was grateful for. */
export const TIP_CUSTOM_FLOOR_CAP_CENTS = 5_000;

export type TipChoice =
  { kind: "none" } | { kind: "percent"; percent: TipPercent } | { kind: "custom"; cents: number };

export const NO_TIP: TipChoice = { kind: "none" };

/**
 * The input shape the pay screens send. Everything the server will look at,
 * and nothing it will not: a percent outside the list, a fractional or
 * negative amount, or an amount above the absolute ceiling fails parsing. Any
 * other key the browser adds -- `amountCents`, `totalCents`, `tipCents` on a
 * percent choice -- is stripped by zod and never read.
 */
export const tipChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("percent"),
    percent: z.union([z.literal(10), z.literal(15), z.literal(20)]),
  }),
  z.object({
    kind: z.literal("custom"),
    cents: z.number().int().min(1).max(TIP_CUSTOM_MAX_CENTS),
  }),
]);

/** A refusal the payer should read as-is. */
export class TipRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TipRefused";
  }
}

/**
 * The most a custom tip may be on an invoice of `dueCents`: the invoice
 * amount, or $50 when that is more, and never above $1,000. A tip larger than
 * the bill is almost always a slipped decimal ($150 for $15.0), and a cap that
 * refuses it is a question the payer can answer, where a charge is not.
 */
export function customTipCapCents(dueCents: number): number {
  const due = Math.max(0, Math.floor(Number.isFinite(dueCents) ? dueCents : 0));
  return Math.min(TIP_CUSTOM_MAX_CENTS, Math.max(due, TIP_CUSTOM_FLOOR_CAP_CENTS));
}

/** `percent`% of `dueCents`, to the nearest cent. */
export function percentTipCents(dueCents: number, percent: number): number {
  const due = Math.max(0, Math.floor(Number.isFinite(dueCents) ? dueCents : 0));
  return Math.round((due * percent) / 100);
}

/**
 * The tip, in cents, for a choice on an invoice of `dueCents`. Throws
 * `TipRefused` for anything the pay screen could not have offered.
 *
 * Re-validates even input that came through `tipChoiceSchema`, because this is
 * the function the charge is built from and it should not depend on its caller
 * having parsed anything.
 */
export function tipCentsFor(choice: TipChoice | null | undefined, dueCents: number): number {
  if (!choice || choice.kind === "none") return 0;
  if (choice.kind === "percent") {
    if (!(TIP_PERCENTS as readonly number[]).includes(choice.percent)) {
      throw new TipRefused("That tip option isn't available.");
    }
    return percentTipCents(dueCents, choice.percent);
  }
  if (choice.kind === "custom") {
    const cents = choice.cents;
    if (!Number.isSafeInteger(cents) || cents < 1) {
      throw new TipRefused("Enter a tip amount, or choose No tip.");
    }
    const cap = customTipCapCents(dueCents);
    if (cents > cap) {
      throw new TipRefused(
        `A tip can be at most $${(cap / 100).toFixed(2)} on this invoice. Please check the amount.`,
      );
    }
    return cents;
  }
  throw new TipRefused("That tip option isn't available.");
}

/**
 * What a customer-present PaymentIntent is built from, given the invoice's
 * amount due and the payer's choice. The ONE place the tipped amount is
 * computed, so the public pay link and the portal cannot disagree.
 *
 * - `amountCents` is what the card is charged: due + tip. No surcharge -- see
 *   the header.
 * - `platformFeeBaseCents` is `dueCents` less its sales-tax share (pro rata by
 *   the invoice's tax / total, `preTaxShareCents`) — exactly `dueCents` for an
 *   invoice with no tax: the application fee is taken on the
 *   invoice, never on the tip.
 * - `metadata.tip_cents` is ALWAYS written, "0" included. Stripe merges
 *   metadata on update, so an intent that once carried a tip and is re-used
 *   without one would otherwise keep the old figure and the webhook would
 *   under-credit the invoice by it.
 */
export function tippedCharge(args: {
  dueCents: number;
  choice: TipChoice | null | undefined;
  tipsEnabled: boolean;
  /** The invoice being paid, for its sales tax. The platform fee is not taken
   *  on tax. Omitted, the fee base is `dueCents`. */
  invoice?: { tax_cents?: number | null; total_cents?: number | null } | null;
}): {
  dueCents: number;
  tipCents: number;
  amountCents: number;
  platformFeeBaseCents: number;
  metadata: { tip_cents: string };
} {
  const due = Math.max(0, Math.floor(Number.isFinite(args.dueCents) ? args.dueCents : 0));
  const wantsTip = !!args.choice && args.choice.kind !== "none";
  if (wantsTip && !args.tipsEnabled) {
    throw new TipRefused("Tips aren't turned on for this business.");
  }
  const tip = args.tipsEnabled ? tipCentsFor(args.choice, due) : 0;
  return {
    dueCents: due,
    tipCents: tip,
    amountCents: due + tip,
    platformFeeBaseCents: preTaxShareCents(due, args.invoice),
    metadata: tipMetadata(tip),
  };
}

/** PaymentIntent metadata carrying the tip to the webhook. */
export function tipMetadata(tipCents: number): { tip_cents: string } {
  const t = Math.max(0, Math.floor(Number.isFinite(tipCents) ? tipCents : 0));
  return { tip_cents: String(t) };
}

/**
 * Read the tip back off a PaymentIntent. 0 for anything missing or malformed,
 * which is right for every charge made before tipping existed: no metadata
 * means the whole charge is invoice money (less any surcharge). Digits only,
 * for the reason `surchargeFromMetadata` gives.
 */
export function tipFromMetadata(metadata: Record<string, string> | null | undefined): number {
  const raw = metadata?.tip_cents;
  if (typeof raw !== "string") return 0;
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

/** The label a choice is drawn with on the pay screen. */
export function tipChoiceLabel(choice: TipChoice): string {
  if (choice.kind === "none") return "No tip";
  if (choice.kind === "percent") return `${choice.percent}%`;
  return "Custom";
}

/** Two choices are the same button. */
export function sameTipChoice(a: TipChoice, b: TipChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "percent" && b.kind === "percent") return a.percent === b.percent;
  if (a.kind === "custom" && b.kind === "custom") return a.cents === b.cents;
  return true;
}

/**
 * Dollars typed into the custom box, to whole cents, or null. Accepts "5",
 * "5.5", "5.50", "$1,005.50"; refuses a third decimal rather than rounding
 * money nobody typed.
 */
export function parseTipDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
