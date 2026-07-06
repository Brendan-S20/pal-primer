import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { APP_NAME } from "@/lib/scoop";

export function MarketingLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/75 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-brand-foreground shadow-sm">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path d="M8 4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm8 0a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM4.5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm15 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-7.5 2c2.8 0 5 2.1 5 4.6 0 1.6-1.2 2.9-2.8 2.9-1.1 0-1.6-.5-2.2-.5s-1.1.5-2.2.5C8.2 19.5 7 18.2 7 16.6 7 14.1 9.2 12 12 12Z" />
              </svg>
            </span>
            {APP_NAME}
          </Link>
          <nav className="hidden gap-8 text-sm text-muted-foreground md:flex">
            <Link to="/services" activeProps={{ className: "text-foreground font-medium" }} className="hover:text-foreground transition">
              Services
            </Link>
            <Link to="/pricing" activeProps={{ className: "text-foreground font-medium" }} className="hover:text-foreground transition">
              Pricing
            </Link>
            <Link to="/about" activeProps={{ className: "text-foreground font-medium" }} className="hover:text-foreground transition">
              About
            </Link>
            <Link to="/contact" activeProps={{ className: "text-foreground font-medium" }} className="hover:text-foreground transition">
              Contact
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/auth" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">
              Sign in
            </Link>
            <Link
              to="/contact"
              className="hidden rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm hover:opacity-90 transition sm:inline-block"
            >
              Get a demo
            </Link>
            <button
              type="button"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md border md:hidden"
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
        {open && (
          <div className="border-t bg-background md:hidden">
            <nav className="mx-auto flex max-w-6xl flex-col px-6 py-3 text-sm">
              <Link to="/services" onClick={close} className="py-2 hover:text-foreground">Services</Link>
              <Link to="/pricing" onClick={close} className="py-2 hover:text-foreground">Pricing</Link>
              <Link to="/about" onClick={close} className="py-2 hover:text-foreground">About</Link>
              <Link to="/contact" onClick={close} className="py-2 hover:text-foreground">Contact</Link>
              <Link to="/auth" onClick={close} className="py-2 hover:text-foreground">Sign in</Link>
              <Link
                to="/contact"
                onClick={close}
                className="mt-2 rounded-full bg-brand px-4 py-2 text-center font-medium text-brand-foreground"
              >
                Get a demo
              </Link>
            </nav>
          </div>
        )}
      </header>
      <main>{children}</main>
      <footer className="mt-24 border-t bg-muted/30">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-brand text-brand-foreground">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden><path d="M8 4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm8 0a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM4.5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm15 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-7.5 2c2.8 0 5 2.1 5 4.6 0 1.6-1.2 2.9-2.8 2.9-1.1 0-1.6-.5-2.2-.5s-1.1.5-2.2.5C8.2 19.5 7 18.2 7 16.6 7 14.1 9.2 12 12 12Z" /></svg>
              </span>
              {APP_NAME}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Field-service software built for pet waste removal companies.
            </p>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-foreground">Product</div>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link to="/services" className="hover:text-foreground">Services</Link></li>
              <li><Link to="/pricing" className="hover:text-foreground">Pricing</Link></li>
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-foreground">Company</div>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link to="/about" className="hover:text-foreground">About</Link></li>
              <li><Link to="/contact" className="hover:text-foreground">Contact</Link></li>
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-foreground">Get started</div>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link to="/contact" className="hover:text-foreground">Book a demo</Link></li>
              <li><Link to="/auth" className="hover:text-foreground">Sign in</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 text-xs text-muted-foreground">
            <div>© {new Date().getFullYear()} {APP_NAME}. All rights reserved.</div>
            <div>Made for scoop operators.</div>
          </div>
        </div>
      </footer>
    </div>
  );
}
