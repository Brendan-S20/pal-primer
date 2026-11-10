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
      <OperatorIdentity className="mx-auto mt-3 max-w-xl" />
      <p className="mt-2">
        © {new Date().getFullYear()} {APP_NAME}. All rights reserved.
      </p>
    </footer>
  );
}

/**
 * Who operates HoundStack, with a contact address on the same domain. Twilio
 * rejected the toll-free verification for 30482 (contact email not on the
 * business domain) and 30474 (end-business details), and its reviewers check
 * the public site for exactly this sentence. It must match the filing word for
 * word, so it lives in one place: this footer and the top of every /legal page.
 * No phone number, deliberately.
 */
export function OperatorIdentity({ className }: { className?: string }) {
  return (
    <p className={className}>
      {APP_NAME} is operated by The North Consulting LLC, 2222 West Grand River Avenue STE A,
      Okemos, MI 48864. Contact:{" "}
      <a href="mailto:support@houndstack.com" className="underline hover:text-foreground">
        support@houndstack.com
      </a>
    </p>
  );
}
