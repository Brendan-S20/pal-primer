import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Logo } from "@/components/Logo";
import { PublicFooter } from "@/components/PublicFooter";
import { DIRECTORY_DISCLOSURE } from "@/lib/directory";
import { DIRECTORY_BRAND } from "@/lib/directory-site";
import { DIRECTORY_LOCKUP } from "@/lib/directory-brand";

/**
 * The frame of every directory page (#630): the directory's own mark linking
 * back to the search, the page, and the disclosure that every listed business
 * is a HoundStack customer. The disclosure is part of the shell rather than
 * each page so no directory page can be drawn without it.
 *
 * Branded as the directory (#898): logo A's cream lockup in the header and
 * the footer, Paw Trail colours and type through [data-directory-brand] (see
 * src/styles.css). HoundStack appears once, in the footer, as "powered by".
 * The lockup's wordmark is outlined artwork, so the header never re-sets the
 * name in CSS; the <img> alt is the name.
 *
 * Wider than PublicShell (which is a 28rem sign-in card): a results list and
 * a three-way compare need the room at 1280 and 1920, and collapse to one
 * column on a phone.
 */
export function DirectoryShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground" data-directory-brand>
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link
            to="/pros"
            className="inline-flex min-h-11 min-w-0 items-center"
            aria-label={`${DIRECTORY_BRAND}: search`}
            data-directory-lockup
          >
            <DirectoryLockup className="h-7 sm:h-8" />
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p
          className="rounded-lg border bg-muted p-4 text-sm text-muted-foreground"
          data-directory-disclosure
        >
          {DIRECTORY_DISCLOSURE}
        </p>
        <div className="mt-10 flex flex-col items-center gap-3 border-t pt-8 text-center">
          <DirectoryLockup className="h-7" />
          <p className="text-sm text-muted-foreground">Good local pet care, easy to find.</p>
          <a
            href="https://houndstack.com"
            className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-muted-foreground hover:text-foreground"
            data-directory-powered-by
          >
            <span className="text-xs font-semibold">powered by</span>
            <Logo variant="landscape" className="h-5 shrink-0 text-foreground" />
            <span className="sr-only">HoundStack</span>
          </a>
        </div>
        <PublicFooter />
      </div>
    </div>
  );
}

/** Logo A, cream lockup, sized by height. Width and height attributes
 *  reserve its box before the file arrives. */
function DirectoryLockup({ className }: { className?: string }) {
  return (
    <img
      src={DIRECTORY_LOCKUP.src}
      alt={DIRECTORY_LOCKUP.alt}
      width={DIRECTORY_LOCKUP.width}
      height={DIRECTORY_LOCKUP.height}
      className={`w-auto max-w-full shrink-0 ${className ?? ""}`}
      decoding="async"
    />
  );
}
