// #930: the Clients texting consent notice told every business without
// texting that texting was "coming soon". Managed texting is on sale, so the
// notice now says where THIS business stands, in the words every other
// texting screen uses (lib/managed-texting), and offers a link only to a page
// the person reading may open. A business whose texting is on reads exactly
// what it read before.

import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ManagedTextingState } from "@/lib/managed-texting";
import type { AppRole } from "@/hooks/useMyRole";

const world = vi.hoisted(() => ({
  live: false,
  state: undefined as ManagedTextingState | undefined,
  role: "owner" as AppRole | null,
}));
vi.mock("@/hooks/useClientTexting", () => ({ useClientTexting: () => world.live }));
vi.mock("@/hooks/useTextingState", () => ({ useTextingState: () => world.state }));
vi.mock("@/hooks/useMyRole", async (importActual) => ({
  ...(await importActual<typeof import("@/hooks/useMyRole")>()),
  useMyRole: () => ({ orgId: "org-test", role: world.role }),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) =>
    createElement("a", { href: to, className }, children),
}));
vi.mock("@/lib/clients.functions", () => ({ getSmsConsentCoverage: vi.fn() }));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));

import { SmsConsentBanner } from "@/components/SmsConsentBanner";
import { consentGapCopy } from "@/lib/sms-consent-gap";

function banner(state: ManagedTextingState | undefined, role: AppRole = "owner") {
  world.live = state === "active";
  world.state = state;
  world.role = role;
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
const LEAD = "159 of 160 clients with a phone number have no texting consent on file, ";

describe("texting on", () => {
  it("keeps the wording it had, with no link", () => {
    const html = banner("active");
    expect(text(html)).toContain(`${LEAD}so reminders and notifications will not reach them.`);
    expect(html).not.toContain("<a ");
  });
});

describe("the add-on is on the plan, details not sent (needs_details)", () => {
  it("an owner is told to set it up, and linked to Settings > Texting", () => {
    const html = banner("needs_details");
    expect(text(html)).toContain(`${LEAD}so they won't get texts once you set up texting.`);
    expect(html).toMatch(/<a href="\/settings\/sms"[^>]*>Set up texting<\/a>/);
  });

  it("an office manager gets the same link", () => {
    expect(banner("needs_details", "office_manager")).toContain('href="/settings/sms"');
  });
});

describe("the add-on is not on the plan (not_added)", () => {
  it("an owner is linked to Plan & billing, where the add-on is", () => {
    const html = banner("not_added");
    expect(text(html)).toContain("so they won't get texts once you set up texting.");
    expect(html).toMatch(/<a href="\/settings\/billing"[^>]*>Set up texting<\/a>/);
    expect(html).not.toContain("/settings/sms");
  });

  it("an office manager, who cannot open Plan & billing, gets no link", () => {
    const html = banner("not_added", "office_manager");
    expect(text(html)).toContain(
      "so they won't get texts once texting is set up for your business.",
    );
    expect(html).not.toContain("<a ");
  });
});

describe("submitted and waiting (under_review)", () => {
  it("says Under review in the shared words, with nothing to set up", () => {
    const html = banner("under_review");
    expect(text(html)).toContain(
      `${LEAD}so they won't get texts yet. Texting your clients is under review, usually ready shortly.`,
    );
    expect(html).not.toMatch(/set up/i);
    expect(html).not.toContain("<a ");
  });
});

describe("rejected or stopped (needs_attention)", () => {
  it("says it needs attention and links an owner to Settings > Texting", () => {
    const html = banner("needs_attention");
    expect(text(html)).toContain(
      "so they won't get texts yet. Your texting setup needs attention.",
    );
    expect(html).toMatch(/<a href="\/settings\/sms"[^>]*>Open Texting settings<\/a>/);
  });
});

describe("loading or unreadable", () => {
  it("says nothing about setup, so a live business never flashes Set up texting", () => {
    const html = banner(undefined);
    expect(text(html)).toContain(`${LEAD}so they won't get texts.`);
    expect(html).not.toMatch(/set up|under review|attention/i);
    expect(html).not.toContain("<a ");
  });
});

describe("a dispatcher, who can read /clients but not Settings", () => {
  it.each(["needs_details", "not_added", "needs_attention"] as const)(
    "%s: no link, and nothing asks them to act",
    (state) => {
      const html = banner(state, "dispatcher");
      expect(html).not.toContain("<a ");
      expect(text(html)).not.toMatch(/once you set up/i);
    },
  );

  it("needs_details reads as a fact about the business", () => {
    expect(text(banner("needs_details", "dispatcher"))).toContain(
      "so they won't get texts once texting is set up for your business.",
    );
  });
});

it("no state says texting is coming", () => {
  const states = [
    undefined,
    "not_added",
    "needs_details",
    "under_review",
    "needs_attention",
    "active",
  ] as const;
  for (const state of states) {
    for (const role of ["owner", "office_manager", "dispatcher"] as const) {
      const c = consentGapCopy({ texting: state === "active", state, role });
      expect(c.text, `${state} ${role}`).not.toMatch(/coming soon|arrives/i);
      if (c.link) expect(c.link.to, `${state} ${role}`).toMatch(/^\/settings\/(sms|billing)$/);
    }
  }
});

it("every state keeps the what-to-do line", () => {
  for (const state of [undefined, "not_added", "under_review", "active"] as const) {
    expect(text(banner(state))).toContain("Ask them to opt in from their portal");
  }
});
