// #930: the Clients texting consent notice told every business without
// texting that texting was "coming soon". Managed texting is on sale, and
// Settings > Texting signs a business up today, so a business that has not
// set it up is told to set it up, with a link there. A business whose
// texting is on reads exactly what it read before.

import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const availability = vi.hoisted(() => ({ live: false }));
vi.mock("@/hooks/useClientTexting", () => ({ useClientTexting: () => availability.live }));
vi.mock("@/hooks/useMyRole", () => ({ useMyRole: () => ({ orgId: "org-test" }) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) =>
    createElement("a", { href: to, className }, children),
}));
vi.mock("@/lib/clients.functions", () => ({ getSmsConsentCoverage: vi.fn() }));

import { SmsConsentBanner } from "@/components/SmsConsentBanner";

function banner(texting: boolean) {
  availability.live = texting;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["sms-consent-coverage"], { withPhone: 160, consented: 1 });
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(SmsConsentBanner)),
    );
  } finally {
    client.clear();
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'");

describe("texting not set up for this business", () => {
  const html = banner(false);

  it("says to set texting up, not that it is coming", () => {
    expect(text(html)).toContain(
      "159 of 160 clients with a phone number have no texting consent on file, so they won't get texts once you set up texting.",
    );
    expect(html).not.toMatch(/coming soon/i);
    expect(html).not.toMatch(/arrives/i);
  });

  it("links to Settings > Texting", () => {
    expect(html).toMatch(/<a href="\/settings\/sms"[^>]*>Set up texting<\/a>/);
  });
});

describe("texting on", () => {
  const html = banner(true);

  it("keeps the wording it had", () => {
    expect(text(html)).toContain(
      "159 of 160 clients with a phone number have no texting consent on file, so reminders and notifications will not reach them.",
    );
    expect(html).not.toContain("/settings/sms");
    expect(html).not.toMatch(/set up texting/i);
  });
});

it("both states keep the what-to-do line", () => {
  for (const html of [banner(false), banner(true)]) {
    expect(text(html)).toContain("Ask them to opt in from their portal");
  }
});
