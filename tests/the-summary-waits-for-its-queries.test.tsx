// #1020: on a reload the Summary tab raised "no dog is on file" and said
// "Nothing scheduled" for about a second, before the dogs and visits queries
// had answered. Neither message may appear while its query is pending.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-start")>()),
  useServerFn: (f: unknown) => f,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: {} },
  isImpersonationTab: () => false,
}));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgToday: () => "2026-11-24" }));
vi.mock("@/hooks/useClientTexting", () => ({ useClientTexting: () => true }));
vi.mock("@/lib/messages.functions", () => ({ listClientMessages: vi.fn() }));

import { SummaryTab } from "@/components/client-detail/SummaryTab";

const plan = {
  id: "s-1",
  status: "active",
  frequency: "weekly",
  price_cents: 2500,
  property_id: "p-1",
  started_on: "2026-11-01",
  ends_on: null,
  stay_id: null,
  account_type: "residential",
  dog_count: 1,
  services: { name: "Pet waste removal", service_line: "pet_waste" },
};

function render(over: { dogs?: unknown[]; visits?: unknown[]; dogsLoading?: boolean; visitsLoading?: boolean }) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SummaryTab
        client={{ id: "c-1", name: "QA" }}
        clientId="c-1"
        properties={[{ id: "p-1", street: "12 Elm St", boundary: {} }]}
        subscriptions={[plan] as never[]}
        visits={(over.visits ?? []) as never[]}
        dogs={(over.dogs ?? []) as never[]}
        dogsLoading={over.dogsLoading}
        visitsLoading={over.visitsLoading}
        canBill={false}
        onGoToTab={() => undefined}
      />
    </QueryClientProvider>,
  );
}

describe("the Summary tab while its queries are pending", () => {
  it("raises no 'no dog is on file' warning while the dogs query is pending", () => {
    expect(render({ dogsLoading: true })).not.toContain("no dog is on file");
  });

  it("still raises it once the dogs have loaded and there are none", () => {
    expect(render({ dogsLoading: false })).toContain("no dog is on file");
  });

  it("says neither 'Nothing scheduled' nor 'No past visits yet' while visits are pending", () => {
    const html = render({ visitsLoading: true });
    expect(html).not.toContain("Nothing scheduled");
    expect(html).not.toContain("No past visits yet");
  });

  it("says 'Nothing scheduled' once the visits have loaded and there are none", () => {
    expect(render({ visitsLoading: false })).toContain("Nothing scheduled");
  });
});
