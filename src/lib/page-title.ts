import { useEffect } from "react";
import { APP_NAME } from "@/lib/scoop";

// ── ONE FORMAT FOR WHAT THE BROWSER TAB SAYS ─────────────────────────────
//
// Until 2026-10 about forty pages were titled "HoundStack - Field Service App",
// the root default, and the rest used three formats between them ("Quotes ·
// HoundStack", "My schedule - HoundStack", "Accounting sync · Settings", and
// "Waste disposal log" with no brand at all). An owner with five tabs open could
// not tell them apart, and the installed app's window switcher showed the same
// name for every one of them.
//
// So: "Page · HoundStack", most specific first, because a tab strip truncates
// from the RIGHT and the part that tells two tabs apart has to survive it.
// tests/every-tab-was-called-houndstack.test.ts holds every staff route to this.

const SEP = " · ";

/** "Schedule" → "Schedule · HoundStack"; ("Jane Doe", "Clients") →
 *  "Jane Doe · Clients · HoundStack". Empty parts are dropped, so a dynamic
 *  name that has not loaded yet does not leave a dangling separator. */
export function pageTitle(...parts: Array<string | null | undefined | false>): string {
  return [...parts.filter((p): p is string => !!p && p.trim() !== ""), APP_NAME].join(SEP);
}

/** The `head` of a route whose title is known up front:
 *  `head: () => titleHead("Invoices")`. */
export function titleHead(...parts: Array<string | null | undefined | false>) {
  return { meta: [{ title: pageTitle(...parts) }] };
}

/** A customer-facing page: the business's name, never ours. The customer
 *  signed up with a pet-waste company, not with HoundStack, and a tab that
 *  says "HoundStack" is a name they have never heard. */
export function customerTitle(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => !!p && p.trim() !== "").join(SEP);
}

/**
 * Overwrite the tab title once a page knows something the route's `head`
 * could not: a client's name, an invoice number, the language a technician
 * picked. `head()` runs before the page's data loads and outside React, so it
 * cannot read a query or call `t()`.
 *
 * The route still declares a static `head` title, which is what shows while
 * this page loads and what the next route's HeadContent replaces it with on
 * the way out. Nothing is restored on unmount for that reason: the next page's
 * own title is already on its way.
 *
 * Pass `null` to leave the static title alone (data not loaded yet).
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title || typeof document === "undefined") return;
    document.title = title;
  }, [title]);
}
