import { createFileRoute, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { TenantSignupShell } from "@/components/marketing/TenantSignupShell";
import { Mail, MapPin, Phone } from "lucide-react";
import { getPublicSignupForm } from "@/lib/signup.functions";
import { formCopy } from "@/lib/new-customer-form";
import { bookingPageHead, telHref, unavailablePageHead } from "@/lib/booking-page";
import { appOrigin } from "@/lib/app-origin";
import { customerTitle } from "@/lib/page-title";
import { SIGNUP_FORM_STALE_MS, SignupFlow } from "@/components/signup/SignupFlow";

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
  // The business, looked up on the SERVER (#524), so the HTML a link
  // unfurler or a crawler fetches already names it: the title, the preview
  // tags, the headline and step 1 of the form. Before this the server sent
  // "Get a quote" over HoundStack's own preview tags and a blank page, and
  // the form appeared only after a client-side lookup (4.9 s at 390 px).
  //
  // The page's query starts from this answer (`initialData` below), so the
  // server and the browser render the same thing and there is nothing to
  // mismatch on hydration.
  //
  // Three answers, kept apart on purpose:
  //   - a business: render it.
  //   - no business on this address (the lookup returned null): notFound(),
  //     which the router serves as HTTP 404 with the unbranded "This page
  //     isn't available" below. A wrong or renamed slug used to answer 200.
  //   - the lookup FAILED (an outage, or the viewport sweeps, whose dev
  //     server has no database behind it): `form: null`, and the browser asks
  //     again. A failure is not a 404: a link that works must not be
  //     reported as gone because a lookup timed out once.
  loader: async ({ params }) => {
    let form: SignupForm | null;
    try {
      form = await getPublicSignupForm({ data: { slug: params.slug } });
    } catch {
      return { form: null as SignupForm | null };
    }
    if (!form) throw notFound();
    return { form };
  },
  // Every branch overrides the root's HoundStack tags: the business's own
  // when it is known, neutral ones when the lookup failed, and the
  // unavailable page's for a 404 (the loader threw, so there is no data).
  head: ({ loaderData, params }) => {
    if (!loaderData) return unavailablePageHead(appOrigin());
    const org = loaderData.form;
    return bookingPageHead({
      title: customerTitle(org?.name, "Get a quote"),
      name: org?.name ?? null,
      logoUrl: org?.logoUrl ?? null,
      slug: org?.resolvedSlug ?? params.slug,
      lines: org ? org.services.map((s) => s.service_line) : [],
      origin: appOrigin(),
    });
  },
  component: SignupPage,
  notFoundComponent: SignupPageUnavailable,
});

type SignupForm = NonNullable<Awaited<ReturnType<typeof getPublicSignupForm>>>;

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
  const { form: loaded } = Route.useLoaderData();
  const embedded = useEmbedded(search.embed);
  const getForm = useServerFn(getPublicSignupForm);

  // Starts from the loader's answer, so the server's HTML is the form, not
  // "Loading…". When the loader's lookup failed this fetches as it always
  // did. SignupFlow reads the same key and gets this entry.
  const formQ = useQuery({
    queryKey: ["signup-form", slug],
    queryFn: () => getForm({ data: { slug } }),
    initialData: loaded ?? undefined,
    // Not refetched the moment it hydrates: the server answered it a
    // moment ago, and the same lookup again is a second Stripe readiness
    // check for nothing.
    staleTime: SIGNUP_FORM_STALE_MS,
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

  if (formQ.error || !formQ.data) return <Unavailable compact={embedded} />;

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
          <BusinessFacts contact={org.contact} serviceArea={org.serviceArea} />
        </div>

        <SignupFlow slug={slug} variant="page" />
      </section>
    </TenantSignupShell>
  );
}

/** Who the business is and where it works, before the first question (#526):
 *  its phone (tap to call), its email, and the ZIPs its zones list. Each
 *  hides when the owner has not set it, so a business with none of them
 *  shows exactly the headline it always did. Nothing private: the summary is
 *  built from ZIPs alone (lib/booking-page.ts), never a zone's name or price.
 *
 *  A wrapping row, not a list of fixed widths: a long email address breaks
 *  inside its own item (`break-all`) rather than widening the page at 360 px. */
function BusinessFacts({
  contact,
  serviceArea,
}: {
  contact: { phone: string | null; email: string | null };
  serviceArea: string | null;
}) {
  const tel = telHref(contact.phone);
  if (!tel && !contact.email && !serviceArea) return null;
  return (
    <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
      {serviceArea ? (
        <li className="flex min-w-0 items-center gap-1.5">
          <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{serviceArea}</span>
        </li>
      ) : null}
      {tel && contact.phone ? (
        <li className="min-w-0">
          <a
            href={tel}
            className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground touch:min-h-11"
          >
            <Phone className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span dir="ltr">{contact.phone}</span>
          </a>
        </li>
      ) : null}
      {contact.email ? (
        <li className="min-w-0">
          <a
            href={`mailto:${contact.email}`}
            className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground touch:min-h-11"
          >
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-all">{contact.email}</span>
          </a>
        </li>
      ) : null}
    </ul>
  );
}

/** A slug that names no business (HTTP 404 from the loader), or a lookup
 *  that answered nothing in the browser. Unbranded: there is no tenant to
 *  wear, and the unavailable state used to sit under a HoundStack header,
 *  the one page a prospect reaches when a tenant's link is wrong. */
function Unavailable({ compact = false }: { compact?: boolean }) {
  return (
    <TenantSignupShell orgName={null} compact={compact}>
      <div className="mx-auto max-w-2xl px-4 py-24 text-center sm:px-6">
        <h1 className="text-2xl font-semibold">This page isn't available</h1>
        <p className="mt-3 text-muted-foreground">
          Check the link with the business that sent it to you.
        </p>
      </div>
    </TenantSignupShell>
  );
}

function SignupPageUnavailable() {
  return <Unavailable />;
}
