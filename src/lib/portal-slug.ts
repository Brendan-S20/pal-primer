// The portal address rule, with no server imports, so the browser can show
// the address a business name turns into (setup step 1, Settings > Client
// portal) by the same rule setPortalSlug and ensureOrgSlug save with.

/** Lowercase letters, digits and single hyphens, no hyphen at either end. */
export function slugify(txt: string): string {
  return (txt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The shortest address setPortalSlug accepts. */
export const MIN_PORTAL_SLUG = 3;
