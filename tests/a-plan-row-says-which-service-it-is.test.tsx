// #862 (onboarding QA, 2026-11-10): a new client on "Weekly scoop – 1 dog" at
// $20 read, on their Summary, "Weekly $20.00" under Active services, and
// nothing said which service that was. The Visits and Services tabs already
// named it; the Summary row labelled itself with the cadence alone
// (formatFrequency) and never read `s.services`.

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
vi.mock("@/hooks/useOrgToday", () => ({ useOrgToday: () => "2026-11-10" }));
vi.mock("@/hooks/useClientTexting", () => ({ useClientTexting: () => true }));
vi.mock("@/lib/messages.functions", () => ({ listClientMessages: vi.fn() }));

import { SummaryTab } from "@/components/client-detail/SummaryTab";

function activeServices(subscriptions: unknown[]): string {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SummaryTab
        client={{ id: "c-1", name: "QA Test Client" }}
        clientId="c-1"
        properties={[{ id: "p-1", street: "12 Elm St" }]}
        subscriptions={subscriptions as never[]}
        visits={[]}
        canBill={false}
        onGoToTab={() => undefined}
      />
    </QueryClientProvider>,
  );
  const from = html.indexOf("Active services");
  expect(from, "the Active services section did not render").toBeGreaterThan(-1);
  const to = html.indexOf("Manage services", from);
  // Tags out, entities decoded enough to read the row as a person would.
  return html
    .slice(from, to)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const weekly = {
  id: "s-1",
  status: "active",
  frequency: "weekly",
  price_cents: 2000,
  property_id: "p-1",
  started_on: "2026-11-10",
  ends_on: null,
  stay_id: null,
  service_id: "svc-1",
  services: { name: "Weekly scoop – 1 dog", service_line: "pet_waste" },
};

describe("the Summary's Active services row", () => {
  it("names the service, not only the cadence and price", () => {
    const row = activeServices([weekly]);
    expect(row).toContain("Weekly scoop – 1 dog");
  });

  it("keeps the cadence, the street and the price beside the name", () => {
    const row = activeServices([weekly]);
    expect(row).toMatch(/Weekly at 12 Elm St/);
    expect(row).toContain("$20.00");
  });

  it("names the seeded pet-waste service the way the Services tab does", () => {
    const row = activeServices([
      { ...weekly, services: { name: "Pet waste removal", service_line: "pet_waste" } },
    ]);
    expect(row).toContain("Recurring pet waste removal");
  });
});
