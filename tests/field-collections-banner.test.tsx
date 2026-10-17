import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/field-collections.functions", () => ({
  listFieldCollections: vi.fn(),
  confirmFieldCollectionUnapplied: vi.fn(),
  rejectFieldCollection: vi.fn(),
}));
vi.mock("@/lib/invoices.functions", () => ({ bulkMarkInvoicesPaid: vi.fn() }));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgTimezone: () => "America/Chicago" }));

import { FieldCollectionsCard } from "@/components/FieldCollectionsCard";

const pending = { id: "pending", status: "awaiting_confirmation", amount_cents: 4000 };
const confirmed = { id: "confirmed", status: "confirmed", amount_cents: 2500 };

function render(collections: object[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["field-collections"], { collections });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}><FieldCollectionsCard /></QueryClientProvider>,
  );
}

describe("the field collections banner", () => {
  it("summarizes waiting money with details folded", () => {
    const html = render([pending, confirmed, { ...pending, id: "second", amount_cents: 1500 }]);
    expect(html).toContain("2 waiting · $55.00");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="field-collections-body"');
    expect(html).toContain(">Review</button>");
    expect(html).not.toContain('id="field-collections-body"');
    expect(html).not.toContain("Confirm and apply");
  });

  it("offers recent collections when nothing is waiting", () => {
    const html = render([confirmed]);
    expect(html).toContain("Nothing waiting");
    expect(html).toContain("Show recent");
  });

  it("draws nothing for an empty list", () => {
    expect(render([])).toBe("");
  });
});
