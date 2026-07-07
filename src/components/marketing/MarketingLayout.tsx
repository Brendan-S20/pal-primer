import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/scoop";
import { Logo } from "@/components/Logo";

// Minimal shell used by the signup flow. The public marketing site is hosted
// separately (houndstack.com); this app lives at app.houndstack.com and only
// exposes signup, portal, and auth surfaces publicly.
export function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 bg-background/75 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <a
            href="https://houndstack.com"
            aria-label={APP_NAME}
            className="text-primary"
          >
            <Logo variant="logo" className="h-8 w-auto" />
          </a>
          <Link
            to="/auth"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main>{children}</main>
      <footer className="mt-24 border-t bg-muted/30">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 text-xs text-muted-foreground">
          <div>
            © {new Date().getFullYear()} {APP_NAME}
          </div>
          <a href="https://houndstack.com" className="hover:text-foreground">
            houndstack.com
          </a>
        </div>
      </footer>
    </div>
  );
}
