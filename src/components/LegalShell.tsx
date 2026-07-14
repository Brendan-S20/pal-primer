import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Logo } from "@/components/Logo";
import { PublicFooter } from "@/components/PublicFooter";

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
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/60">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/auth" aria-label="HoundStack home" className="text-primary">
            <Logo variant="landscape" className="h-7" />
          </Link>
          <Link to="/auth" className="text-sm text-muted-foreground hover:text-foreground">
            Sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">
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
