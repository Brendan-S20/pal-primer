// Who may post a directory quote from a browser (#630; the standalone
// directory app, whose domain is DIRECTORY_BRAND in lib/directory-site.ts).
//
// Two paths reach the one lead handler (routes/api/public/leads.ts):
//
//   * /api/public/leads keeps `Access-Control-Allow-Origin: *`. Tenant
//     websites embed that form on domains HoundStack does not know ahead of
//     time, so narrowing it would break every one of them. A directory quote
//     from HoundStack's own /pros pages posts there too, same-origin.
//   * /api/public/directory/quotes takes directory quotes only, and answers
//     CORS only for the standalone directory app: https://DIRECTORY_BRAND
//     (and www), and its Vercel previews. The domain is not spelled here:
//     it is written in one file in src/ (tests/a-review-waits-for-a-moderator.test.ts). The request Origin is echoed back,
//     never `*`, with `Vary: Origin` so a cache cannot hand one origin's
//     answer to another.
//
// CORS is not the lock here and is not meant to be. No cookie or credential
// rides on these requests, and a non-browser caller sends no Origin at all.
// What stops abuse is on the server, the same on both paths: the honeypot,
// the time-to-submit check, the rate limit (take_public_form_turn) and the
// published-profile lookup. This file only decides which web pages may read
// the answer.

import { DIRECTORY_BRAND } from "@/lib/directory-site";

/** The directory app's own origins. */
export const DIRECTORY_APP_ORIGINS: readonly string[] = [
  `https://${DIRECTORY_BRAND}`,
  `https://www.${DIRECTORY_BRAND}`,
];

/** The Vercel project is named for the domain's first label. */
const PROJECT = DIRECTORY_BRAND.split(".")[0].replace(/[^a-z0-9-]/g, "");

/** A Vercel preview of that project: `<project>-<hash>-<scope>.vercel.app`
 *  or `<project>-git-<branch>-<scope>.vercel.app`. One DNS label, https only. */
const PREVIEW = new RegExp(`^https://${PROJECT}-[a-z0-9]+(?:-[a-z0-9]+)*\\.vercel\\.app$`);

export function isDirectoryAppOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  return DIRECTORY_APP_ORIGINS.includes(origin) || PREVIEW.test(origin);
}

const BASE = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
} as const;

/** The CORS headers for a request with this Origin. An allowed origin is
 *  echoed; anything else gets no Allow-Origin, so a browser on another page
 *  cannot read the answer. */
export function directoryQuoteCors(origin: string | null | undefined): Record<string, string> {
  return isDirectoryAppOrigin(origin)
    ? { ...BASE, "Access-Control-Allow-Origin": origin! }
    : { ...BASE };
}
