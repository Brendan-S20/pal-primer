import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { stashSignupAttribution } from "@/lib/signup-attribution";
import { PublicShell } from "@/components/PublicShell";
import { APP_NAME } from "@/lib/scoop";

// Feature 1: the stable, linkable signup URL for marketing links, ads, and
// tenant referral links (houndstack /sign-up?ref=CODE). It captures referral +
// UTM attribution, then hands off to the existing Get-started walkthrough —
// account creation only, no "or sign in" ambiguity.
export const Route = createFileRoute("/sign-up")({
  validateSearch: (s: Record<string, unknown>) => ({
    ref: typeof s.ref === "string" ? s.ref : undefined,
    email: typeof s.email === "string" ? s.email : undefined,
    utm_source: typeof s.utm_source === "string" ? s.utm_source : undefined,
    utm_medium: typeof s.utm_medium === "string" ? s.utm_medium : undefined,
    utm_campaign: typeof s.utm_campaign === "string" ? s.utm_campaign : undefined,
    utm_term: typeof s.utm_term === "string" ? s.utm_term : undefined,
    utm_content: typeof s.utm_content === "string" ? s.utm_content : undefined,
  }),
  head: () => ({
    meta: [
      { title: `Sign up — ${APP_NAME}` },
      { name: "description", content: `Create your ${APP_NAME} account.` },
    ],
  }),
  component: SignUpRedirect,
});

function SignUpRedirect() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    stashSignupAttribution(search as Record<string, unknown>);
    navigate({
      to: "/get-started",
      search: {
        email: search.email,
        ref: undefined,
        utm_source: undefined,
        utm_medium: undefined,
        utm_campaign: undefined,
        utm_term: undefined,
        utm_content: undefined,
      },
      replace: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PublicShell>
      <p className="text-center text-sm text-muted-foreground">Setting up your signup…</p>
    </PublicShell>
  );
}
