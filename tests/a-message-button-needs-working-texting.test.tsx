import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const availability = vi.hoisted(() => ({ live: false }));
vi.mock("@/hooks/useClientTexting", () => ({ useClientTexting: () => availability.live }));
vi.mock("@/hooks/useMyRole", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgToday: () => "2026-10-15" }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => createElement("a", null, children),
}));
vi.mock("@/lib/client-texting.functions", () => ({ getClientTextingAvailability: vi.fn() }));
vi.mock("@/lib/clients.functions", () => ({
  updateClient: vi.fn(),
  deleteClientIfNoHistory: vi.fn(),
  listClientHolds: vi.fn(),
  previewClientPortal: vi.fn(),
}));
vi.mock("@/lib/subscriptions.functions", () => ({ pauseSubscription: vi.fn() }));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@/components/ConfirmDialog", () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), dialog: null }),
}));

import { ClientHeader } from "@/components/client-detail/ClientHeader";

function header(texting: boolean) {
  availability.live = texting;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(ClientHeader, {
          client: { display_name: "Test client", active: true },
          clientId: "client-1",
          subscriptions: [],
          propertyCount: 0,
          activeServiceCount: 0,
          outstandingCents: null,
          canBill: false,
          onEditClient: vi.fn(),
        }),
      ),
    );
  } finally {
    client.clear();
  }
}

describe("the client header only offers a working Message action", () => {
  it("hides Message while texting is off", () => {
    const html = header(false);
    expect(html).toContain("Edit Client");
    expect(html).not.toMatch(/>\s*Message\s*</);
  });

  it("restores Message automatically when texting is available", () => {
    expect(header(true)).toMatch(/>\s*Message\s*</);
  });
});

it("the shared texting hook follows the business's own number now that texting has launched, and stays off if the launch is reverted", async () => {
  const { useClientTexting } = await vi.importActual<typeof import("@/hooks/useClientTexting")>(
    "@/hooks/useClientTexting",
  );
  const { ADDON_LAUNCHED } = await import("@/lib/addon-launch");
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["client-texting"], { available: true });
  function Probe() {
    return createElement("span", null, useClientTexting() ? "live" : "coming soon");
  }
  const render = () =>
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)));
  try {
    expect(ADDON_LAUNCHED["managed-sms"]).toBe(true);
    expect(render()).toContain("live");
    client.setQueryData(["client-texting"], { available: false });
    expect(render()).toContain("coming soon");
    client.setQueryData(["client-texting"], { available: true });
    Object.defineProperty(ADDON_LAUNCHED, "managed-sms", { value: false, configurable: true });
    expect(render()).toContain("coming soon");
  } finally {
    Object.defineProperty(ADDON_LAUNCHED, "managed-sms", { value: true, configurable: true });
    client.clear();
  }
});
