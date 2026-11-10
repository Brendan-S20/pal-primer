// Where HoundStack's pet-pro directory (#630) lives, and what it is called.
// THE ONE PLACE the directory's domain is written down.
//
// Brendan, 2026-11-09: the directory's domain and brand is mypets.services.
// Later the same day: it is registered on HoundStack's Vercel team, but not
// yet attached to the directory's deployment. So:
//   * the name appears here and nowhere else in src/ (a test counts);
//   * no DNS record, Vercel project domain or deployment step is in the
//     code; attaching the domain is a post-merge step done in Vercel;
//   * canonicals keep pointing at the host that actually serves /pros until
//     it is attached. On that day, set DIRECTORY_ORIGIN in the server's
//     environment to the domain's https origin and every canonical follows;
//     nothing else in the code has to change.

import { appOrigin } from "@/lib/app-origin";

/** The directory's brand, as a visitor reads it in the page header and the
 *  tab title. A name, not a link, until the domain serves these pages. */
export const DIRECTORY_BRAND = "mypets.services";

/**
 * The origin directory pages call their own (canonical, og:url).
 *
 * `DIRECTORY_ORIGIN` when the server's environment sets it to an https URL;
 * otherwise the app's own origin, which is where the pages are actually
 * served today. Never defaults to the brand domain: a canonical pointing at a
 * host that does not serve the page tells a search engine it lives somewhere
 * it does not.
 */
export function directoryOrigin(): string {
  const env = typeof process !== "undefined" ? process.env : undefined;
  const configured = env?.DIRECTORY_ORIGIN?.trim();
  if (configured && /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(configured)) {
    return configured.replace(/\/+$/, "");
  }
  return appOrigin();
}
