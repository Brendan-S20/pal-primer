import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

// The public signup pages wear the TENANT's brand, not ours.
//
// ── WHAT THIS REPLACES, AND WHY IT WAS WRONG ──────────────────────────────
//
// /signup/{slug} and /signup/success were wrapped in `MarketingLayout`, which
// is HoundStack's own shell: our wordmark linking to houndstack.com in the
// header, a "Sign in" link into the staff app, and houndstack.com again in the
// footer. Every one of those is correct for the pages MarketingLayout was
// written for — this app's own marketing surfaces — and wrong for these two.
//
// A prospect on /signup/{slug} arrived from a tenant's website, is about to
// hand a card to that tenant, and was shown a different company's name at the
// top of the page and offered a link away to it mid-purchase. It also invites
// the obvious support call: "I signed up with HoundStack, why is Bark Busters
// charging me?" The tenant's own customers are not our audience, and their
// funnel is not a place to advertise.
//
// The hosted lead form at /lead/{slug} already got this right — it renders the
// tenant's logo and accent colour and nothing of ours — so this is that shape,
// factored out for the two signup routes that share it. The branding now comes
// back from `public_get_org_by_slug` (migration 20260809001000) so the page can
// paint it from the one lookup it already makes.
//
// ── WHAT IS DELIBERATELY NOT HERE, AND WHAT IS ────────────────────────────
//
// Gone: the wordmark, the link to houndstack.com, and the "Sign in" link into
// the staff app. MarketingLayout carried those because its visitor is a
// prospective TENANT; this visitor is a homeowner buying yard cleanup, for whom
// each of them is either a dead end or a way out of the checkout they are in
// the middle of. That layout had no other caller once these two routes stopped
// using it, so it was deleted rather than left compiled and unreachable.
//
// Kept: Privacy, Terms, and SMS Consent. This is a page that takes a card AND
// collects a phone number, and PublicFooter's own docstring is explicit that
// Twilio's toll-free verification reviewers look for privacy and SMS
// consent/opt-out disclosures linked from the pages where phone numbers are
// collected. MarketingLayout's footer was carrying that duty for /signup/{slug}
// as a side effect of being the layout; dropping the branding and the
// compliance links in the same edit would have quietly taken a phone-collecting
// public page out of compliance. Also kept: that Stripe handles the card, which
// is reassurance the buyer actually wants, and which the payment form says
// again next to the button.
export function TenantSignupShell({
  orgName,
  logoUrl,
  brandColor,
  children,
}: {
  orgName: string | null;
  logoUrl?: string | null;
  brandColor?: string | null;
  children: ReactNode;
}) {
  // Falls back to the app's own primary token rather than a hardcoded colour,
  // so a tenant who has set no brand colour gets the product's palette instead
  // of a stripe of some arbitrary blue.
  const accent = brandColor || "var(--primary)";
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="h-1.5 w-full" style={{ backgroundColor: accent }} />
      <header className="border-b border-border/60 bg-background/75 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4">
          {logoUrl ? (
            <img src={logoUrl} alt={orgName ?? ""} className="h-9 max-w-[180px] object-contain" />
          ) : null}
          {orgName ? (
            <span className="text-base font-semibold tracking-tight" style={{ color: accent }}>
              {orgName}
            </span>
          ) : null}
        </div>
      </header>
      <main>{children}</main>
      <footer className="mt-16 border-t bg-muted/30">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground">
          <div>
            © {new Date().getFullYear()} {orgName ?? ""} · Payments processed securely by Stripe
          </div>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link to="/legal/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link to="/legal/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link to="/legal/sms" className="hover:text-foreground">
              SMS Consent
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
