import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { TenantSignupShell } from "@/components/marketing/TenantSignupShell";
import { getSignupOrg } from "@/lib/signup.functions";
import { SignupFlow } from "@/components/signup/SignupFlow";
import { customerTitle } from "@/lib/page-title";

// The quote / details / payment machine itself lives in
// components/signup/SignupFlow.tsx, because canvassing walk mode runs the same
// flow at a prospect's front door. This route owns what is PUBLIC about it:
// the slug lookup, the tenant branding shell, and the two unbranded states.

export const Route = createFileRoute("/signup/$slug")({
  head: () => ({
    meta: [
      { title: customerTitle("Get an instant quote") },
      {
        name: "description",
        content:
          "Enter your ZIP, number of dogs, and cleanup frequency to get an instant price and sign up online.",
      },
    ],
  }),
  component: SignupPage,
});

function SignupPage() {
  const { slug } = useParams({ from: "/signup/$slug" });
  const getOrg = useServerFn(getSignupOrg);

  const orgQ = useQuery({
    queryKey: ["signup-org", slug],
    queryFn: () => getOrg({ data: { slug } }),
    retry: false,
  });

  // Before the lookup resolves there is no tenant to be branded as, so these
  // two states carry no branding at all rather than borrowing ours. The
  // unavailable state in particular used to sit under a HoundStack header —
  // the one page a prospect reaches when a tenant's link is wrong, wearing the
  // name of a company they have never heard of.
  if (orgQ.isLoading) {
    return (
      <TenantSignupShell orgName={null}>
        <div className="mx-auto max-w-2xl px-6 py-24 text-center text-muted-foreground">
          Loading…
        </div>
      </TenantSignupShell>
    );
  }

  if (orgQ.error || !orgQ.data) {
    return (
      <TenantSignupShell orgName={null}>
        <div className="mx-auto max-w-2xl px-6 py-24 text-center">
          <h1 className="text-2xl font-semibold">Signup unavailable</h1>
          <p className="mt-3 text-muted-foreground">
            This company isn't taking online signups right now.
          </p>
        </div>
      </TenantSignupShell>
    );
  }

  const org = orgQ.data;

  return (
    <TenantSignupShell orgName={org.name} logoUrl={org.logo_url} brandColor={org.brand_color}>
      <section className="mx-auto max-w-6xl px-6 pt-16 pb-24">
        <div className="mb-8">
          <div className="text-sm text-muted-foreground">{org.name}</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Get an instant quote
          </h1>
          <p className="mt-2 text-muted-foreground">
            Tell us about your property and pets and we'll price it in seconds. No calls, no forms
            to wait on.
          </p>
        </div>

        <SignupFlow slug={slug} variant="page" />
      </section>
    </TenantSignupShell>
  );
}
