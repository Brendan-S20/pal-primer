import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";
import { aliasHref, PATH_ALIASES, requestQueryString } from "@/lib/path-alias";

// Alias for sign up. 302 (not 301) so the decision stays open; the query string
// (ref, utm_*, email, ...) goes through untouched. See lib/path-alias.ts.
export const Route = createFileRoute("/signup/")({
  beforeLoad: async ({ location }) => {
    const raw = await requestQueryString();
    throw redirect({
      href: aliasHref(PATH_ALIASES["/signup"], raw ?? location.searchStr),
      statusCode: 302,
    });
  },
  component: () => <RedirectFallback to="/sign-up" label="sign up" />,
});
