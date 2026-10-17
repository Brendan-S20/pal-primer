import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { TenantSignupShell } from "@/components/marketing/TenantSignupShell";
import { getPublicSignupForm } from "@/lib/signup.functions";
import { formCopy } from "@/lib/new-customer-form";
import { SignupFlow } from "@/components/signup/SignupFlow";
import { customerTitle } from "@/lib/page-title";

// A business's one public form: price the yard, then start service or ask for
// a quote. /lead/{slug}, the hosted lead form that used to be a second page
// for the same visitor, forwards here with its query string intact.
//
// The quote / details / payment / quote-request machine itself lives in
// components/signup/SignupFlow.tsx, because canvassing walk mode runs the same
// flow at a prospect's front door. This route owns what is PUBLIC about it:
// the slug lookup, the tenant branding shell, the owner's headline, and the
// unbranded loading and unavailable states.
//
// The search params are passed through untouched (zone, ref, utm_*, embed and
// whatever a tenant's site appends) so a redirect from the old address, or a
// link the tenant built, keeps everything it carried.

export const Route = createFileRoute("/signup/$slug")({
  validateSearch: (s: Record<string, unknown>) => s,
  head: () => ({
    meta: [
      { title: customerTitle("Get a quote") },
      {
        name: "description",
        content:
          "Enter your ZIP, number of dogs, and cleanup frequency to get a price, then start service online or ask for a quote.",
      },
    ],
  }),
  component: SignupPage,
});

/** Inside an iframe on the business's own website (the embed code in
 *  Settings, or an old lead-form embed that now lands here), the page drops
 *  its own header: the business's site is already wearing their name. */
function useEmbedded(flag: unknown): boolean {
  const asked = flag === 1 || flag === "1" || flag === true || flag === "true";
  const [framed, setFramed] = useState(false);
  useEffect(() => {
    try {
      setFramed(window.self !== window.top);
    } catch {
      // A cross-origin parent throws on window.top access in some browsers,
      // which itself means we are framed.
      setFramed(true);
    }
  }, []);
  return asked || framed;
}

function SignupPage() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const embedded = useEmbedded(search.embed);
  const getForm = useServerFn(getPublicSignupForm);

  const formQ = useQuery({
    queryKey: ["signup-form", slug],
    queryFn: () => getForm({ data: { slug } }),
    retry: false,
  });

  // Before the lookup resolves there is no tenant to be branded as, so these
  // two states carry no branding at all rather than borrowing ours. The
  // unavailable state in particular used to sit under a HoundStack header:
  // the one page a prospect reaches when a tenant's link is wrong, wearing the
  // name of a company they have never heard of.
  if (formQ.isLoading) {
    return (
      <TenantSignupShell orgName={null} compact={embedded}>
        <div className="mx-auto max-w-2xl px-4 py-24 text-center text-muted-foreground sm:px-6">
          Loading…
        </div>
      </TenantSignupShell>
    );
  }

  if (formQ.error || !formQ.data) {
    return (
      <TenantSignupShell orgName={null} compact={embedded}>
        <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
          <h1 className="text-2xl font-semibold">This page isn't available</h1>
          <p className="mt-3 text-muted-foreground">
            Check the link with the business that sent it to you.
          </p>
        </div>
      </TenantSignupShell>
    );
  }

  const org = formQ.data;
  const copy = formCopy(org.form, org.instantStart);

  return (
    <TenantSignupShell
      orgName={org.name}
      logoUrl={org.logoUrl}
      brandColor={org.brandColor}
      compact={embedded}
    >
      <section
        className={
          embedded
            ? "mx-auto max-w-6xl px-4 pt-6 pb-10 sm:px-6"
            : "mx-auto max-w-6xl px-4 pt-10 pb-24 sm:px-6 sm:pt-16"
        }
      >
        <div className="mb-8">
          {/* The shell's header already names the business; only the
              embedded form, which has no header, says it here (QA row 42:
              the name was printed twice). */}
          {embedded && <div className="mb-2 text-sm text-muted-foreground">{org.name}</div>}
          <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">
            {copy.headline}
          </h1>
          <p className="mt-2 break-words text-muted-foreground">{copy.intro}</p>
        </div>

        <SignupFlow slug={slug} variant="page" />
      </section>
    </TenantSignupShell>
  );
}
