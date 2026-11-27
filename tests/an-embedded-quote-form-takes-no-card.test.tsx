// The embedded form (/signup/{slug}?embed=1, inside an iframe on the
// business's own site) is usually a quote request that takes no card. Its
// footer said "Payments processed securely by Stripe" anyway. On the owner's
// word (2026-11-27) the embed's footer instead says "Powered by HoundStack",
// linked to houndstack.com, the line every email sent as a business ends
// with. The full page, which can take a card, keeps the Stripe line. Both
// keep Privacy, Terms and SMS Consent: the page collects a phone number.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { TenantSignupShell } from "@/components/marketing/TenantSignupShell";
import { formatPhone } from "@/lib/format";
import { notePlaceholderBesideAccess, requestPanelHint, BOOKING_COPY } from "@/lib/booking-copy";

function shell(compact: boolean) {
  return renderToStaticMarkup(
    <TenantSignupShell orgName="Detroit Doo Disposal" compact={compact}>
      <p>form</p>
    </TenantSignupShell>,
  );
}

describe("the embedded quote form's footer", () => {
  const html = shell(true);

  it("says Powered by HoundStack, linked to houndstack.com, and not Stripe", () => {
    expect(html).not.toMatch(/Stripe/);
    expect(html).toMatch(
      /Powered by\s*<a[^>]*href="https:\/\/houndstack\.com"[^>]*>HoundStack<\/a>/,
    );
    expect(html).toContain("Detroit Doo Disposal");
  });

  it("keeps Privacy, Terms and SMS Consent", () => {
    for (const to of ["/legal/privacy", "/legal/terms", "/legal/sms"]) {
      expect(html).toContain(`href="${to}"`);
    }
  });
});

describe("the full signup page, which can take a card", () => {
  const html = shell(false);

  it("keeps the Stripe line and names no HoundStack", () => {
    expect(html).toContain("Payments processed securely by Stripe");
    expect(html).not.toMatch(/houndstack\.com/);
  });
});

describe("what the embed shows around the form", () => {
  it("a stored 11-digit number reads as a US number", () => {
    expect(formatPhone("17343017232")).toBe("(734) 301-7232");
  });

  it("the gate code is not asked for twice, and the panel is not the intro again", () => {
    expect(notePlaceholderBesideAccess("pet_waste")).not.toMatch(/gate/i);
    expect(requestPanelHint("pet_waste")).not.toBe(BOOKING_COPY.pet_waste.intro);
  });
});
