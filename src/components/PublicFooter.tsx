import { Link } from "@tanstack/react-router";
import { APP_NAME } from "@/lib/scoop";

/**
 * Compliance footer for public pages (/auth, /sign-up, /get-started, legal
 * pages, marketing). Twilio toll-free verification reviewers look for a
 * public privacy policy and SMS consent/opt-out disclosures linked from the
 * pages where phone numbers are collected; this is that link row.
 */
export function PublicFooter() {
  return (
    <footer className="mt-10 pb-6 text-center text-xs text-muted-foreground">
      <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        <Link to="/legal/privacy" className="hover:text-foreground hover:underline">
          Privacy Policy
        </Link>
        <Link to="/legal/terms" className="hover:text-foreground hover:underline">
          Terms of Service
        </Link>
        <Link to="/legal/sms" className="hover:text-foreground hover:underline">
          SMS Consent
        </Link>
        <Link to="/legal/sms" hash="opt-out" className="hover:text-foreground hover:underline">
          Opt out of texts
        </Link>
        <a href="https://houndstack.com" className="hover:text-foreground hover:underline">
          houndstack.com
        </a>
      </nav>
      <p className="mt-2">
        © {new Date().getFullYear()} {APP_NAME}. All rights reserved.
      </p>
    </footer>
  );
}
