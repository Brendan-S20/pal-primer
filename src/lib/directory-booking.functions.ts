// The directory's booking hand-off (#630; directory v2 step 7).
//
// GET /d/{directory slug}/book?service=<booking_key>&zip=<5 digits>[&return=<url>]
//
// The directory app (DIRECTORY_BRAND, its own repo) builds that link from a
// row of directory_public_listings: the DIRECTORY slug and a listed
// service's opaque booking_key are public, so it never sees an organization
// id, a service id or the business's own booking slug. This server turns
// them into the business's own booking link, /signup/{slug}, with the service
// and ZIP filled in and ref=DIRECTORY_REF, and adds book=1 only when the
// listing says that service can be sold right now (directoryBookingHref).
//
// Fail safe, every way: a slug that is not a published listing of a live
// business answers "unavailable" (a page with a way back, never a dead end);
// a service the owner takes only requests for, a switch that is off, signup
// or Stripe charges that are off, or a key that names nothing, all land on
// the same booking link WITHOUT book=1, where the visitor asks for a quote
// and no card is offered. No PaymentIntent is made here or because of this
// file: the booking link makes one only on the visitor's own Pay, and only
// for a directory booking the owner has switched on (createSignupPaymentIntent).
//
// The lookup is directory_booking_handoff, SERVICE ROLE only, which reads the
// view, so the listing and the hand-off cannot disagree. A database without
// it yet (the migration is applied after this code is live) sends the visitor
// to the directory's own quote form for that listing.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { cleanZip, directoryBookingHref, isDirectorySlug, type DirectoryHandoff } from "@/lib/directory";
import { isDirectoryAppOrigin } from "@/lib/directory-quote-cors";

export type DirectoryBookingAnswer =
  | { kind: "go"; href: string }
  | { kind: "unavailable"; back: string | null };

/** A return address the directory app passed, if it is one of its own
 *  origins (https, the brand and www, and its previews), else null. */
export function directoryReturnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    return isDirectoryAppOrigin(u.origin) ? u.toString() : null;
  } catch {
    return null;
  }
}

export const directoryBookingInput = z.object({
  slug: z.string().trim().toLowerCase().max(120),
  service: z.string().trim().max(64).optional().nullable(),
  zip: z.unknown().optional(),
  returnTo: z.unknown().optional(),
});

/** The decision, separated from the lookup so it can be tested. */
export function decideDirectoryBooking(
  rows: DirectoryHandoff[] | null,
  input: { slug: string; zip?: unknown; returnTo?: unknown },
): DirectoryBookingAnswer {
  const zip = cleanZip(typeof input.zip === "number" ? String(input.zip).padStart(5, "0") : input.zip);
  const back = directoryReturnUrl(input.returnTo);
  // No answer from the lookup at all: the directory's own quote form.
  if (rows === null) return { kind: "go", href: `/pros/${encodeURIComponent(input.slug)}/quote` };
  const row = rows[0];
  if (!row || !row.signup_slug) return { kind: "unavailable", back };
  return { kind: "go", href: directoryBookingHref(row, zip) };
}

export const resolveDirectoryBooking = createServerFn({ method: "GET" })
  .inputValidator((d) => directoryBookingInput.parse(d))
  .handler(async ({ data }): Promise<DirectoryBookingAnswer> => {
    if (!isDirectorySlug(data.slug)) return decideDirectoryBooking([], data);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await (supabaseAdmin as any).rpc("directory_booking_handoff", {
      _slug: data.slug,
      _booking_key: data.service ?? null,
    });
    if (error) {
      console.error("directory booking hand-off lookup failed", data.slug, error);
      return decideDirectoryBooking(null, data);
    }
    return decideDirectoryBooking((rows ?? []) as DirectoryHandoff[], data);
  });
