// Tell the directory site (DIRECTORY_BRAND) that a listing changed (#939;
// mypets #15/#16).
//
// The directory site caches its pages. Without this call a published,
// unpublished or edited listing showed there only when the cache ran out on
// its own, which read to an owner as "Save did nothing". mypets #16 added
//
//   POST https://{DIRECTORY_BRAND}/api/revalidate
//   Authorization: Bearer <MYPETS_REVALIDATE_SECRET>
//   { "event": "publish" | "unpublish" | "update", "slug": "<listing slug>" }
//
// which expires the whole directory tag plus the slug's tag and paths.
//
// The rules this file keeps:
//  - The secret is read here, from the SERVER's env, and nowhere else. Never
//    VITE_*, never import.meta.env, never logged, never returned. This file is
//    .server.ts and is only ever loaded with a dynamic import inside a server
//    function's handler (tests/mypets-revalidate-secret-stays-on-the-server).
//  - It never throws and never fails the write that called it. Unset secret:
//    one warning, no call. Network error, timeout or non-2xx: one retry, then
//    one warning, and the caller carries on. The whole thing is bounded by
//    two short timeouts, so a slow mypets costs a Save at most that long.

import { DIRECTORY_BRAND } from "@/lib/directory-site";

// The domain is written in one file (lib/directory-site.ts, which a test
// holds to that), so the endpoint is built from it rather than spelled here.
export const MYPETS_REVALIDATE_URL = `https://${DIRECTORY_BRAND}/api/revalidate`;

/** Per attempt. Two attempts, so a dead endpoint costs a Save at most ~2x this. */
export const MYPETS_REVALIDATE_TIMEOUT_MS = 2_500;

export type MypetsRevalidateEvent = "publish" | "unpublish" | "update";

/** The slug pattern mypets #16 accepts; anything else would be a 400 there. */
const SLUG = /^[a-z0-9-]{1,80}$/;

let warnedUnset = false;

/** Test-only: forget that the unset-secret warning was already printed. */
export function resetMypetsRevalidateWarningForTests(): void {
  warnedUnset = false;
}

/**
 * The event a profile save means, or null when nothing a visitor sees could
 * have changed (an unlisted profile saved as unlisted).
 */
export function revalidateEventForSave(
  wasPublished: boolean,
  isPublished: boolean,
): MypetsRevalidateEvent | null {
  if (isPublished && !wasPublished) return "publish";
  if (!isPublished && wasPublished) return "unpublish";
  if (isPublished) return "update";
  return null;
}

async function attempt(
  fetchImpl: typeof fetch,
  secret: string,
  body: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(MYPETS_REVALIDATE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    return { ok: false, why: `HTTP ${res.status}` };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, why: name === "AbortError" ? "timed out" : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the directory site to drop its cached directory pages for `slug`.
 * Resolves to whether it was accepted; never rejects.
 */
export async function revalidateMypetsListing(
  event: MypetsRevalidateEvent,
  slug: string | null | undefined,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    const secret = process.env.MYPETS_REVALIDATE_SECRET?.trim();
    if (!secret) {
      if (!warnedUnset) {
        warnedUnset = true;
        console.warn(
          "mypets revalidate skipped: MYPETS_REVALIDATE_SECRET is not set on the server",
        );
      }
      return false;
    }
    const cleanSlug = typeof slug === "string" ? slug.trim().toLowerCase() : "";
    // A slug mypets would refuse is left out: the directory tag alone still
    // expires every listing page, which is the safe over-invalidation.
    const payload = SLUG.test(cleanSlug) ? { event, slug: cleanSlug } : { event };
    const body = JSON.stringify(payload);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? MYPETS_REVALIDATE_TIMEOUT_MS;
    let last = await attempt(fetchImpl, secret, body, timeoutMs);
    if (last.ok) return true;
    last = await attempt(fetchImpl, secret, body, timeoutMs);
    if (last.ok) return true;
    console.warn("mypets revalidate failed after a retry", event, payload.slug ?? "", last.why);
    return false;
  } catch {
    console.warn("mypets revalidate failed", event);
    return false;
  }
}
