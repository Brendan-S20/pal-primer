import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { APP_NAME } from "@/lib/scoop";

export function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            {APP_NAME}
          </Link>
          <nav className="hidden gap-6 text-sm text-muted-foreground md:flex">
            <Link to="/services" activeProps={{ className: "text-foreground font-medium" }}>
              Services
            </Link>
            <Link to="/pricing" activeProps={{ className: "text-foreground font-medium" }}>
              Pricing
            </Link>
            <Link to="/about" activeProps={{ className: "text-foreground font-medium" }}>
              About
            </Link>
            <Link to="/contact" activeProps={{ className: "text-foreground font-medium" }}>
              Contact
            </Link>
          </nav>
          <div className="flex items-center gap-3">
            <Link to="/auth" className="text-sm text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
            <Link
              to="/contact"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Get a demo
            </Link>
          </div>
        </div>
      </header>
      <main>{children}</main>
      <footer className="mt-24 border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>© {new Date().getFullYear()} {APP_NAME}. All rights reserved.</div>
          <nav className="flex gap-4">
            <Link to="/services">Services</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/about">About</Link>
            <Link to="/contact">Contact</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
