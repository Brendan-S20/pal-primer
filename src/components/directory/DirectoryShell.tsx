import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Logo } from "@/components/Logo";
import { PublicFooter } from "@/components/PublicFooter";
import { DIRECTORY_DISCLOSURE } from "@/lib/directory";
import { DIRECTORY_BRAND } from "@/lib/directory-site";

/**
 * The frame of every directory page (#630): HoundStack's mark linking back to
 * the search, the page, and the disclosure that every listed business is a
 * HoundStack customer. The disclosure is part of the shell rather than each
 * page so no directory page can be drawn without it.
 *
 * Wider than PublicShell (which is a 28rem sign-in card): a results list and
 * a three-way compare need the room at 1280 and 1920, and collapse to one
 * column on a phone.
 */
export function DirectoryShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link
            to="/pros"
            className="inline-flex min-h-11 min-w-0 items-center gap-3"
            aria-label={`${DIRECTORY_BRAND}, by HoundStack: search`}
          >
            <Logo variant="landscape" className="h-7 shrink-0 text-primary" />
            <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
              {DIRECTORY_BRAND}
            </span>
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p
          className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground"
          data-directory-disclosure
        >
          {DIRECTORY_DISCLOSURE}
        </p>
        <PublicFooter />
      </div>
    </div>
  );
}
