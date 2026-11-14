// What setup step 1 fills in for the client portal (D14, onboarding audit
// 2026-11-09).
//
// After every setup step, Settings > Client portal showed
// `app.houndstack.com/portal/` with nothing after the slash, and the office
// email warning "Add one. Invoices and reminders are sent from a no-reply
// address". Setup had never asked for either. Step 1 now does, prefilled and
// editable:
//
//   * the portal address from the business name, by the same slug rule the
//     server saves with (lib/portal-slug);
//   * the office email (organizations.contact_email, the reply-to on every
//     customer email) from the owner's own sign-in email.
//
// "typed" is null until the owner touches the field, the same
// null-means-untouched convention as the rest of the step 1 form: only a
// CHANGE overwrites something already saved.

import { MIN_PORTAL_SLUG, slugify } from "@/lib/portal-slug";

/** The address a business name turns into, or "" when it is too short. */
export function portalSlugFromName(name: string | null | undefined): string {
  const s = slugify(name ?? "");
  return s.length >= MIN_PORTAL_SLUG ? s : "";
}

/** What the portal address field shows before it is touched. */
export function portalSlugPrefill(o: { saved: string | null | undefined; name: string }): string {
  return o.saved || portalSlugFromName(o.name);
}

export type PortalSlugWrite =
  { kind: "keep" } | { kind: "set"; slug: string } | { kind: "suggest" };

/**
 * What saving step 1 does to the portal address.
 *
 *   keep    a saved address and nothing usable typed over it;
 *   set     the owner typed one (setPortalSlug, which refuses a taken one);
 *   suggest no address yet and none typed: suggestPortalSlug saves the name's
 *           slug, or the nearest free one, AFTER the name is saved. A name
 *           another business already has must never block step 1.
 */
export function portalSlugWrite(o: {
  saved: string | null | undefined;
  typed: string | null;
}): PortalSlugWrite {
  const typed = o.typed === null ? "" : slugify(o.typed);
  if (typed.length >= MIN_PORTAL_SLUG) {
    return typed === o.saved ? { kind: "keep" } : { kind: "set", slug: typed };
  }
  return o.saved ? { kind: "keep" } : { kind: "suggest" };
}

/** What the office email field shows before it is touched. */
export function officeEmailPrefill(o: {
  saved: string | null | undefined;
  ownerEmail: string | null | undefined;
}): string {
  return o.saved || o.ownerEmail || "";
}

/**
 * The contactEmail to send with step 1: a string to save, null to clear it,
 * undefined to leave it alone.
 */
export function officeEmailWrite(o: {
  saved: string | null | undefined;
  typed: string | null;
  ownerEmail: string | null | undefined;
}): string | null | undefined {
  if (o.typed !== null) {
    const t = o.typed.trim();
    if (t === (o.saved ?? "")) return undefined;
    return t || null;
  }
  if (o.saved) return undefined;
  return o.ownerEmail || undefined;
}
