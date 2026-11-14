import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { DirectoryShell } from "@/components/directory/DirectoryShell";
import { RedirectFallback } from "@/components/RedirectFallback";
import { Button } from "@/components/ui/button";
import { directoryHead } from "@/lib/directory";
import { DIRECTORY_BRAND, directoryOrigin } from "@/lib/directory-site";
import {
  resolveDirectoryBooking,
  type DirectoryBookingAnswer,
} from "@/lib/directory-booking.functions";
import { pageTitle } from "@/lib/page-title";

// The directory's booking hand-off (#630, directory v2 step 7):
//
//   /d/{directory slug}/book?service=<booking_key>&zip=<ZIP>[&return=<url>]
//
// The directory app links here from a listing that says "Book online". The
// server resolves the DIRECTORY slug (never the business's own booking slug,
// which the directory never sees) and sends the visitor on to the business's
// booking link with the service and ZIP filled in and ref set, so whatever
// they book, or ask for, lands in Leads as a directory booking. Whether that
// link may take a card is the listing's answer (book=1), and anything short
// of "this service can be sold right now" is the quote request instead:
// see lib/directory-booking.functions.ts for every way it fails safe.
//
// A 302 from the loader on the server, so a link opens straight onto the
// form. A listing that is not published says so here, with a way back.

type Search = { service?: string; zip?: unknown; return?: unknown };

export const Route = createFileRoute("/d/$slug/book")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    service: typeof s.service === "string" ? s.service : undefined,
    zip: s.zip,
    return: s.return,
  }),
  loaderDeps: ({ search }) => ({ service: search.service, zip: search.zip, ret: search.return }),
  loader: async ({ params, deps }) => {
    let answer: DirectoryBookingAnswer;
    try {
      answer = await resolveDirectoryBooking({
        data: { slug: params.slug, service: deps.service ?? null, zip: deps.zip, returnTo: deps.ret },
      });
    } catch {
      // The lookup itself failed: the directory's own quote form, never a
      // charge and never a blank page.
      answer = { kind: "go", href: `/pros/${encodeURIComponent(params.slug)}/quote` };
    }
    if (answer.kind === "go") throw redirect({ href: answer.href, statusCode: 302 });
    return { answer };
  },
  head: ({ params }) =>
    directoryHead({
      title: pageTitle("Book online", DIRECTORY_BRAND),
      description: "Book online with a business listed in HoundStack's directory.",
      path: `/d/${encodeURIComponent(params.slug)}/book`,
      origin: directoryOrigin(),
    }),
  component: DirectoryBookingPage,
});

function DirectoryBookingPage() {
  const { slug } = Route.useParams();
  const data = Route.useLoaderData();
  // Reached only if the redirect did not happen during load (see
  // RedirectFallback): carry on to the directory's quote form.
  if (!data) {
    return (
      <RedirectFallback to={`/pros/${encodeURIComponent(slug)}/quote`} label="the quote form" />
    );
  }
  const back = data.answer.kind === "unavailable" ? data.answer.back : null;
  return (
    <DirectoryShell>
      <div className="mx-auto max-w-xl space-y-4 py-12 text-center" data-directory-booking-unavailable>
        <h1 className="text-2xl font-semibold break-words">
          This business isn't taking bookings here right now
        </h1>
        <p className="text-muted-foreground">
          It may have left the directory, or the link may be out of date. Nothing was charged.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {back ? (
            <Button asChild className="min-h-11">
              <a href={back}>Back to {DIRECTORY_BRAND}</a>
            </Button>
          ) : null}
          <Button asChild variant="outline" className="min-h-11">
            <Link to="/pros">Search the directory</Link>
          </Button>
        </div>
      </div>
    </DirectoryShell>
  );
}
