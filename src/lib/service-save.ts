/** One press of Save on Settings -> Services, in order (#788).
 *
 *  A pet-waste service's one-time cleanup price is not a column on the
 *  service: it is organizations.one_off_price_cents, written through
 *  setPortalBookingSettings. So a Save is two writes, and the second can fail
 *  after the first succeeded (a dropped connection, an expired session, a
 *  permission taken away mid-edit).
 *
 *  The review on #812 found what that used to cost: the service was created,
 *  the price write threw, the form still had no id, and pressing Save again
 *  created a SECOND service. This function never throws after the service is
 *  saved. It returns the saved id and the price's error, and the page keeps
 *  the dialog open on that id, so the retry updates the row it already made.
 *
 *  The writers are passed in, so tests drive it with plain functions and no
 *  server. */

import type { ServiceDraft } from "@/lib/services";

export type OneTimePriceWrite = { autoAccept: boolean; priceCents: number | null };

export async function saveServiceThenOneTimePrice(args: {
  /** The service being edited, or null for a new one. */
  id: string | null;
  draft: ServiceDraft;
  /** petWasteOneTimeSave's write, or null when there is none. */
  oneTime: OneTimePriceWrite | null;
  create: (draft: ServiceDraft) => Promise<{ id: string }>;
  update: (id: string, draft: ServiceDraft) => Promise<{ id: string }>;
  setOneTimePrice: (data: OneTimePriceWrite) => Promise<unknown>;
}): Promise<{ id: string; priceError: string | null }> {
  // A failure here throws: nothing has been written yet.
  const { id } = args.id ? await args.update(args.id, args.draft) : await args.create(args.draft);
  if (!args.oneTime) return { id, priceError: null };
  try {
    await args.setOneTimePrice(args.oneTime);
    return { id, priceError: null };
  } catch (e) {
    return { id, priceError: e instanceof Error ? e.message : String(e) };
  }
}

/** What the dialog does after a Save that did not throw: close, or stay
 *  open on the row it just saved (its id filled in, so the next Save is an
 *  update of that row, never a second create) with the sentence to show. */
export function formAfterSave<F extends { id: string | null }>(
  form: F,
  result: { id: string; priceError: string | null },
): { close: true } | { close: false; form: F; error: string } {
  if (!result.priceError) return { close: true };
  return {
    close: false,
    form: { ...form, id: result.id },
    error: oneTimePriceNotSaved(!form.id, result.priceError),
  };
}

/** What the form says when the service saved and the price did not. */
export function oneTimePriceNotSaved(created: boolean, reason: string): string {
  const why = reason.trim().replace(/[.!?]?$/, (end) => end || ".");
  return `Service ${created ? "added" : "saved"}, but the one-time cleanup price was not saved: ${why} Press Save to try the price again.`;
}

/** What the form says when the one-time price could not be read. */
export const ONE_TIME_PRICE_LOAD_ERROR =
  "The one-time cleanup price could not be loaded. Close this and try again, or set it in Settings → Client portal.";
