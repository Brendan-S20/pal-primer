import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { reachTheBusinessSentence } from "@/lib/booking-details";

// A made-up number, stored the way an owner types it with no punctuation.
const state = vi.hoisted(() => ({ phone: "17345550142" as string | null }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    options,
    useParams: () => ({ slug: "acme", token: "t" }),
  }),
  Link: ({ children }: { children?: ReactNode }) => createElement("a", null, children),
  Outlet: () => null,
  useRouterState: () => "/portal/acme/t/visits",
}));
vi.mock("@/components/PushToggle", () => ({ PushToggle: () => null }));
vi.mock("@/lib/page-title", () => ({
  customerTitle: (title: string) => title,
  useDocumentTitle: () => {},
}));
vi.mock("@/lib/portal-ui", () => ({
  PortalProvider: ({ children }: { children?: ReactNode }) => children,
  PortalVerifyGate: () => null,
  PortalDeadEnd: () => null,
  money: (cents: number) => `$${cents / 100}`,
  isHex: () => false,
  usePortalCtx: () => ({
    token: "t",
    slug: "acme",
    verified: true,
    contextQ: { isLoading: false, data: { valid: true, textsLive: true } },
    clientQ: {
      isLoading: false,
      error: null,
      data: {
        org_name: "Acme Scoop Co.",
        display_name: "Sam Sample",
        credit_balance_cents: 0,
        contact_phone: state.phone,
        contact_email: null,
      },
    },
  }),
}));

import { Route } from "@/routes/portal.$slug.$token";

const portal = () =>
  renderToStaticMarkup(
    createElement(
      (Route as unknown as { options: { component: ComponentType } }).options.component,
    ),
  );

describe("the thank-you page's way to reach the business", () => {
  it("formats an unpunctuated US number", () => {
    expect(reachTheBusinessSentence("17345550142", null)).toBe(
      "Questions before then? Call (734) 555-0142.",
    );
    expect(reachTheBusinessSentence(" 7345550142 ", "hi@acme.test")).toBe(
      "Questions before then? Call (734) 555-0142 or email hi@acme.test.",
    );
  });

  it("leaves a number that is not a 10-digit US one as typed", () => {
    expect(reachTheBusinessSentence("+44 20 7946 0958", null)).toBe(
      "Questions before then? Call +44 20 7946 0958.",
    );
  });
});

describe("the client portal's contact footer", () => {
  it("shows the number formatted and keeps the tel: and sms: links as stored", () => {
    state.phone = "17345550142";
    const html = portal();
    expect(html).toContain('<span dir="ltr">(734) 555-0142</span>');
    expect(html).toContain('href="tel:17345550142"');
    expect(html).toContain('href="sms:17345550142"');
    expect(html).not.toContain(">17345550142<");
  });

  it("shows no phone link when the business has no number", () => {
    state.phone = null;
    const html = portal();
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("sms:");
  });
});
