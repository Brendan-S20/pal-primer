import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";
import { aliasHref, PATH_ALIASES, requestQueryString } from "@/lib/path-alias";

// Alias for sign in. 302 (not 301) so the decision stays open; the query string
// (ref, utm_*, email, ...) goes through untouched. See lib/path-alias.ts.
export const Route = createFileRoute("/signin")({
  beforeLoad: async ({ location }) => {
    const raw = await requestQueryString();
    throw redirect({
      href: aliasHref(PATH_ALIASES["/signin"], raw ?? location.searchStr),
      statusCode: 302,
    });
  },
  component: () => <RedirectFallback to="/auth" label="sign in" />,
});
