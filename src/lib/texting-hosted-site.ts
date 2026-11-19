import { DIRECTORY_BRAND } from "@/lib/directory-site";

// #969: the website, Privacy Policy and Terms a texting registration files
// when the owner has no website of their own.
//
// Brendan, 2026-11-17, on #969: host a Privacy and Terms page per business
// on the directory's domain (DIRECTORY_BRAND) and use it by default. Most
// walkers, sitters and scoopers have no website, or none that carries the pages carriers ask for, so the
// hosted page is the DEFAULT in Settings > Texting and "I have my own
// website" is the option. The pages themselves live in Brendan-S20/mypets:
//
//   https://{DIRECTORY_BRAND}/{slug}           the business's listing
//   https://{DIRECTORY_BRAND}/{slug}/privacy   its own Privacy Policy
//   https://{DIRECTORY_BRAND}/{slug}/terms     its own Terms of Service
//
// built only from the published listing, public with no login.
//
// Kept in its own file, beside lib/texting-registration.ts rather than in
// it, so this change stays apart from other work on Settings > Texting. The
// domain is DIRECTORY_BRAND, never spelled here (lib/directory-site.ts is the
// one place it is written; a test counts).

/** Which website the registration files. */
export type SiteChoice = "hosted" | "own";

/** The host every hosted URL is on. Website, Privacy and Terms must all be on
 *  this one host: carriers check the policy pages sit with the website. */
export const HOSTED_SITE_HOST = DIRECTORY_BRAND;

/** Said before Submit on the hosted path (#969 review): the owner is the
 *  sender, and these pages make promises in the business's own name. */
export const HOSTED_POLICIES_LINE =
  "These pages are your business's Privacy Policy and Terms. Read them before you submit.";

/** The slug pattern the directory (and mypets) accepts. */
const SLUG = /^[a-z0-9-]{1,80}$/;

export function hostedSiteUrls(slug: string): {
  website_url: string;
  privacy_url: string;
  terms_url: string;
} {
  const base = `https://${HOSTED_SITE_HOST}/${slug}`;
  return { website_url: base, privacy_url: `${base}/privacy`, terms_url: `${base}/terms` };
}

function parse(url: string | null | undefined): URL | null {
  try {
    return new URL((url ?? "").trim());
  } catch {
    return null;
  }
}

/** True when the URL is on the hosted site's host (any path). */
export function isHostedSiteUrl(url: string | null | undefined): boolean {
  const u = parse(url);
  return !!u && u.hostname.toLowerCase().replace(/\.$/, "") === HOSTED_SITE_HOST;
}

/** The listing slug in https://{host}/{slug}, or null. */
export function hostedSlugOf(url: string | null | undefined): string | null {
  const u = parse(url);
  if (!u || !isHostedSiteUrl(url)) return null;
  const slug = u.pathname.replace(/^\/+|\/+$/g, "");
  return SLUG.test(slug) ? slug : null;
}

/**
 * Field problems for a hosted filing: an https website at /{slug}, and its
 * Privacy and Terms at /{slug}/privacy and /{slug}/terms on the SAME host.
 * Empty when the three are exactly what hostedSiteUrls(slug) builds.
 */
export function hostedSiteProblems(d: {
  website_url: string;
  privacy_url: string;
  terms_url: string;
}): Array<{ path: "website_url" | "privacy_url" | "terms_url"; message: string }> {
  const slug = hostedSlugOf(d.website_url);
  const site = parse(d.website_url);
  if (
    !slug ||
    site?.protocol !== "https:" ||
    site.search ||
    site.hash ||
    site.username ||
    site.password ||
    site.port
  ) {
    return [{ path: "website_url", message: `Use your ${HOSTED_SITE_HOST} page address` }];
  }
  const want = hostedSiteUrls(slug);
  const out: ReturnType<typeof hostedSiteProblems> = [];
  for (const key of ["privacy_url", "terms_url"] as const) {
    const u = parse(d[key]);
    const same =
      !!u &&
      u.protocol === "https:" &&
      u.host.toLowerCase() === site.host.toLowerCase() &&
      `${u.origin}${u.pathname.replace(/\/+$/, "")}` === want[key];
    if (!same) {
      out.push({
        path: key,
        message: `Use ${want[key]}, on the same site as your ${HOSTED_SITE_HOST} page`,
      });
    }
  }
  return out;
}

