import type { ReactNode } from "react";
import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { Logo } from "@/components/Logo";
import { PublicFooter } from "@/components/PublicFooter";
import { nativeTopBarStyle } from "@/lib/native-build";

/**
 * Shared layout for the public legal pages (/legal/*). Long-form prose on a
 * plain background, the landscape logo up top, and the compliance footer.
 * These pages must stay publicly reachable with no sign-in: Twilio's
 * toll-free verification reviewers (and carriers) visit them directly.
 */
export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  // A person who opens the privacy policy from the sign-in card has to be able
  // to get back to it. On the phone the old header was a 14px "Sign in" link in
  // the top right, under the status bar, with no inset -- reported as "it isn't
  // optimized on my device to go back to sign-in", which is exactly right.
  //
  // Back where there IS history, sign-in where there is not: these pages are
  // also opened cold by Twilio's verification reviewers and by carriers, who
  // arrive with nothing to go back to.
  const router = useRouter();
  const canGoBack = useCanGoBack();

  return (
    <div className="min-h-screen bg-background">
      <header
        // Same safe-area treatment as the app's own top bar, which is what
        // "consistent with the rest of the app" means here: paddingTop inline
        // because nothing sets py on this element, and the horizontal insets
        // in the className so they EXTEND px-4 rather than replace it.
        style={nativeTopBarStyle()}
        className="sticky top-0 z-20 border-b bg-card/80 backdrop-blur"
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] py-2">
          {canGoBack ? (
            <button
              type="button"
              onClick={() => router.history.back()}
              // 44px, per the working agreement. The glyph is 16px; the BUTTON
              // is the touch target.
              className="-ml-2 inline-flex min-h-11 min-w-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              <ChevronLeft className="h-5 w-5 shrink-0" />
              Back
            </button>
          ) : (
            <Link
              to="/auth"
              className="-ml-2 inline-flex min-h-11 min-w-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted"
            >
              <ChevronLeft className="h-5 w-5 shrink-0" />
              Sign in
            </Link>
          )}

          {/* min-w-0: at 320px "Sign in" (now shrink-0, so its label stays
              inside its box) and the 233px wordmark do not both fit, and it
              is the wordmark that gives. Logo is max-w-full, so it scales
              down inside a narrower link instead of running off the side.
              Before, the link was the one shrinking, with its label drawn
              out under the logo. */}
          <Link to="/auth" aria-label="HoundStack home" className="min-w-0 text-primary">
            <Logo variant="landscape" className="h-7" />
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl pl-[calc(1.5rem+env(safe-area-inset-left))] pr-[calc(1.5rem+env(safe-area-inset-right))] py-10 pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
        <h1 className="text-3xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Last updated: {updated}</p>
        <div className="mt-8 space-y-8 text-[15px] leading-relaxed [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-medium [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6">
          {children}
        </div>
        <PublicFooter />
      </main>
    </div>
  );
}
