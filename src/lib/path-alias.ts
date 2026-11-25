import { createIsomorphicFn } from "@tanstack/react-start";

/**
 * The address an alias path forwards to: `to` plus the query string exactly as
 * it arrived. Taken as a string, not re-serialised from the router's parsed
 * object, so ref codes, utm_* values and ?email= are not reordered, re-typed
 * (`12e3` -> `12000`) or dropped on the way through.
 */
export function aliasHref(to: string, searchStr: string | null | undefined): string {
  const qs =
    searchStr && searchStr !== "?" ? (searchStr.startsWith("?") ? searchStr : `?${searchStr}`) : "";
  return `${to}${qs}`;
}

/** The raw query string of the incoming request (server only; null on the client,
 *  where the caller falls back to the router's copy). See routes/lead.$slug.tsx. */
export const requestQueryString = createIsomorphicFn()
  .server(async (): Promise<string | null> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    try {
      return new URL(getRequest().url).search;
    } catch {
      return null;
    }
  })
  .client(async (): Promise<string | null> => null);

/** Common sign-in / sign-up addresses people type or bookmark, mapped to the
 *  real route. /signup itself is routes/signup.index.tsx (not signup.tsx, which
 *  would become a layout over /signup/$slug and /signup/success). */
export const PATH_ALIASES = {
  "/sign-in": "/auth",
  "/signin": "/auth",
  "/login": "/auth",
  "/signup": "/sign-up",
} as const;