/** The choice Settings > Texting starts on: the hosted page, unless the
 *  owner already saved a website of their own. */
export function siteChoiceFor(saved: { website_url?: string | null } | null): SiteChoice {
  const w = saved?.website_url?.trim();
  return w && !isHostedSiteUrl(w) ? "own" : "hosted";
}

/** The owner's own website fields, with hosted URLs left out: a saved
 *  hosted filing must not reappear as "my own website". */
export function ownSiteFields(saved: {
  website_url: string;
  privacy_url: string;
  terms_url: string;
}): { website_url: string; privacy_url: string; terms_url: string } {
  const clear = (v: string) => (isHostedSiteUrl(v) ? "" : v);
  return {
    website_url: clear(saved.website_url),
    privacy_url: clear(saved.privacy_url),
    terms_url: clear(saved.terms_url),
  };
}

/** What the business's directory listing gives the hosted path. */
export type HostedSite = {
  /** The listing's slug, or null when the business has no listing. */
  slug: string | null;
  /** Only a published listing has live pages a carrier can open. */
  published: boolean;
};

/** Why the hosted path cannot be filed yet, in the owner's words, or null. */
export function hostedSiteBlocker(h: HostedSite | null | undefined): string | null {
  if (!h?.slug) {
    return `Set up your ${HOSTED_SITE_HOST} page in Settings > Directory first, or choose "I have my own website".`;
  }
  if (!h.published) {
    return `Publish your ${HOSTED_SITE_HOST} page in Settings > Directory first, so carriers can open it, or choose "I have my own website".`;
  }
  return null;
}

/**
 * The website fields the form files: the hosted URLs for the listing on the
 * hosted path (empty when there is no listing yet, so the check names it),
 * the owner's typed ones otherwise.
 */
export function siteFields<
  T extends { website_url: string; privacy_url: string; terms_url: string },
>(form: T, choice: SiteChoice, hosted: HostedSite | null | undefined): T {
  if (choice === "own") return form;
  const urls = hosted?.slug
    ? hostedSiteUrls(hosted.slug)
    : { website_url: "", privacy_url: "", terms_url: "" };
  return { ...form, ...urls };
}

// ── Settings > Directory lock (#969 review, must-fix 1) ────────────────────
//
// Once a registration names the hosted page, the filed Website, Privacy and
// Terms (and the links in every stored client consent) are that listing's
// /{slug}, /{slug}/privacy and /{slug}/terms. Changing the slug or
// unpublishing would turn all three into 404s, and Twilio requires them to
// stay publicly reachable and to match what clients saw at opt-in. So while
// such a registration is anything but not started or rejected, Settings >
// Directory keeps the page address and keeps the listing published.

/** Registration statuses that lock the hosted page: everything except
 *  rejected (a refiling picks up the page as it is then). No row is "not
 *  started" and does not lock. */
export const DIRECTORY_LOCK_STATUSES = [
  "draft",
  "submitting",
  "submitted",
  "in_review",
  "approved",
  "failed",
] as const;

/** What Settings > Directory says while the page is locked. */
export const DIRECTORY_LOCKED_BY_TEXTING =
  "Your texting registration uses this page, so its web address can't change and it stays listed. Your Privacy Policy and Terms for texting live at this address.";

export type DirectoryLock = { slug: string } | null;

/** The slug the registration locks, or null when nothing is locked. */
export function directoryLockFrom(
  reg: { status?: string | null; website_url?: string | null } | null | undefined,
): DirectoryLock {
  if (!reg?.status) return null;
  if (!(DIRECTORY_LOCK_STATUSES as readonly string[]).includes(reg.status)) return null;
  const slug = hostedSlugOf(reg.website_url);
  return slug ? { slug } : null;
}

/** Why this directory save must be refused, or null. */
export function directoryChangeRefusal(
  lock: DirectoryLock,
  next: { slug: string; published: boolean },
): string | null {
  if (!lock) return null;
  if (next.slug.trim().toLowerCase() !== lock.slug || !next.published)
    return DIRECTORY_LOCKED_BY_TEXTING;
  return null;
}
